#!/usr/bin/env python3
"""RealBud bounded Hermes memory-proposal helper (host-only)."""

from __future__ import annotations

import json
import hmac
import os
import re
import stat
import time
from typing import Any, Dict, List, Optional

REQ_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
MAX_INPUT = 64 * 1024
REVIEW_LOCATION = "You → Bud → Bud’s memory"
KEY_DOMAIN = b"realbud-memory-propose-key-v1\0"
JOURNAL_DOMAIN = b"realbud-memory-propose-v1\0"
CLOSED_DOMAIN = b"realbud-memory-propose-closed-v2\0"
RECOVERY_DOMAIN = b"realbud-memory-propose-recovery-v1\0"
STATES = frozenset({"prepared", "published"})
JOURNAL_KEYS = (
    "version", "state", "id", "workspaceId", "profileId", "runtimeId",
    "scopeId", "requestKey", "requestDigest", "pendingDigest", "createdAt", "mac",
)
CLOSED_KEYS = JOURNAL_KEYS + ("closedAt", "recoveryDigest")
ALLOWED_C0 = "\t\n\r"



def _err(review: Any, code: str, cause: Optional[BaseException] = None) -> Any:
    if cause is None:
        raise review.ReviewError(code)
    raise review.ReviewError(code) from cause


def _lstat_opt(review: Any, path: str) -> Optional[os.stat_result]:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise review.ReviewError("unavailable") from exc


def _check_text(review: Any, ctx: Any, text: Any) -> str:
    if not isinstance(text, str) or text.strip() == "":
        raise review.ReviewError("invalid")
    if ctx.ENTRY_DELIMITER in text:
        raise review.ReviewError("blocked-content")
    for ch in text:
        o = ord(ch)
        if (
            (o < 32 and ch not in ALLOWED_C0)
            or 127 <= o <= 159
            or o in (0x061C, 0x200E, 0x200F)
            or 0x202A <= o <= 0x202E
            or 0x2066 <= o <= 0x2069
            or 0xD800 <= o <= 0xDFFF
        ):
            raise review.ReviewError("blocked-content")
    return text


def _strict_op(review: Any, ctx: Any, op: Any) -> Dict[str, Any]:
    if not isinstance(op, dict):
        raise review.ReviewError("invalid")
    keys = set(op.keys())
    action = op.get("action")
    if action == "add":
        if keys != {"action", "content"}:
            raise review.ReviewError("unsupported" if keys - {"action", "content"} else "invalid")
        return {"action": "add", "content": _check_text(review, ctx, op["content"])}
    if action == "replace":
        need = {"action", "old_text", "content"}
        if keys != need:
            raise review.ReviewError("unsupported" if keys - need else "invalid")
        return {
            "action": "replace",
            "old_text": _check_text(review, ctx, op["old_text"]),
            "content": _check_text(review, ctx, op["content"]),
        }
    if action == "remove":
        if keys != {"action", "old_text"}:
            raise review.ReviewError("unsupported" if keys - {"action", "old_text"} else "invalid")
        return {"action": "remove", "old_text": _check_text(review, ctx, op["old_text"])}
    raise review.ReviewError("unsupported" if "action" in op else "invalid")


def _strict_payload(review: Any, ctx: Any, raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise review.ReviewError("invalid")
    keys = set(raw.keys())
    target = raw.get("target")
    action = raw.get("action")
    if target not in review.TARGETS:
        raise review.ReviewError("invalid" if "target" not in raw else "unsupported")
    if action not in review.ACTIONS:
        raise review.ReviewError("invalid" if "action" not in raw else "unsupported")
    if action == "batch":
        need = {"target", "action", "operations"}
        if keys != need:
            raise review.ReviewError("unsupported" if keys - need else "invalid")
        ops = raw["operations"]
        if not isinstance(ops, list) or not ops:
            raise review.ReviewError("invalid")
        if len(ops) > review.MAX_OPS:
            raise review.ReviewError("capacity")
        return {
            "target": target,
            "action": "batch",
            "operations": [_strict_op(review, ctx, op) for op in ops],
        }
    if action == "add":
        need = {"target", "action", "content"}
        if keys != need:
            raise review.ReviewError("unsupported" if keys - need else "invalid")
        return {"target": target, "action": "add", "content": _check_text(review, ctx, raw["content"])}
    if action == "replace":
        need = {"target", "action", "old_text", "content"}
        if keys != need:
            raise review.ReviewError("unsupported" if keys - need else "invalid")
        return {
            "target": target,
            "action": "replace",
            "old_text": _check_text(review, ctx, raw["old_text"]),
            "content": _check_text(review, ctx, raw["content"]),
        }
    need = {"target", "action", "old_text"}
    if keys != need:
        raise review.ReviewError("unsupported" if keys - need else "invalid")
    return {"target": target, "action": "remove", "old_text": _check_text(review, ctx, raw["old_text"])}


def _parse_input(review: Any, ctx: Any, scope_id: Any, inp: Any) -> Dict[str, Any]:
    if not isinstance(scope_id, str) or not review.HEX64.fullmatch(scope_id):
        raise review.ReviewError("invalid")
    if not isinstance(inp, dict) or set(inp.keys()) != {"requestId", "payload"}:
        raise review.ReviewError("invalid")
    request_id = inp["requestId"]
    if not isinstance(request_id, str) or not REQ_ID.fullmatch(request_id):
        raise review.ReviewError("invalid")
    canonical = json.dumps(inp, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    raw = canonical.encode("utf-8")
    if len(raw) > MAX_INPUT:
        raise review.ReviewError("capacity")
    strict = _strict_payload(review, ctx, inp["payload"])
    payload = review._norm_payload(ctx, strict)
    if payload["target"] != strict["target"] or payload["action"] != strict["action"]:
        raise review.ReviewError("conflict")
    return {
        "scope_id": scope_id,
        "request_id": request_id,
        "payload": payload,
        "request_digest": review._hmac_hex(ctx.key, b"realbud-memory-propose-request-v1\0" + raw),
    }


def _proposal_key(review: Any, ctx: Any, scope_id: str, request_id: str) -> str:
    msg = KEY_DOMAIN + scope_id.encode("ascii") + b"\0" + request_id.encode("ascii")
    return review._hmac_hex(ctx.key, msg)


def _proposals_dir(ctx: Any) -> str:
    return os.path.join(ctx.reviews_dir, "proposals")


def _journal_path(ctx: Any, rec_key: str) -> str:
    return os.path.join(_proposals_dir(ctx), "%s.json" % rec_key)


def _stage_path(ctx: Any, rec_key: str) -> str:
    return os.path.join(_proposals_dir(ctx), "%s.stage" % rec_key)


def _count_dir(review: Any, ctx: Any, path: str) -> int:
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        return len(windows.names(path, limit=review.MAX_DIR, missing_ok=True))
    st = _lstat_opt(review, path)
    if st is None:
        return 0
    if review._is_link(st) or not stat.S_ISDIR(st.st_mode):
        raise review.ReviewError("unsafe-storage")
    review._check_ancestors(path, ctx.profile_dir)
    n = 0
    try:
        with os.scandir(path) as it:
            for _ent in it:
                n += 1
                if n > review.MAX_DIR:
                    raise review.ReviewError("capacity")
    except review.ReviewError:
        raise
    except OSError as exc:
        raise review.ReviewError("unavailable") from exc
    return n


def _ensure_native_room(review: Any, ctx: Any, *, new_item: bool) -> None:
    remaining = [review.MAX_DIR]
    review._scan_dir(ctx.pending_dir, ctx.profile_dir, remaining)
    review._scan_dir(ctx.reviews_dir, ctx.profile_dir, remaining)
    if new_item and remaining[0] < 3:
        raise review.ReviewError("capacity")


def _journal_body(rec: Dict[str, Any]) -> Dict[str, Any]:
    keys = CLOSED_KEYS if rec.get("version") == 2 else JOURNAL_KEYS
    return {k: rec[k] for k in keys if k != "mac"}


def _recovery_digest(review: Any, ctx: Any, rec: Dict[str, Any]) -> str:
    # A closed journal retains the exact original prepared identity. The same
    # token therefore reconciles a lost close reply without reopening anything.
    original = {k: rec[k] for k in JOURNAL_KEYS if k != "mac"}
    original.update(version=1, state="prepared")
    return review._hmac_hex(ctx.key, RECOVERY_DOMAIN + review._canonical(original).encode("ascii"))


def _sign_journal(review: Any, ctx: Any, rec: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(rec)
    out["mac"] = review._hmac_hex(
        ctx.key, (CLOSED_DOMAIN if out.get("version") == 2 else JOURNAL_DOMAIN)
        + review._canonical(_journal_body(out)).encode("ascii")
    )
    return out


def _verify_journal(review: Any, ctx: Any, obj: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(obj, dict) or type(obj.get("version")) is not int or obj["version"] not in (1, 2):
        return None
    keys = CLOSED_KEYS if obj["version"] == 2 else JOURNAL_KEYS
    if tuple(sorted(obj.keys())) != tuple(sorted(keys)):
        return None
    mac = obj.get("mac")
    if not isinstance(mac, str) or not review.HEX64.fullmatch(mac.lower()):
        return None
    expected = review._hmac_hex(
        ctx.key, (CLOSED_DOMAIN if obj["version"] == 2 else JOURNAL_DOMAIN)
        + review._canonical(_journal_body(obj)).encode("ascii")
    )
    if not hmac.compare_digest(mac.lower(), expected):
        return None
    if obj.get("state") not in ({"closed"} if obj["version"] == 2 else STATES):
        return None
    if not isinstance(obj.get("id"), str) or not review.HEX8.fullmatch(obj["id"]):
        return None
    for digest_key in ("requestDigest", "pendingDigest", "scopeId"):
        val = obj.get(digest_key)
        if not isinstance(val, str) or not review.HEX64.fullmatch(val):
            return None
    if not isinstance(obj.get("requestKey"), str) or not review.HEX64.fullmatch(obj["requestKey"]) or obj["id"] != obj["requestKey"][:8]:
        return None
    if type(obj.get("createdAt")) is not int or not 0 <= obj["createdAt"] <= int(8.64e15):
        return None
    if obj.get("workspaceId") != ctx.workspace_id or obj.get("profileId") != ctx.profile_id:
        return None
    if obj.get("runtimeId") != ctx.runtime_id:
        return None
    if obj["version"] == 2:
        if type(obj.get("closedAt")) is not int or not 0 <= obj["closedAt"] <= int(8.64e15):
            return None
        if not isinstance(obj.get("recoveryDigest"), str) or not review.HEX64.fullmatch(obj["recoveryDigest"]):
            return None
        if not hmac.compare_digest(obj["recoveryDigest"], _recovery_digest(review, ctx, obj)):
            return None
    return obj


def _load_journal(review: Any, ctx: Any, path: str) -> Optional[Dict[str, Any]]:
    data = review._safe_read(ctx.profile_dir, path, missing_ok=True)
    if data is None:
        return None
    try:
        obj = review._json_loads(data.decode("utf-8"))
        verified = _verify_journal(review, ctx, obj)
    except (ValueError, TypeError, OverflowError, RecursionError):
        return {"_bad": True}
    if verified is None or os.path.basename(path) != verified["requestKey"] + ".json":
        return {"_bad": True}
    return verified


def _write_journal(review: Any, ctx: Any, path: str, rec: Dict[str, Any]) -> Dict[str, Any]:
    existing = _load_journal(review, ctx, path)
    if existing is not None and existing.get("_bad"):
        raise review.ReviewError("recovery-required")
    if existing is not None and existing["state"] == "closed":
        if _journal_body(existing) != _journal_body(rec):
            raise review.ReviewError("conflict")
        return existing
    if existing is not None and existing["state"] == "published":
        if rec["state"] != "published" or existing["pendingDigest"] != rec["pendingDigest"]:
            raise review.ReviewError("conflict")
        return existing
    if rec.get("state") == "closed" and (
        existing is None or existing["state"] != "prepared"
        or _recovery_digest(review, ctx, existing) != rec.get("recoveryDigest")
    ):
        raise review.ReviewError("stale-review")
    signed = _sign_journal(review, ctx, rec)
    data = review._canonical(signed).encode("ascii")
    if len(data) > review.MAX_BYTES:
        raise review.ReviewError("capacity")
    if _count_dir(review, ctx, _proposals_dir(ctx)) + 1 > review.MAX_DIR:
        raise review.ReviewError("capacity")
    review._atomic_write(ctx.profile_dir, path, data, 0o600)
    loaded = _load_journal(review, ctx, path)
    if loaded is None or loaded.get("_bad") or _journal_body(loaded) != _journal_body(rec):
        raise review.ReviewError("unavailable")
    return loaded


def _recovery_parents(review: Any, ctx: Any) -> List[str]:
    for path in (ctx.reviews_dir, _proposals_dir(ctx)):
        review._ensure_helper_dir(path, ctx.profile_dir)
    keys = _journal_keys(review, ctx)
    for path in (os.path.join(ctx.reviews_dir, "claims"), os.path.dirname(ctx.pending_dir), ctx.pending_dir):
        # Initialization is allowed before any durable proposal exists. After
        # that, missing ancestry is missing evidence, never an empty directory.
        review._ensure_helper_dir(path, ctx.profile_dir, create=not keys)
    return keys


def _journal_keys(review: Any, ctx: Any) -> List[str]:
    path = _proposals_dir(ctx)
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        names = windows.names(path, limit=review.MAX_DIR, missing_ok=False)
    else:
        # Parents were checked/created under review.lock. Inventory failure is
        # never an empty recovery list; unrelated stage names count too.
        review._check_ancestors(path, ctx.profile_dir)
        names = []
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    names.append(entry.name)
                    if len(names) > review.MAX_DIR:
                        raise review.ReviewError("capacity")
        except OSError:
            raise review.ReviewError("unavailable") from None
    return sorted({name[:64] for name in names
                   if len(name) == 69 and name.endswith(".json") and review.HEX64.fullmatch(name[:64])})


def _require_absent_artifacts(review: Any, ctx: Any, rec_key: str) -> None:
    pending = review._pending_path(ctx, rec_key[:8])
    # Read raw bytes rather than parsing a receipt. ANY human receipt, claim or
    # draft (including malformed/foreign data) prevents administrative closure.
    for path in (_stage_path(ctx, rec_key), pending, review._claim_path(ctx.profile_dir, pending),
                 review._receipt_path(ctx, rec_key[:8])):
        if review._safe_read(ctx.profile_dir, path, missing_ok=True) is not None:
            raise review.ReviewError("conflict")


def _require_unique_id(review: Any, keys: List[str], rec_key: str) -> None:
    if any(key != rec_key and key[:8] == rec_key[:8] for key in keys):
        raise review.ReviewError("conflict")


def interrupted_list(review: Any, ctx: Any) -> Dict[str, Any]:
    keys = _recovery_parents(review, ctx)
    rows = []
    windows = review._windows_io(ctx.profile_dir)
    for rec_key in keys:
        if ctx.cursor is not None and rec_key <= ctx.cursor:
            continue
        row = {"key": rec_key, "state": "recovery-required", "createdAt": None,
               "closedAt": None, "recoveryDigest": None}
        try:
            rec = _load_journal(review, ctx, _journal_path(ctx, rec_key))
            if rec is None or rec.get("_bad"):
                raise review.ReviewError("recovery-required")
            if rec["state"] == "published":
                continue
            row["createdAt"] = rec["createdAt"]
            _require_unique_id(review, keys, rec_key)
            _require_absent_artifacts(review, ctx, rec_key)
            row.update(state="closed" if rec["state"] == "closed" else "interrupted",
                       closedAt=rec.get("closedAt"), recoveryDigest=_recovery_digest(review, ctx, rec))
        except (review.ReviewError, OSError):
            pass
        except Exception as exc:
            if windows is None or not isinstance(exc, windows.error_type):
                raise
            # A single denied native record cannot hide other valid records.
            # No native message, pathname or contents enter the row.
        rows.append(row)
        if len(rows) > review.PAGE:
            break
    page = rows[:review.PAGE]
    return {"version": 1, "items": page,
            "nextCursor": page[-1]["key"] if len(rows) > review.PAGE else None}


def interrupted_close(review: Any, ctx: Any) -> Dict[str, Any]:
    rec_key, expected = ctx.proposal_key, ctx.expected_digest
    if not isinstance(rec_key, str) or not review.HEX64.fullmatch(rec_key) or not isinstance(expected, str) or not review.HEX64.fullmatch(expected):
        raise review.ReviewError("invalid")
    _require_unique_id(review, _recovery_parents(review, ctx), rec_key)
    path = _journal_path(ctx, rec_key)
    rec = _load_journal(review, ctx, path)
    if rec is None or rec.get("_bad"):
        raise review.ReviewError("recovery-required")
    if rec["state"] not in ("prepared", "closed"):
        raise review.ReviewError("conflict")
    if not hmac.compare_digest(_recovery_digest(review, ctx, rec), expected):
        raise review.ReviewError("stale-review")
    _require_absent_artifacts(review, ctx, rec_key)
    if rec["state"] == "prepared":
        # This metadata transition is never a human reject/approve receipt.
        rec = _write_journal(review, ctx, path, {
            **rec, "version": 2, "state": "closed", "closedAt": int(time.time() * 1000),
            "recoveryDigest": expected,
        })
    # Reconcile after the write or a lost response; newly appearing conflicting
    # artifacts cannot be reported as a completed closure.
    review._fsync_path(path, ctx.profile_dir)
    review._fsync_dir(_proposals_dir(ctx), ctx.profile_dir)
    saved = _load_journal(review, ctx, path)
    if saved is None or saved.get("_bad") or _journal_body(saved) != _journal_body(rec):
        raise review.ReviewError("recovery-required")
    _require_unique_id(review, _journal_keys(review, ctx), rec_key)
    _require_absent_artifacts(review, ctx, rec_key)
    return {"version": 1, "key": rec_key, "state": "closed", "closedAt": saved["closedAt"],
            "recoveryDigest": expected}


def _pending_bytes(item_id: str, created_at: int, payload: Dict[str, Any]) -> bytes:
    obj = {
        "id": item_id,
        "subsystem": "memory",
        "action": payload["action"],
        "summary": REVIEW_LOCATION,
        "origin": "foreground",
        "created_at": created_at,
        "payload": payload,
    }
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _read_pair(review: Any, profile: str, stage: str, pending: str) -> bytes:
    """Admit only these two known paths, same inode, nlink==2. Does not change _safe_read."""
    if not review._under(stage, profile) or not review._under(pending, profile):
        raise review.ReviewError("unsafe-storage")
    review._check_ancestors(os.path.dirname(stage), profile)
    review._check_ancestors(os.path.dirname(pending), profile)
    st_s = review._lstat(stage)
    st_p = review._lstat(pending)

    def _ok(st: os.stat_result) -> None:
        if review._is_link(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 2:
            raise review.ReviewError("unsafe-storage")
        if review.POSIX and (st.st_uid != os.geteuid() or (st.st_mode & 0o077)):
            raise review.ReviewError("unsafe-storage")

    _ok(st_s)
    _ok(st_p)
    if not review._same_inode(st_s, st_p):
        raise review.ReviewError("conflict")
    fd_s = review._open_nofollow(stage, os.O_RDONLY)
    try:
        fd_p = review._open_nofollow(pending, os.O_RDONLY)
        try:
            fs = os.fstat(fd_s)
            fp = os.fstat(fd_p)
            if (
                not review._same_inode(st_s, fs)
                or not review._same_inode(fs, fp)
                or fs.st_nlink != 2
                or fp.st_nlink != 2
                or not stat.S_ISREG(fs.st_mode)
            ):
                raise review.ReviewError("unsafe-storage")
            data = review._read_fd(fd_s, review.MAX_BYTES)
            after_s = os.fstat(fd_s)
            after_p = os.fstat(fd_p)
            cur_s = os.lstat(stage)
            cur_p = os.lstat(pending)

            def sig(s: os.stat_result) -> tuple:
                return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink)

            if (
                sig(st_s) != sig(fs)
                or sig(fs) != sig(after_s)
                or sig(after_s) != sig(cur_s)
                or sig(st_p) != sig(fp)
                or sig(fp) != sig(after_p)
                or sig(after_p) != sig(cur_p)
                or not review._same_inode(cur_s, cur_p)
                or cur_s.st_nlink != 2
                or len(data) != st_s.st_size
            ):
                raise review.ReviewError("conflict")
            return data
        finally:
            os.close(fd_p)
    finally:
        os.close(fd_s)


def _fsync_both(review: Any, ctx: Any, stage: str, pending: str) -> None:
    review._fsync_dir(os.path.dirname(stage), ctx.profile_dir)
    review._fsync_dir(os.path.dirname(pending), ctx.profile_dir)


def _require_stage_file(review: Any, ctx: Any, stage: str, digest: str) -> None:
    if review._windows_io(ctx.profile_dir) is not None:
        data = review._safe_read(ctx.profile_dir, stage, missing_ok=True)
        if data is None or review._sha(data) != digest:
            raise review.ReviewError("recovery-required")
        return
    st = review._lstat(stage)
    if review._is_link(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise review.ReviewError("unsafe-storage")
    data = review._safe_read(ctx.profile_dir, stage)
    if data is None or review._sha(data) != digest:
        raise review.ReviewError("recovery-required")


def _link_stage(review: Any, ctx: Any, stage: str, pending: str, digest: str) -> None:
    _require_stage_file(review, ctx, stage, digest)
    if _lstat_opt(review, pending) is not None:
        raise review.ReviewError("conflict")
    try:
        os.link(stage, pending)
    except FileExistsError:
        raise review.ReviewError("conflict") from None
    except OSError as exc:
        raise review.ReviewError("unavailable") from exc
    _fsync_both(review, ctx, stage, pending)
    data = _read_pair(review, ctx.profile_dir, stage, pending)
    if review._sha(data) != digest:
        raise review.ReviewError("conflict")


def _unlink_stage(review: Any, ctx: Any, stage: str, pending: str, digest: str) -> None:
    data = _read_pair(review, ctx.profile_dir, stage, pending)
    if review._sha(data) != digest:
        raise review.ReviewError("conflict")
    try:
        os.unlink(stage)
    except OSError as exc:
        raise review.ReviewError("unavailable") from exc
    _fsync_both(review, ctx, stage, pending)
    if _lstat_opt(review, stage) is not None:
        raise review.ReviewError("recovery-required")
    live = review._safe_read(ctx.profile_dir, pending)
    if live is None or review._sha(live) != digest:
        raise review.ReviewError("recovery-required")


def _commit_published(
    review: Any, ctx: Any, parsed: Dict[str, Any], rec_key: str, item_id: str, digest: str
) -> Dict[str, Any]:
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None and review._path_exists(ctx.profile_dir, _stage_path(ctx, rec_key)):
        raise review.ReviewError("conflict")
    pending = review._pending_path(ctx, item_id)
    live = review._safe_read(ctx.profile_dir, pending)
    if live is None or review._sha(live) != digest:
        raise review.ReviewError("recovery-required")
    # Recovery can arrive after link/unlink but before either directory fsync.
    review._fsync_path(pending, ctx.profile_dir)
    review._fsync_dir(os.path.dirname(pending), ctx.profile_dir)
    rec = _load_journal(review, ctx, _journal_path(ctx, rec_key))
    if rec is None or rec.get("_bad") or rec["id"] != item_id or rec["pendingDigest"] != digest or rec["requestDigest"] != parsed["request_digest"]:
        raise review.ReviewError("recovery-required")
    rec = {**rec, "state": "published"}
    written = _write_journal(review, ctx, _journal_path(ctx, rec_key), rec)
    again = _load_journal(review, ctx, _journal_path(ctx, rec_key))
    final_live = review._safe_read(ctx.profile_dir, pending)
    if (
        again is None
        or again.get("_bad")
        or again["state"] != "published"
        or final_live is None
        or review._sha(final_live) != digest
        or written["id"] != item_id
        or (windows is not None and review._path_exists(ctx.profile_dir, _stage_path(ctx, rec_key)))
    ):
        raise review.ReviewError("recovery-required")
    return _ok(item_id)


def _ok(item_id: str) -> Dict[str, Any]:
    return {"version": 1, "id": item_id, "reviewLocation": REVIEW_LOCATION}


def _write_stage(review: Any, ctx: Any, stage: str, blob: bytes, digest: str) -> None:
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        if len(blob) > review.MAX_BYTES:
            raise review.ReviewError("capacity")
        if _count_dir(review, ctx, _proposals_dir(ctx)) + 1 > review.MAX_DIR:
            raise review.ReviewError("capacity")
        # A journal-owned stage is created exclusively. It is never repaired
        # by replacing a colliding file, even when publication was interrupted.
        windows.write_new(stage, blob)
        data = windows.read(stage, limit=review.MAX_BYTES, missing_ok=True)
        if data is None or review._sha(data) != digest:
            raise review.ReviewError("recovery-required")
        return
    existing = _lstat_opt(review, stage)
    if existing is not None:
        if existing.st_nlink != 1:
            raise review.ReviewError("recovery-required")
        data = review._safe_read(ctx.profile_dir, stage, missing_ok=True)
        if data is None or review._sha(data) != digest:
            raise review.ReviewError("recovery-required")
        return
    if len(blob) > review.MAX_BYTES:
        raise review.ReviewError("capacity")
    if _count_dir(review, ctx, _proposals_dir(ctx)) + 1 > review.MAX_DIR:
        raise review.ReviewError("capacity")
    review._atomic_write(ctx.profile_dir, stage, blob, 0o600)
    data = review._safe_read(ctx.profile_dir, stage)
    if data is None or review._sha(data) != digest:
        raise review.ReviewError("unavailable")


def _publish_new(review: Any, ctx: Any, parsed: Dict[str, Any], rec_key: str, item_id: str, blob: bytes) -> Dict[str, Any]:
    digest = review._sha(blob)
    stage = _stage_path(ctx, rec_key)
    pending = review._pending_path(ctx, item_id)
    _write_stage(review, ctx, stage, blob, digest)
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        windows.move_new(stage, pending, digest)
    else:
        _link_stage(review, ctx, stage, pending, digest)
        _unlink_stage(review, ctx, stage, pending, digest)
    return _commit_published(review, ctx, parsed, rec_key, item_id, digest)


def _recover_prepared(
    review: Any,
    ctx: Any,
    journal: Dict[str, Any],
    parsed: Dict[str, Any],
    rec_key: str,
    item_id: str,
    blob: bytes,
) -> Dict[str, Any]:
    digest = journal["pendingDigest"]
    if review._sha(blob) != digest:
        raise review.ReviewError("conflict")
    if journal["id"] != item_id or journal["scopeId"] != parsed["scope_id"]:
        raise review.ReviewError("recovery-required")
    if journal["requestKey"] != rec_key or journal["requestDigest"] != parsed["request_digest"]:
        raise review.ReviewError("conflict")
    stage = _stage_path(ctx, rec_key)
    pending = review._pending_path(ctx, item_id)
    windows = review._windows_io(ctx.profile_dir)
    if windows is not None:
        has_stage = review._path_exists(ctx.profile_dir, stage)
        has_pending = review._path_exists(ctx.profile_dir, pending)
        # Windows publication moves one object; two names are never its valid
        # interrupted state. Do not adopt the POSIX two-hardlink recovery path.
        if has_stage and has_pending:
            raise review.ReviewError("conflict")
        if not has_stage and not has_pending:
            raise review.ReviewError("recovery-required")
        if has_stage:
            _require_stage_file(review, ctx, stage, digest)
            _dry_run(review, ctx, parsed["payload"])
            _ensure_native_room(review, ctx, new_item=True)
            windows.move_new(stage, pending, digest)
        else:
            live = windows.read(pending, limit=review.MAX_BYTES, missing_ok=True)
            if live is None or review._sha(live) != digest:
                raise review.ReviewError("recovery-required")
        return _commit_published(review, ctx, parsed, rec_key, item_id, digest)
    s_st = _lstat_opt(review, stage)
    p_st = _lstat_opt(review, pending)
    if p_st is None:
        # Retrying a prepared intent must not publish under newly disabled or
        # incompatible native memory state. Already visible pending work is
        # reviewed afresh by the existing preview/decision path.
        _dry_run(review, ctx, parsed["payload"])
        _ensure_native_room(review, ctx, new_item=True)
    if s_st is not None and p_st is not None:
        data = _read_pair(review, ctx.profile_dir, stage, pending)
        if review._sha(data) != digest:
            raise review.ReviewError("conflict")
        _unlink_stage(review, ctx, stage, pending, digest)
        return _commit_published(review, ctx, parsed, rec_key, item_id, digest)
    if s_st is not None and p_st is None:
        _write_stage(review, ctx, stage, blob, digest)
        _link_stage(review, ctx, stage, pending, digest)
        _unlink_stage(review, ctx, stage, pending, digest)
        return _commit_published(review, ctx, parsed, rec_key, item_id, digest)
    if s_st is None and p_st is not None:
        live = review._safe_read(ctx.profile_dir, pending, missing_ok=True)
        if live is None or review._sha(live) != digest:
            raise review.ReviewError("recovery-required")
        return _commit_published(review, ctx, parsed, rec_key, item_id, digest)
    _write_stage(review, ctx, stage, blob, digest)
    _link_stage(review, ctx, stage, pending, digest)
    _unlink_stage(review, ctx, stage, pending, digest)
    return _commit_published(review, ctx, parsed, rec_key, item_id, digest)


def _success_existing(
    review: Any, ctx: Any, journal: Dict[str, Any], item_id: str, request_digest: str
) -> Dict[str, Any]:
    if journal.get("_bad"):
        raise review.ReviewError("recovery-required")
    if journal["requestDigest"] != request_digest:
        raise review.ReviewError("conflict")
    if journal["id"] != item_id:
        raise review.ReviewError("recovery-required")
    if review._windows_io(ctx.profile_dir) is not None and review._path_exists(
        ctx.profile_dir, _stage_path(ctx, journal["requestKey"])
    ):
        raise review.ReviewError("conflict")
    receipt = review._read_receipt(ctx, item_id)
    pending_path = review._pending_path(ctx, item_id)
    if receipt is not None and receipt.get("_bad"):
        raise review.ReviewError("recovery-required")
    if receipt is not None and receipt.get("phase") == "final":
        if receipt.get("id") != item_id or receipt.get("pendingDigest") != journal["pendingDigest"]:
            raise review.ReviewError("recovery-required")
        live = review._safe_read(ctx.profile_dir, pending_path, missing_ok=True)
        if live is not None and review._sha(live) != journal["pendingDigest"]:
            raise review.ReviewError("conflict")
        return _ok(item_id)
    if journal["state"] == "published":
        live = review._safe_read(ctx.profile_dir, pending_path, missing_ok=True)
        if live is None:
            raise review.ReviewError("recovery-required")
        if review._sha(live) != journal["pendingDigest"]:
            raise review.ReviewError("conflict")
        return _ok(item_id)
    raise review.ReviewError("recovery-required")


def _dry_run(review: Any, ctx: Any, payload: Dict[str, Any]) -> None:
    target = payload["target"]
    with review._target_lock(ctx, target, required=False):
        review._refresh_config(ctx)
        review._require_ready(ctx, target)
        before = review._read_memory(ctx, target)
        review._apply_dry(ctx, payload, before)


def propose(review: Any, ctx: Any, scope_id: Any, input: Any) -> Dict[str, Any]:
    windows = review._windows_io(ctx.profile_dir)
    if windows is None and (not review.POSIX or os.name != "posix"):
        raise review.ReviewError("unavailable")
    parsed = _parse_input(review, ctx, scope_id, input)
    rec_key = _proposal_key(review, ctx, parsed["scope_id"], parsed["request_id"])
    item_id = rec_key[:8]
    profile = ctx.profile_dir
    _recovery_parents(review, ctx)
    jpath = _journal_path(ctx, rec_key)
    pending = review._pending_path(ctx, item_id)
    claim = review._claim_path(profile, pending)
    journal = _load_journal(review, ctx, jpath)
    if journal is not None and journal.get("_bad"):
        raise review.ReviewError("recovery-required")
    if journal is not None:
        if journal["requestDigest"] != parsed["request_digest"] or journal["scopeId"] != scope_id or journal["requestKey"] != rec_key:
            raise review.ReviewError("conflict")
        if journal["state"] == "closed":
            raise review.ReviewError("proposal-closed")
    claim_exists = review._path_exists(profile, claim) if windows is not None else os.path.lexists(claim)
    if claim_exists:
        if journal is not None and journal["requestDigest"] == parsed["request_digest"]:
            raise review.ReviewError("recovery-required")
        raise review.ReviewError("recovery-required")
    if journal is not None:
        receipt = review._read_receipt(ctx, item_id)
        if receipt is not None:
            if receipt.get("_bad") or receipt.get("pendingDigest") != journal["pendingDigest"]:
                raise review.ReviewError("recovery-required")
            # A person can review the visible proposal after the helper exits
            # between publication and its final journal. Never recreate it.
            stage = _stage_path(ctx, rec_key)
            stage_exists = review._path_exists(profile, stage) if windows is not None else os.path.lexists(stage)
            if stage_exists:
                raise review.ReviewError("recovery-required")
            live = review._safe_read(ctx.profile_dir, pending, missing_ok=True)
            if live is not None and review._sha(live) != journal["pendingDigest"]:
                raise review.ReviewError("conflict")
            if journal["state"] == "prepared":
                review._fsync_path(review._receipt_path(ctx, item_id), profile)
                review._fsync_dir(ctx.reviews_dir, profile)
                _write_journal(review, ctx, jpath, {**journal, "state": "published"})
            return _ok(item_id)
        if journal["state"] == "published":
            return _success_existing(review, ctx, journal, item_id, parsed["request_digest"])
        created_at = journal["createdAt"] // 1000
        blob = _pending_bytes(item_id, created_at, parsed["payload"])
        return _recover_prepared(review, ctx, journal, parsed, rec_key, item_id, blob)
    receipt = review._read_receipt(ctx, item_id)
    if receipt is not None:
        raise review.ReviewError("recovery-required")
    pending_exists = review._path_exists(profile, pending) if windows is not None else _lstat_opt(review, pending) is not None
    if pending_exists:
        raise review.ReviewError("conflict")
    if windows is not None and review._path_exists(profile, _stage_path(ctx, rec_key)):
        # Without the signed journal, an orphan stage is not retry authority.
        raise review.ReviewError("recovery-required")
    nprop = _count_dir(review, ctx, _proposals_dir(ctx))
    if nprop + 2 > review.MAX_DIR:
        raise review.ReviewError("capacity")
    _ensure_native_room(review, ctx, new_item=True)
    _dry_run(review, ctx, parsed["payload"])
    created_at = int(time.time())
    blob = _pending_bytes(item_id, created_at, parsed["payload"])
    if len(blob) > review.MAX_BYTES:
        raise review.ReviewError("capacity")
    digest = review._sha(blob)
    rec = {
        "version": 1,
        "state": "prepared",
        "id": item_id,
        "workspaceId": ctx.workspace_id,
        "profileId": ctx.profile_id,
        "runtimeId": ctx.runtime_id,
        "scopeId": parsed["scope_id"],
        "requestKey": rec_key,
        "requestDigest": parsed["request_digest"],
        "pendingDigest": digest,
        "createdAt": created_at * 1000,
    }
    _write_journal(review, ctx, jpath, rec)
    return _publish_new(review, ctx, parsed, rec_key, item_id, blob)
