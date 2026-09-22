Bounded independent final review of corrected memory decision CAS/recovery code. No tools, no edits, no private files. Return JSON {verdict:"approved"|"changes-required",findings:[{severity:"high"|"medium",detail:string,fix:string}],limits:[string]}. Report only concrete defects. Do not reopen verified fixes speculatively. Scope: supplied functions, not whole product. Original generated proposal was corrected for native pending schema, HMAC review token, signed receipt id/file binding, Path native lock, locked-target revalidation, refreshed config, cleanup claim-by-rename and before-final fsync. Thirteen subprocess fault tests against actual native store now pass: crash before/after memory fsync, final receipt before cleanup, after claim rename, approval/rejection recovery, exactly one native memory write, current/config/runtime conflicts, cleanup replacement preservation, copied receipt ID, publichash forgery. Additional23 native/API tests and actual bootstrap UI checks run. Windows new inbox is explicitly unavailable pending native per-file ACL/durable rename admission; do not claim Windows is secure or unsupported whole app. Same-OS-user/admin actively tampering helper-owned private paths is outside the filesystem isolation guarantee. Native stage_write can concurrently replace a pending pathname and ignores helper review lock; MemoryStore mutations cooperate on target .lock. Config/pending/current are rechecked immediately before memorywrite; config edits are not OS multi-file transactions. The helper process is host-only with HMAC key via stdin; HTTP cannot select paths/key/profile/runtime. Receipt MAC uses domain separation and exact schema. Missing included utility definitions are reviewed context, not proof of bugs. Identify if real remaining approval widening, duplicate effects, lost data, wrong lock, or false terminal receipt exists. Do not output thought/reasoning; concise findings only.

#!/usr/bin/env python3
"""RealBud bounded Hermes memory-review helper (host-only stdin JSON)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import stat
import sys
import time
import uuid
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

MAX_BYTES = 128 * 1024
MAX_STDIN = 128 * 1024
MAX_OPS = 100
MAX_DIR = 2000
PAGE = 20
CHAR_MIN, CHAR_MAX = 1, 100000
DEFAULT_MEMORY_LIMIT = 2200
DEFAULT_USER_LIMIT = 1375
HEX8 = re.compile(r"^[0-9a-f]{8}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
PROFILE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
RUNTIME_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
PENDING_TOP = frozenset({"id", "subsystem", "action", "summary", "origin", "created_at", "payload"})
PAYLOAD_KEYS = frozenset({"action", "target", "content", "old_text", "new_text", "operations"})
OP_KEYS = frozenset({"action", "content", "old_text", "new_text"})
ACTIONS = frozenset({"add", "replace", "remove", "batch"})
TARGETS = frozenset({"memory", "user"})
ORIGINS = frozenset({"foreground", "background_review"})
KINDS = frozenset({"memory", "MEMORY"})
STATUSES = frozenset({"pending", "staged"})
REQ_KEYS = frozenset({
    "version", "command", "profileDirectory", "runtimeDirectory", "workspaceId",
    "profileId", "runtimeId", "key", "id", "expectedDigest", "decision", "cursor",
})
REQ_REQUIRED = (
    "version", "command", "profileDirectory", "runtimeDirectory",
    "workspaceId", "profileId", "runtimeId", "key",
)
RECEIPT_KEYS = (
    "version", "id", "workspaceId", "profileId", "runtimeId", "decision", "state",
    "phase", "pendingDigest", "configDigest", "beforeDigest", "afterDigest",
    "reviewDigest", "target", "action", "origin", "createdAt", "at",
    "operationCount", "charLimit", "mac",
)
BUILTIN_PROVIDERS = frozenset({"", "builtin"})
PROVIDER_KEYS = ("provider", "memory_provider", "backend")
ABSENT = object()
POSIX = os.name == "posix"
FILE_ATTRIBUTE_REPARSE_POINT = 0x400


class ReviewError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class Ctx:
    __slots__ = (
        "command", "profile_dir", "runtime_dir", "workspace_id", "profile_id",
        "runtime_id", "key", "req_id", "expected_digest", "decision", "cursor",
        "reviews_dir", "pending_dir", "config_path", "config_digest", "config",
        "write_approval", "memory_enabled", "user_profile_enabled",
        "memory_char_limit", "user_char_limit", "MemoryStore", "apply_memory_pending",
        "ENTRY_DELIMITER", "scan_content", "is_truthy", "DryRun",
    )


def _emit(obj: Dict[str, Any]) -> None:
    try:

def _safe_read(profile: str, path: str, limit: int = MAX_BYTES, *, missing_ok: bool = False) -> Optional[bytes]:
    if not _under(path, profile):
        raise ReviewError("unsafe-storage")
    # Check the nearest existing parent even for an absent file. Never follow
    # a dangling ancestor link as if it meant an empty native store.
    parent = os.path.dirname(path)
    while not os.path.lexists(parent):
        later = os.path.dirname(parent)
        if later == parent:
            raise ReviewError("unsafe-storage")
        parent = later
    _check_ancestors(parent, profile)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise ReviewError("unavailable") from None
    if _is_link(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ReviewError("unsafe-storage")
    if POSIX and (st.st_uid != os.geteuid() or (st.st_mode & 0o077)):
        raise ReviewError("unsafe-storage")
    fd = _open_nofollow(path, os.O_RDONLY)
    try:
        opened = os.fstat(fd)
        if not _same_inode(st, opened) or opened.st_nlink != 1 or not stat.S_ISREG(opened.st_mode):
            raise ReviewError("unsafe-storage")
        data = _read_fd(fd, limit)
        after = os.fstat(fd)
        current = os.lstat(path)
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink)
        if signature(st) != signature(opened) or signature(opened) != signature(after) or signature(after) != signature(current) or len(data) != st.st_size:
            raise ReviewError("conflict")
        return data
    finally:
        os.close(fd)

def _claim_path(profile: str, path: str) -> str:
    return os.path.join(profile, ".realbud-memory-reviews", "claims", os.path.basename(path))

def _unlink_if_digest(profile: str, path: str, digest: str, *, missing_ok: bool) -> None:
    # Native stage_write does not share the review lock. Move one directory
    # entry into our owned area before checking/deleting it; never unlink a
    # native pathname based on an earlier read of possibly different bytes.
    claims = os.path.join(profile, ".realbud-memory-reviews", "claims")
    _ensure_helper_dir(claims, profile)
    claim = _claim_path(profile, path)
    claimed = _safe_read(profile, claim, missing_ok=True)
    if claimed is None:
        live = _safe_read(profile, path, missing_ok=True)
        if live is None:
            if missing_ok:
                return
            raise ReviewError("recovery-required")
        if _sha(live) != digest:
            raise ReviewError("conflict")
        try:
            os.rename(path, claim)
        except FileNotFoundError:
            raise ReviewError("recovery-required") from None
        _fsync_dir(os.path.dirname(path), profile)
        _fsync_dir(claims, profile)
        claimed = _safe_read(profile, claim)
    if claimed is None or _sha(claimed) != digest:
        # A concurrent replacement remains in claims for service recovery.
        # It is never silently deleted or written over another native proposal.
        raise ReviewError("conflict")
    os.unlink(claim)
    _fsync_dir(claims, profile)
    if _safe_read(profile, path, missing_ok=True) is not None:
        raise ReviewError("conflict")

def _read_memory(ctx: Ctx, target: str) -> str:
    path = _memory_path(ctx, target)
    data = _safe_read(ctx.profile_dir, path, missing_ok=True)
    if data is None:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReviewError("unavailable") from exc

def _review_digest(ctx: Ctx, rec: Dict[str, Any], before: str, after: str) -> str:
    payload = {
        "action": rec["action"],
        "afterDigest": _sha_text(after),
        "beforeDigest": _sha_text(before),
        "charLimit": _target_limit(ctx, rec["target"]),
        "configDigest": ctx.config_digest,
        "createdAt": rec["createdAt"],
        "id": rec["id"],
        "operationCount": rec["operationCount"],
        "origin": rec["origin"],
        "pendingDigest": rec["pendingDigest"],
        "profileId": ctx.profile_id,
        "runtimeId": ctx.runtime_id,
        "target": rec["target"],
        "version": 1,
        "workspaceId": ctx.workspace_id,
    }
    return _hmac_hex(ctx.key, b"realbud-memory-preview-v1\0" + _canonical(payload).encode("ascii"))

def _verify_receipt(ctx: Ctx, obj: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(obj, dict) or tuple(sorted(obj.keys())) != tuple(sorted(RECEIPT_KEYS)):
        return None
    if type(obj.get("version")) is not int or obj["version"] != 1:
        return None
    mac = obj.get("mac")
    if not isinstance(mac, str) or not HEX64.match(mac.lower()):
        return None
    expected = _hmac_hex(ctx.key, b"realbud-memory-receipt-v1\0" + _canonical(_receipt_body(obj)).encode("ascii"))
    if not hmac.compare_digest(mac.lower(), expected):
        return None
    for digest_key in ("pendingDigest", "configDigest", "beforeDigest", "afterDigest", "reviewDigest"):
        val = obj.get(digest_key)
        if not isinstance(val, str) or not HEX64.match(val):
            return None
    if obj.get("decision") not in ("approve", "reject"):
        return None
    if obj.get("state") not in ("applied", "rejected"):
        return None
    if obj.get("phase") not in ("intent", "final"):
        return None
    if obj.get("target") not in TARGETS or obj.get("action") not in ACTIONS or obj.get("origin") not in ORIGINS:
        return None
    if not isinstance(obj.get("id"), str) or not HEX8.fullmatch(obj["id"]):
        return None
    if obj["state"] != ("applied" if obj["decision"] == "approve" else "rejected") or obj["phase"] == "intent" and obj["decision"] != "approve":
        return None
    if not isinstance(obj.get("createdAt"), (int, float)) or isinstance(obj.get("createdAt"), bool):
        return None
    if not isinstance(obj.get("at"), (int, float)) or isinstance(obj.get("at"), bool):
        return None
    if not isinstance(obj.get("operationCount"), int) or isinstance(obj.get("operationCount"), bool):
        return None
    if not isinstance(obj.get("charLimit"), int) or isinstance(obj.get("charLimit"), bool):
        return None
    if not 1 <= obj["operationCount"] <= MAX_OPS or not CHAR_MIN <= obj["charLimit"] <= CHAR_MAX:
        return None
    if not 0 <= obj["createdAt"] <= 8.64e15 or not 0 <= obj["at"] <= 8.64e15:
        return None
    if obj.get("workspaceId") != ctx.workspace_id or obj.get("profileId") != ctx.profile_id:
        return None
    if obj.get("runtimeId") != ctx.runtime_id:
        return None
    return obj

def _read_receipt(ctx: Ctx, item_id: str) -> Optional[Dict[str, Any]]:
    path = _receipt_path(ctx, item_id)
    data = _safe_read(ctx.profile_dir, path, missing_ok=True)
    if data is None:
        return None
    try:
        obj = _json_loads(data.decode("utf-8"))
    except Exception:
        return {"_bad": True}
    verified = _verify_receipt(ctx, obj)
    if verified is None or verified["id"] != item_id:
        return {"_bad": True}
    return verified

def _review_lock(ctx: Ctx) -> Iterator[None]:
    _ensure_helper_dir(ctx.reviews_dir, ctx.profile_dir)
    lock_target = os.path.join(ctx.reviews_dir, "review")
    _safe_read(ctx.profile_dir, lock_target + ".lock", missing_ok=True)
    with ctx.MemoryStore._file_lock(Path(lock_target)):
        _safe_read(ctx.profile_dir, lock_target + ".lock")
        yield

def _target_lock(ctx: Ctx, target: str, *, required: bool) -> Iterator[None]:
    path = ctx.MemoryStore._path_for(target)
    if not os.path.lexists(path.parent):
        _ensure_helper_dir(str(path.parent), ctx.profile_dir)
    _check_ancestors(str(path.parent), ctx.profile_dir)
    lock = str(path.with_suffix(path.suffix + ".lock"))
    _safe_read(ctx.profile_dir, lock, missing_ok=True)
    with ctx.MemoryStore._file_lock(path):
        _safe_read(ctx.profile_dir, lock)
        yield

def _classify(ctx: Ctx, item_id: str) -> Dict[str, Any]:
    receipt = _read_receipt(ctx, item_id)
    claim_present = os.path.lexists(_claim_path(ctx.profile_dir, _pending_path(ctx, item_id)))
    pending_bytes = _safe_read(ctx.profile_dir, _pending_path(ctx, item_id), missing_ok=True)
    pending = None
    pending_err = None
    if pending_bytes is not None:
        try:
            pending = _parse_pending(ctx, pending_bytes, item_id)
        except ReviewError as exc:
            if exc.code in ("unsafe-storage", "capacity"):
                raise
            pending_err = exc.code
    if receipt is not None and receipt.get("_bad"):
        item = _item_shell(item_id, "recovery-required")
        return item
    if receipt is not None and receipt.get("phase") == "intent":
        item = _item_shell(item_id, "recovery-required")
        item.update({
            "action": receipt.get("action"),
            "target": receipt.get("target"),
            "origin": receipt.get("origin"),
            "createdAt": receipt.get("createdAt"),
            "decision": receipt["decision"], "reviewDigest": receipt["reviewDigest"],
        })
        return item
    if receipt is not None and receipt.get("phase") == "final":
        if pending is not None and pending["pendingDigest"] != receipt["pendingDigest"]:
            return _item_shell(item_id, "recovery-required")
        if pending_err is not None and pending_bytes is not None:
            return _item_shell(item_id, "recovery-required")
        item = _item_shell(item_id, "recovery-required" if pending_bytes is not None or claim_present else receipt["state"])
        item.update({
            "action": receipt.get("action"),
            "target": receipt.get("target"),
            "origin": receipt.get("origin"),
            "createdAt": receipt.get("createdAt"),
            "decision": receipt["decision"], "reviewDigest": receipt["reviewDigest"],
        })
        return item
    if pending is not None:
        return {
            "id": item_id,
            "state": "pending",
            "action": pending["action"],
            "target": pending["target"],
            "origin": pending["origin"],
            "createdAt": pending["createdAt"],
            "decision": None, "reviewDigest": None,
        }
    return _item_shell(item_id, "unavailable")

def _preview_state(ctx: Ctx, rec: Dict[str, Any], before: str) -> Dict[str, Any]:
    _require_ready(ctx, rec["target"])
    _store, after, _changed = _apply_dry(ctx, rec["payload"], before)
    digest = _review_digest(ctx, rec, before, after)
    return {
        "version": 1,
        "id": rec["id"],
        "target": rec["target"],
        "action": rec["action"],
        "origin": rec["origin"],
        "createdAt": rec["createdAt"],
        "reviewDigest": digest,
        "before": before,
        "after": after,
        "operationCount": rec["operationCount"],
        "charLimit": _target_limit(ctx, rec["target"]),
        "beforeDigest": _sha_text(before),
        "afterDigest": _sha_text(after),
    }

def _cmd_preview(ctx: Ctx) -> Dict[str, Any]:
    item_id = ctx.req_id or ""
    if _read_receipt(ctx, item_id) is not None:
        raise ReviewError("recovery-required")
    rec = _load_pending(ctx, item_id, missing_ok=False)
    if rec is None:
        raise ReviewError("unavailable")
    target = rec["target"]
    with _target_lock(ctx, target, required=False):
        _refresh_config(ctx)
        rec = _load_pending(ctx, item_id, missing_ok=False)
        if rec is None:
            raise ReviewError("unavailable")
        if rec["target"] != target:
            raise ReviewError("conflict")
        before = _read_memory(ctx, rec["target"])
        preview = _preview_state(ctx, rec, before)
    preview.pop("beforeDigest", None)
    preview.pop("afterDigest", None)
    return preview

def _build_receipt(ctx: Ctx, rec: Dict[str, Any], preview: Dict[str, Any], *, decision: str, phase: str, state: str) -> Dict[str, Any]:
    return {
        "version": 1,
        "id": rec["id"],
        "workspaceId": ctx.workspace_id,
        "profileId": ctx.profile_id,
        "runtimeId": ctx.runtime_id,
        "decision": decision,
        "state": state,
        "phase": phase,
        "pendingDigest": rec["pendingDigest"],
        "configDigest": ctx.config_digest,
        "beforeDigest": preview["beforeDigest"],
        "afterDigest": preview["afterDigest"],
        "reviewDigest": preview["reviewDigest"],
        "target": rec["target"],
        "action": rec["action"],
        "origin": rec["origin"],
        "createdAt": rec["createdAt"],
        "at": int(time.time() * 1000),
        "operationCount": rec["operationCount"],
        "charLimit": preview["charLimit"],
    }

def _write_memory(ctx: Ctx, target: str, entries: List[str], after: str) -> None:
    path = _memory_path(ctx, target)
    parent = os.path.dirname(path)
    try:
        os.mkdir(parent, 0o755)
    except FileExistsError:
        pass
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    _check_ancestors(parent, ctx.profile_dir)
    ctx.MemoryStore._write_file(Path(path), entries)
    _fsync_path(path, ctx.profile_dir)
    _fsync_dir(parent, ctx.profile_dir)
    current = _read_memory(ctx, target)
    if _sha_text(current) != _sha_text(after):
        raise ReviewError("recovery-required")

def _finalize_applied(ctx: Ctx, rec: Dict[str, Any], preview: Dict[str, Any], *, missing_pending_ok: bool) -> Dict[str, Any]:
    receipt = _write_receipt(ctx, _build_receipt(ctx, rec, preview, decision="approve", phase="final", state="applied"))
    _finish_remove_pending(ctx, rec, missing_ok=missing_pending_ok)
    return _decide_result(receipt)

def _recover_intent(ctx: Ctx, rec: Dict[str, Any], receipt: Dict[str, Any], before: str) -> Dict[str, Any]:
    if ctx.decision != receipt["decision"]:
        raise ReviewError("conflict")
    if ctx.expected_digest != receipt["reviewDigest"]:
        raise ReviewError("stale-review")
    if receipt["runtimeId"] != ctx.runtime_id or receipt["configDigest"] != ctx.config_digest:
        raise ReviewError("recovery-required")
    current_digest = _sha_text(before)
    pending_bytes = _safe_read(ctx.profile_dir, _pending_path(ctx, rec["id"]), missing_ok=True)
    if pending_bytes is not None and _sha(pending_bytes) != receipt["pendingDigest"]:
        raise ReviewError("conflict")
    preview_now = {
        "reviewDigest": receipt["reviewDigest"],
        "beforeDigest": receipt["beforeDigest"],
        "afterDigest": receipt["afterDigest"],
        "charLimit": receipt["charLimit"],
    }
    rec = dict(rec)
    rec["pendingDigest"] = receipt["pendingDigest"]
    rec["action"] = receipt["action"]
    rec["target"] = receipt["target"]
    rec["origin"] = receipt["origin"]
    rec["createdAt"] = receipt["createdAt"]
    rec["operationCount"] = receipt["operationCount"]
    if current_digest == receipt["afterDigest"]:
        if receipt["decision"] != "approve":
            raise ReviewError("conflict")
        path = _memory_path(ctx, rec["target"])
        if os.path.lexists(path):
            _fsync_path(path, ctx.profile_dir)
            _fsync_dir(os.path.dirname(path), ctx.profile_dir)
        if _sha_text(_read_memory(ctx, rec["target"])) != receipt["afterDigest"]:
            raise ReviewError("conflict")
        return _finalize_applied(ctx, rec, preview_now, missing_pending_ok=True)
    if current_digest != receipt["beforeDigest"]:
        raise ReviewError("conflict")
    if receipt["decision"] == "reject":
        raise ReviewError("recovery-required")
    if pending_bytes is None:
        raise ReviewError("recovery-required")
    live = _parse_pending(ctx, pending_bytes, rec["id"])
    store, after, changed = _apply_dry(ctx, live["payload"], before)
    if _sha_text(after) != receipt["afterDigest"]:
        raise ReviewError("conflict")
    if _review_digest(ctx, live, before, after) != receipt["reviewDigest"]:
        raise ReviewError("stale-review")
    _require_ready(ctx, live["target"])
    _assert_current(ctx, live, before)
    if changed:
        _write_memory(ctx, live["target"], store.intended_entries or [], after)
    return _finalize_applied(ctx, live, preview_now, missing_pending_ok=False)

def _refresh_config(ctx: Ctx) -> None:
    from tools.memory_tool import get_builtin_memory_config, get_builtin_memory_store_flags
    _load_config(ctx, get_builtin_memory_config, get_builtin_memory_store_flags)

def _assert_current(ctx: Ctx, rec: Dict[str, Any], before: str) -> None:
    if _sha(_safe_read(ctx.profile_dir, ctx.config_path)) != ctx.config_digest:
        raise ReviewError("stale-review")
    pending = _safe_read(ctx.profile_dir, _pending_path(ctx, rec["id"]), missing_ok=True)
    if pending is None or _sha(pending) != rec["pendingDigest"]:
        raise ReviewError("conflict")
    if _read_memory(ctx, rec["target"]) != before:
        raise ReviewError("conflict")

def _cmd_decide(ctx: Ctx) -> Dict[str, Any]:
    item_id = ctx.req_id or ""
    if ctx.expected_digest is None or ctx.decision is None:
        raise ReviewError("invalid")
    receipt = _read_receipt(ctx, item_id)
    if receipt is not None and receipt.get("_bad"):
        raise ReviewError("recovery-required")
    pending = _load_pending(ctx, item_id, missing_ok=True)
    if receipt is not None and receipt.get("phase") == "final":
        if receipt["reviewDigest"] != ctx.expected_digest:
            raise ReviewError("stale-review")
        if receipt["decision"] != ctx.decision:
            raise ReviewError("conflict")
        if pending is not None and pending["pendingDigest"] != receipt["pendingDigest"]:
            raise ReviewError("conflict")
        _finish_remove_pending(ctx, receipt, missing_ok=True)
        return _decide_result(receipt)
    if pending is None and (receipt is None or receipt.get("phase") != "intent"):
        raise ReviewError("unavailable")
    target = (pending or receipt)["target"]  # type: ignore[index]
    with _target_lock(ctx, target, required=ctx.decision == "approve"):
        _refresh_config(ctx)
        receipt = _read_receipt(ctx, item_id)
        if receipt is not None and receipt.get("_bad"):
            raise ReviewError("recovery-required")
        pending = _load_pending(ctx, item_id, missing_ok=True)
        if pending is None and receipt is not None and receipt.get("phase") == "intent":
            before = _read_memory(ctx, receipt["target"])
            fake = {
                "id": item_id,
                "payload": {"action": receipt["action"], "target": receipt["target"]},
                "action": receipt["action"],
                "target": receipt["target"],
                "origin": receipt["origin"],
                "createdAt": receipt["createdAt"],
                "pendingDigest": receipt["pendingDigest"],
                "operationCount": receipt["operationCount"],
            }
            return _recover_intent(ctx, fake, receipt, before)
        if pending is None:
            raise ReviewError("unavailable")
        if pending["target"] != target:
            raise ReviewError("conflict")
        before = _read_memory(ctx, pending["target"])
        if receipt is not None and receipt.get("phase") == "intent":
            return _recover_intent(ctx, pending, receipt, before)
        preview = _preview_state(ctx, pending, before)
        if preview["reviewDigest"] != ctx.expected_digest:
            raise ReviewError("stale-review")
        _assert_current(ctx, pending, before)
        if ctx.decision == "reject":
            signed = _write_receipt(
                ctx,
                _build_receipt(ctx, pending, preview, decision="reject", phase="final", state="rejected"),
            )
            _finish_remove_pending(ctx, pending, missing_ok=False)
            return _decide_result(signed)
        intent = _write_receipt(
            ctx,
            _build_receipt(ctx, pending, preview, decision="approve", phase="intent", state="applied"),
        )
        store, after, changed = _apply_dry(ctx, pending["payload"], before)
        if _sha_text(after) != preview["afterDigest"] or _sha_text(before) != preview["beforeDigest"]:
            raise ReviewError("conflict")
        _assert_current(ctx, pending, before)
        if changed:
            _write_memory(ctx, pending["target"], store.intended_entries or [], after)
        return _finalize_applied(ctx, pending, preview, missing_pending_ok=False)
    raise ReviewError("unavailable")