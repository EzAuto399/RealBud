#!/usr/bin/env python3
"""RealBud bounded Hermes memory-review helper (host-only stdin JSON)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import logging
import os
import re
import stat
import sys
import time
import uuid
from contextlib import contextmanager, suppress
from contextvars import ContextVar
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
    "scopeId", "input", "proposalKey",
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
_REQUEST_STORAGE: ContextVar[Any] = ContextVar("realbud_memory_request_storage", default=None)


class ReviewError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class Ctx:
    __slots__ = (
        "command", "profile_dir", "runtime_dir", "workspace_id", "profile_id",
        "runtime_id", "key", "req_id", "expected_digest", "decision", "cursor",
        "scope_id", "proposal_input", "proposal_key",
        "reviews_dir", "pending_dir", "config_path", "config_digest", "config",
        "write_approval", "memory_enabled", "user_profile_enabled",
        "memory_char_limit", "user_char_limit", "MemoryStore", "apply_memory_pending",
        "ENTRY_DELIMITER", "scan_content", "is_truthy", "DryRun",
    )


def _emit(obj: Dict[str, Any]) -> None:
    try:
        payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
    except Exception:
        with suppress(Exception):
            sys.stdout.buffer.write(b'{"ok":false,"code":"unavailable"}\n')
            sys.stdout.buffer.flush()


def _canonical(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha_text(text: str) -> str:
    return _sha(text.encode("utf-8"))


def _hmac_hex(key: bytes, data: bytes) -> str:
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def _no_dup_pairs(pairs: List[Tuple[Any, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in pairs:
        if k in out:
            raise ValueError("duplicate")
        out[k] = v
    return out


def _json_loads(text: str) -> Any:
    return json.loads(text, object_pairs_hook=_no_dup_pairs)


def _b64key(value: str) -> bytes:
    if not isinstance(value, str):
        raise ReviewError("invalid")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except Exception as exc:
        raise ReviewError("invalid") from exc
    if len(raw) != 32:
        raise ReviewError("invalid")
    return raw


def _norm_hex(value: Any, n: int) -> str:
    if not isinstance(value, str):
        raise ReviewError("invalid")
    text = value.strip().lower()
    if n == 8 and not HEX8.match(text):
        raise ReviewError("invalid")
    if n == 64 and not HEX64.match(text):
        raise ReviewError("invalid")
    return text


def _is_reparse(st: os.stat_result) -> bool:
    attr = int(getattr(st, "st_file_attributes", 0) or 0)
    return bool(attr & FILE_ATTRIBUTE_REPARSE_POINT)


def _is_link(st: os.stat_result) -> bool:
    return stat.S_ISLNK(st.st_mode) or _is_reparse(st)


def _others_writable(st: os.stat_result) -> bool:
    return bool(st.st_mode & 0o022)


def _under(path: str, root: str) -> bool:
    try:
        os.path.relpath(path, root)
        prefix = root if root.endswith(os.sep) else root + os.sep
        return path == root or path.startswith(prefix)
    except ValueError:
        return False


def _lstat(path: str) -> os.stat_result:
    try:
        return os.lstat(path)
    except OSError as exc:
        raise ReviewError("unavailable") from exc


def _same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _windows_io(profile: str) -> Any:
    io = _REQUEST_STORAGE.get()
    if io is not None:
        if os.path.normcase(os.path.abspath(io.profile)) != os.path.normcase(os.path.abspath(profile)):
            raise ReviewError("unsafe-storage")
        return io
    if os.name == "nt":
        # No ambient fallback to the POSIX/path-based implementation.
        raise ReviewError("platform-unverified")
    return None


def _path_exists(profile: str, path: str) -> bool:
    io = _windows_io(profile)
    if io is not None:
        return io.read(path, missing_ok=True) is not None
    return os.path.lexists(path)


def _check_ancestors(path: str, profile: str) -> None:
    cur = path
    seen = set()
    while True:
        if cur in seen:
            raise ReviewError("unsafe-storage")
        seen.add(cur)
        st = _lstat(cur)
        if _is_link(st):
            raise ReviewError("unsafe-storage")
        inside = _under(cur, profile)
        if inside:
            if POSIX and st.st_uid != os.geteuid():
                raise ReviewError("unsafe-storage")
            if POSIX and _others_writable(st):
                raise ReviewError("unsafe-storage")
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent


def _open_nofollow(path: str, flags: int, mode: int = 0o600) -> int:
    fl = flags
    if hasattr(os, "O_NOFOLLOW"):
        fl |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        fl |= os.O_CLOEXEC
    if hasattr(os, "O_BINARY"):
        fl |= os.O_BINARY
    try:
        return os.open(path, fl, mode)
    except OSError as exc:
        raise ReviewError("unsafe-storage") from exc


def _read_fd(fd: int, limit: int) -> bytes:
    chunks: List[bytes] = []
    n = 0
    while True:
        try:
            buf = os.read(fd, min(65536, limit + 1 - n))
        except OSError as exc:
            raise ReviewError("unavailable") from exc
        if not buf:
            break
        n += len(buf)
        if n > limit:
            raise ReviewError("capacity")
        chunks.append(buf)
    return b"".join(chunks)


def _safe_read(profile: str, path: str, limit: int = MAX_BYTES, *, missing_ok: bool = False) -> Optional[bytes]:
    io = _windows_io(profile)
    if io is not None:
        return io.read(path, limit=limit, missing_ok=missing_ok)
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


def _fsync_fd(fd: int) -> None:
    try:
        os.fsync(fd)
    except OSError as exc:
        raise ReviewError("unavailable") from exc


def _fsync_path(path: str, profile: str) -> None:
    io = _windows_io(profile)
    if io is not None:
        io.flush_file(path)
        return
    _check_ancestors(path, profile)
    st = _lstat(path)
    if _is_link(st) or not stat.S_ISREG(st.st_mode):
        raise ReviewError("unsafe-storage")
    fd = _open_nofollow(path, os.O_RDONLY)
    try:
        fst = os.fstat(fd)
        if not _same_inode(st, fst):
            raise ReviewError("unsafe-storage")
        _fsync_fd(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: str, profile: str) -> None:
    io = _windows_io(profile)
    if io is not None:
        # Win32 writes use checked file flushes/write-through around rename.
        # This verifies ancestry only; it is NOT a POSIX directory-fsync or a
        # power-loss durability promise. Journals reconcile process recovery.
        io.verify_directory(path)
        return
    _check_ancestors(path, profile)
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    fd = _open_nofollow(path, flags)
    try:
        try:
            os.fsync(fd)
        except OSError:
            raise ReviewError("unavailable") from None
    finally:
        os.close(fd)


def _ensure_helper_dir(path: str, profile: str, *, create: bool = True) -> None:
    io = _windows_io(profile)
    if io is not None:
        if create:
            io.ensure_directory(path)
        else:
            io.verify_directory(path)
        return
    if not _under(path, profile):
        raise ReviewError("unsafe-storage")
    _check_ancestors(os.path.dirname(path), profile)
    created = False
    if create:
        try:
            os.mkdir(path, 0o700)
            created = True
        except FileExistsError:
            pass
    st = _lstat(path)
    if _is_link(st) or not stat.S_ISDIR(st.st_mode):
        raise ReviewError("unsafe-storage")
    if POSIX and (st.st_uid != os.geteuid() or st.st_mode & 0o077):
        raise ReviewError("unsafe-storage")
    _check_ancestors(path, profile)
    if created:
        _fsync_dir(os.path.dirname(path), profile)


def _atomic_write(profile: str, path: str, data: bytes, mode: int = 0o600) -> None:
    io = _windows_io(profile)
    if io is not None:
        io.atomic_write(path, data)
        return
    if not _under(path, profile):
        raise ReviewError("unsafe-storage")
    parent = os.path.dirname(path)
    _check_ancestors(parent, profile)
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        existing = None
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    if existing is not None and (_is_link(existing) or not stat.S_ISREG(existing.st_mode)):
        raise ReviewError("unsafe-storage")
    tmp = os.path.join(parent, ".tmp.%d.%d.part" % (os.getpid(), time.time_ns()))
    fd = _open_nofollow(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        if POSIX and hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        off = 0
        while off < len(data):
            off += os.write(fd, data[off:])
        _fsync_fd(fd)
    except Exception:
        os.close(fd)
        with suppress(OSError):
            os.unlink(tmp)
        raise
    os.close(fd)
    try:
        os.replace(tmp, path)
    except OSError:
        with suppress(OSError):
            os.unlink(tmp)
        raise ReviewError("unavailable") from None
    _fsync_path(path, profile)
    _fsync_dir(parent, profile)
    st = _lstat(path)
    if _is_link(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ReviewError("unsafe-storage")
    if POSIX and ((st.st_mode & 0o077) != 0 or st.st_uid != os.geteuid()):
        raise ReviewError("unsafe-storage")


def _claim_path(profile: str, path: str) -> str:
    return os.path.join(profile, ".realbud-memory-reviews", "claims", os.path.basename(path))


def _unlink_if_digest(profile: str, path: str, digest: str, *, missing_ok: bool) -> None:
    io = _windows_io(profile)
    if io is not None:
        claims = os.path.join(profile, ".realbud-memory-reviews", "claims")
        io.ensure_directory(claims)
        claim = _claim_path(profile, path)
        claimed = io.read(claim, missing_ok=True)
        if claimed is None:
            live = io.read(path, missing_ok=True)
            if live is None:
                if missing_ok:
                    return
                raise ReviewError("recovery-required")
            if _sha(live) != digest:
                raise ReviewError("conflict")
            io.move_new(path, claim, digest)
            claimed = io.read(claim)
        if claimed is None or _sha(claimed) != digest:
            raise ReviewError("conflict")
        io.delete_exact(claim, digest)
        # A disposition request/close can leave a name pending deletion. Never
        # issue terminal cleanup until an independently checked read is absent.
        if io.read(claim, missing_ok=True) is not None:
            raise ReviewError("recovery-required")
        if io.read(path, missing_ok=True) is not None:
            raise ReviewError("conflict")
        return
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


@contextmanager
def _silence_stdio() -> Iterator[None]:
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    out = os.dup(1)
    err = os.dup(2)
    try:
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        yield
    finally:
        with suppress(OSError):
            os.dup2(out, 1)
            os.dup2(err, 2)
            os.close(out)
            os.close(err)
            os.close(devnull)


def _dir_ok(path: str, profile: Optional[str], *, create: bool = False) -> None:
    if create and profile is not None:
        _ensure_helper_dir(path, profile)
        return
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise ReviewError("unavailable") from exc
    if _is_link(st) or not stat.S_ISDIR(st.st_mode):
        raise ReviewError("unsafe-storage")
    if profile is not None:
        _check_ancestors(path, profile)


def _load_yaml_mapping(data: bytes) -> Dict[str, Any]:
    try:
        import yaml
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if not hasattr(yaml, "SafeLoader"):
        raise ReviewError("unavailable")

    class UniqueLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):  # type: ignore[no-untyped-def]
            if not isinstance(node, yaml.MappingNode):
                raise yaml.constructor.ConstructorError(None, None, "not a mapping", node.start_mark)
            seen = set()
            mapping: Dict[Any, Any] = {}
            for k_node, v_node in node.value:
                key = self.construct_object(k_node, deep=deep)
                if key in seen:
                    raise yaml.constructor.ConstructorError(None, None, "duplicate key", k_node.start_mark)
                seen.add(key)
                mapping[key] = self.construct_object(v_node, deep=deep)
            return mapping

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReviewError("unavailable") from exc
    try:
        obj = yaml.load(text, Loader=UniqueLoader)
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if not isinstance(obj, dict):
        raise ReviewError("unavailable")
    return obj


def _int_limit(section: Dict[str, Any], key: str, default: int) -> int:
    if key not in section:
        return default
    value = section[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ReviewError("invalid")
    if value < CHAR_MIN or value > CHAR_MAX:
        raise ReviewError("capacity")
    return value


def _provider_ok(section: Dict[str, Any]) -> None:
    # In the admitted agent_init, an external provider runs ALONGSIDE the
    # built-in store. Its name is not an on/off switch for MEMORY.md / USER.md.
    # Only native built-in target flags authorize these particular files.
    for key in ("memory_enabled", "user_profile_enabled", "write_approval"):
        if key in section and not isinstance(section[key], bool):
            raise ReviewError("unsupported")


def _parse_request(req: Any) -> Ctx:
    if not isinstance(req, dict):
        raise ReviewError("invalid")
    if set(req.keys()) - REQ_KEYS:
        raise ReviewError("invalid")
    for key in REQ_REQUIRED:
        if key not in req:
            raise ReviewError("invalid")
    if req["version"] is True or req["version"] is False or req["version"] != 1:
        raise ReviewError("invalid")
    command = req["command"]
    if command not in ("list", "preview", "decide", "propose", "interrupted-list", "interrupted-close"):
        raise ReviewError("invalid")
    required = {"list": set(), "preview": {"id"},
                "decide": {"id", "expectedDigest", "decision"},
                "propose": {"scopeId", "input"}, "interrupted-list": set(),
                "interrupted-close": {"proposalKey", "expectedDigest"}}[command]
    optional = {"cursor"} if command in ("list", "interrupted-list") else set()
    if not required.issubset(req) or set(req) - set(REQ_REQUIRED) - required - optional:
        raise ReviewError("invalid")
    if command in ("interrupted-list", "interrupted-close"):
        for field in ("cursor", "proposalKey", "expectedDigest"):
            if field in req and (not isinstance(req[field], str) or not HEX64.fullmatch(req[field])):
                raise ReviewError("invalid")
    profile = req["profileDirectory"]
    runtime = req["runtimeDirectory"]
    if not isinstance(profile, str) or not isinstance(runtime, str):
        raise ReviewError("invalid")
    if "\x00" in profile or "\x00" in runtime:
        raise ReviewError("invalid")
    if not os.path.isabs(profile) or not os.path.isabs(runtime):
        raise ReviewError("invalid")
    profile_dir = os.path.abspath(os.path.normpath(profile))
    runtime_dir = os.path.abspath(os.path.normpath(runtime))
    workspace = req["workspaceId"]
    profile_id = req["profileId"]
    runtime_id = req["runtimeId"]
    if not isinstance(workspace, str) or not isinstance(profile_id, str) or not isinstance(runtime_id, str):
        raise ReviewError("invalid")
    try:
        parsed_ws = uuid.UUID(workspace)
    except Exception as exc:
        raise ReviewError("invalid") from exc
    if str(parsed_ws) != workspace:
        raise ReviewError("invalid")
    if not PROFILE_ID.match(profile_id) or not RUNTIME_ID.match(runtime_id):
        raise ReviewError("invalid")
    if os.path.basename(profile_dir) != profile_id:
        raise ReviewError("invalid")
    _dir_ok(profile_dir, None)
    _dir_ok(runtime_dir, None)
    _check_ancestors(profile_dir, profile_dir)
    st_rt = _lstat(runtime_dir)
    if _is_link(st_rt) or not stat.S_ISDIR(st_rt.st_mode):
        raise ReviewError("unsafe-storage")
    ctx = Ctx()
    ctx.command = command
    ctx.profile_dir = profile_dir
    ctx.runtime_dir = runtime_dir
    ctx.workspace_id = workspace
    ctx.profile_id = profile_id
    ctx.runtime_id = runtime_id
    ctx.key = _b64key(req["key"])
    ctx.req_id = _norm_hex(req["id"], 8) if "id" in req else None
    ctx.expected_digest = _norm_hex(req["expectedDigest"], 64) if "expectedDigest" in req else None
    ctx.decision = req.get("decision")
    if ctx.decision is not None and ctx.decision not in ("approve", "reject"):
        raise ReviewError("invalid")
    ctx.cursor = _norm_hex(req["cursor"], 64 if command == "interrupted-list" else 8) if "cursor" in req else None
    ctx.scope_id = _norm_hex(req["scopeId"], 64) if command == "propose" else None
    ctx.proposal_input = req.get("input") if command == "propose" else None
    ctx.proposal_key = req.get("proposalKey") if command == "interrupted-close" else None
    ctx.reviews_dir = os.path.join(profile_dir, ".realbud-memory-reviews")
    ctx.pending_dir = os.path.join(profile_dir, "pending", "memory")
    ctx.config_path = os.path.join(profile_dir, "config.yaml")
    return ctx


def _import_native(ctx: Ctx) -> None:
    logging.disable(logging.CRITICAL)
    os.environ["HERMES_HOME"] = ctx.profile_dir
    if ctx.runtime_dir in sys.path:
        sys.path.remove(ctx.runtime_dir)
    sys.path.insert(0, ctx.runtime_dir)
    tool_py = os.path.join(ctx.runtime_dir, "tools", "memory_tool.py")
    try:
        st = os.lstat(tool_py)
    except FileNotFoundError:
        st = None
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    if st is not None and (_is_link(st) or not stat.S_ISREG(st.st_mode)):
        raise ReviewError("unsafe-storage")
    try:
        with _silence_stdio():
            from hermes_constants import get_hermes_home
            from tools.memory_tool import (
                apply_memory_pending,
                get_builtin_memory_config,
                get_builtin_memory_store_flags,
                get_memory_dir,
            )
            from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore, _scan_memory_content
            from tools import memory_tool as memory_tool_mod
            from utils import is_truthy_value
    except ReviewError:
        raise
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if memory_tool_mod.fcntl is None and memory_tool_mod.msvcrt is None:
        raise ReviewError("unavailable")
    try:
        home = os.path.abspath(os.path.normpath(str(get_hermes_home())))
        memdir = os.path.abspath(os.path.normpath(str(get_memory_dir())))
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if home != ctx.profile_dir:
        raise ReviewError("unavailable")
    if memdir != os.path.join(ctx.profile_dir, "memories"):
        raise ReviewError("unavailable")
    if ENTRY_DELIMITER != "\n§\n":
        raise ReviewError("unsupported")
    if not callable(apply_memory_pending) or not callable(_scan_memory_content):
        raise ReviewError("unavailable")
    ctx.MemoryStore = MemoryStore
    ctx.apply_memory_pending = apply_memory_pending
    ctx.ENTRY_DELIMITER = ENTRY_DELIMITER
    ctx.scan_content = _scan_memory_content
    ctx.is_truthy = is_truthy_value
    ctx.DryRun = _build_dry_run(MemoryStore, ENTRY_DELIMITER)
    # Recovery closes only signed proposal bookkeeping. Native imports/home and
    # the interoperable review lock remain required; preference configuration
    # must not prevent staff from closing an interrupted, absent draft.
    if ctx.command not in ("interrupted-list", "interrupted-close"):
        _load_config(ctx, get_builtin_memory_config, get_builtin_memory_store_flags)


def _load_config(ctx: Ctx, get_builtin_memory_config: Any, get_builtin_memory_store_flags: Any) -> None:
    raw = _safe_read(ctx.profile_dir, ctx.config_path)
    if raw is None:
        raise ReviewError("unavailable")
    ctx.config_digest = _sha(raw)
    cfg = _load_yaml_mapping(raw)
    try:
        section = get_builtin_memory_config(cfg)
        flags = get_builtin_memory_store_flags(cfg)
    except ReviewError:
        raise
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if not isinstance(section, dict) or not isinstance(flags, tuple) or len(flags) != 2:
        raise ReviewError("unavailable")
    _provider_ok(section)
    ctx.config = cfg
    if "write_approval" not in section:
        ctx.write_approval = False
    else:
        try:
            ctx.write_approval = bool(ctx.is_truthy(section["write_approval"], default=False))
        except Exception as exc:
            raise ReviewError("unavailable") from exc
    ctx.memory_enabled = bool(flags[0])
    ctx.user_profile_enabled = bool(flags[1])
    ctx.memory_char_limit = _int_limit(section, "memory_char_limit", DEFAULT_MEMORY_LIMIT)
    ctx.user_char_limit = _int_limit(section, "user_char_limit", DEFAULT_USER_LIMIT)


def _created_at(obj: Dict[str, Any]) -> float:
    value = obj.get("created_at")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 8.64e12:
        raise ReviewError("unsupported")
    return value * 1000


def _reject_new_text(ctx: Ctx, text: str) -> None:
    if not isinstance(text, str):
        raise ReviewError("invalid")
    if ctx.ENTRY_DELIMITER in text:
        raise ReviewError("blocked-content")
    for ch in text:
        o = ord(ch)
        if (o < 32 and ch not in "\t\n") or 127 <= o <= 159 or 0x202A <= o <= 0x202E or 0x2066 <= o <= 0x2069 or 0xD800 <= o <= 0xDFFF:
            raise ReviewError("blocked-content")
    try:
        hit = ctx.scan_content(text) or ctx.scan_content(text.strip())
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if hit:
        raise ReviewError("blocked-content")


def _norm_alias(content: Any, new_text: Any) -> Any:
    if content is None:
        content = ABSENT
    if new_text is None:
        new_text = ABSENT
    if content is not ABSENT and not isinstance(content, str):
        raise ReviewError("invalid")
    if new_text is not ABSENT and not isinstance(new_text, str):
        raise ReviewError("invalid")
    if content is not ABSENT and new_text is not ABSENT and content != new_text:
        raise ReviewError("unsupported")
    if content is ABSENT:
        return new_text
    return content


def _norm_op(ctx: Ctx, op: Any, idx: int) -> Dict[str, Any]:
    if not isinstance(op, dict):
        raise ReviewError("invalid")
    if set(op.keys()) - OP_KEYS:
        raise ReviewError("unsupported")
    if "target" in op:
        raise ReviewError("unsupported")
    action = op.get("action")
    if action not in ("add", "replace", "remove"):
        raise ReviewError("unsupported")
    content = _norm_alias(op.get("content", ABSENT), op.get("new_text", ABSENT))
    old_text = op.get("old_text", ABSENT)
    if old_text is None:
        old_text = ABSENT
    if old_text is not ABSENT and not isinstance(old_text, str):
        raise ReviewError("invalid")
    out: Dict[str, Any] = {"action": action}
    if action in ("add", "replace"):
        if content is ABSENT:
            raise ReviewError("invalid")
        _reject_new_text(ctx, content)
        out["content"] = content
        if action == "replace":
            if old_text is ABSENT:
                raise ReviewError("invalid")
            out["old_text"] = old_text
        elif old_text is not ABSENT and old_text != "":
            raise ReviewError("unsupported")
    else:
        if content is not ABSENT and content != "":
            raise ReviewError("unsupported")
        if old_text is ABSENT:
            raise ReviewError("invalid")
        out["old_text"] = old_text
    if idx < 0:
        raise ReviewError("invalid")
    return out


def _norm_payload(ctx: Ctx, payload: Dict[str, Any]) -> Dict[str, Any]:
    if set(payload.keys()) - PAYLOAD_KEYS:
        raise ReviewError("unsupported")
    target = payload.get("target", "memory")
    if target is None:
        target = "memory"
    if target not in TARGETS:
        raise ReviewError("unsupported")
    operations = payload.get("operations", ABSENT)
    action = payload.get("action", ABSENT)
    if operations is None:
        operations = ABSENT
    if action is None:
        action = ABSENT
    if operations is not ABSENT:
        if action is not ABSENT and action != "batch":
            raise ReviewError("unsupported")
        if any(k in payload for k in ("content", "old_text", "new_text")):
            raise ReviewError("unsupported")
        if not isinstance(operations, list):
            raise ReviewError("invalid")
        if len(operations) > MAX_OPS:
            raise ReviewError("capacity")
        if not operations:
            raise ReviewError("invalid")
        ops = [_norm_op(ctx, op, i) for i, op in enumerate(operations)]
        return {"action": "batch", "target": target, "operations": ops}
    if action not in ("add", "replace", "remove"):
        raise ReviewError("unsupported")
    content = _norm_alias(payload.get("content", ABSENT), payload.get("new_text", ABSENT))
    old_text = payload.get("old_text", ABSENT)
    if old_text is None:
        old_text = ABSENT
    if old_text is not ABSENT and not isinstance(old_text, str):
        raise ReviewError("invalid")
    out: Dict[str, Any] = {"action": action, "target": target}
    if action in ("add", "replace"):
        if content is ABSENT:
            raise ReviewError("invalid")
        _reject_new_text(ctx, content)
        out["content"] = content
        if action == "replace":
            if old_text is ABSENT:
                raise ReviewError("invalid")
            out["old_text"] = old_text
        elif old_text is not ABSENT and old_text != "":
            raise ReviewError("unsupported")
    else:
        if content is not ABSENT and content != "":
            raise ReviewError("unsupported")
        if old_text is ABSENT:
            raise ReviewError("invalid")
        out["old_text"] = old_text
    return out


def _parse_pending(ctx: Ctx, data: bytes, file_id: str) -> Dict[str, Any]:
    try:
        obj = _json_loads(data.decode("utf-8"))
    except Exception as exc:
        raise ReviewError("unsupported") from exc
    if not isinstance(obj, dict) or set(obj) != PENDING_TOP:
        raise ReviewError("unsupported")
    if obj["id"] != file_id or obj["subsystem"] != "memory":
        raise ReviewError("conflict")
    if obj["origin"] not in ORIGINS or not isinstance(obj["summary"], str) or not isinstance(obj["payload"], dict):
        raise ReviewError("unsupported")
    payload = _norm_payload(ctx, obj["payload"])
    if obj["action"] != payload["action"]:
        raise ReviewError("unsupported")
    return {"id": file_id, "origin": obj["origin"], "createdAt": _created_at(obj),
            "payload": payload, "action": payload["action"], "target": payload["target"],
            "pendingDigest": _sha(data), "operationCount": len(payload["operations"]) if payload["action"] == "batch" else 1}


def _round_trip(ctx: Ctx, raw: str, limit: int) -> List[str]:
    parsed = ctx.MemoryStore._parse_entries(raw)
    if len(set(parsed)) != len(parsed) or raw != ctx.ENTRY_DELIMITER.join(parsed):
        raise ReviewError("conflict")
    return parsed


def _build_dry_run(MemoryStore: Any, delimiter: str) -> Any:
    class DryRunMemoryStore(MemoryStore):  # type: ignore[misc,valid-type]
        def __init__(self, snapshot_raw: str, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self._snapshot_raw = snapshot_raw
            self.intended_entries: Optional[List[str]] = None
            self.did_write = False

        @staticmethod
        @contextmanager
        def _file_lock(path):  # type: ignore[no-untyped-def]
            yield

        def _read_raw_checked(self, path):  # type: ignore[no-untyped-def]
            return self._snapshot_raw, True

        def _detect_external_drift(self, target, raw):  # type: ignore[no-untyped-def]
            parsed = self._parse_entries(raw)
            if not raw.strip() or (
                raw.strip() == delimiter.join(parsed)
                and max(map(len, parsed), default=0) <= self._char_limit(target)
            ):
                return None
            return "drift"

        def _write_file(self, path, entries):  # type: ignore[no-untyped-def]
            self.intended_entries = list(entries)
            self.did_write = True

        def _mutate(self, target, mutate, *, skip_drift=False):  # type: ignore[no-untyped-def]
            raw, read_ok = self._snapshot_raw, True
            if not read_ok:
                return {"success": False, "error": "read"}
            parsed = self._parse_entries(raw)
            if len(parsed) != len(list(dict.fromkeys(parsed))):
                return {"success": False, "error": "duplicate-entries"}
            if raw != delimiter.join(parsed):
                return {"success": False, "error": "drift"}
            if not skip_drift and parsed and max(map(len, parsed)) > self._char_limit(target):
                return {"success": False, "error": "drift"}
            self._set_entries(target, parsed)
            result = mutate(self._entries_for(target), self._char_limit(target))
            if isinstance(result, dict):
                return result
            self._set_entries(target, result[0])
            self._write_file(self._path_for(target), result[0])
            return self._success_response(target, result[1])

    return DryRunMemoryStore


def _map_store_error(result: Dict[str, Any]) -> str:
    err = str(result.get("error") or "").lower()
    if "disabled" in err:
        return "disabled"
    if any(x in err for x in ("threat", "blocked", "injection")):
        return "blocked-content"
    if any(x in err for x in ("limit", "exceed", "over the", "chars", "capacity")):
        return "capacity"
    if "unknown staged action" in err or "unknown action" in err:
        return "unsupported"
    return "conflict"


def _target_limit(ctx: Ctx, target: str) -> int:
    return ctx.user_char_limit if target == "user" else ctx.memory_char_limit


def _target_enabled(ctx: Ctx, target: str) -> bool:
    return ctx.user_profile_enabled if target == "user" else ctx.memory_enabled


def _memory_path(ctx: Ctx, target: str) -> str:
    return os.path.join(ctx.profile_dir, "memories", "USER.md" if target == "user" else "MEMORY.md")


def _read_memory(ctx: Ctx, target: str) -> str:
    path = _memory_path(ctx, target)
    data = _safe_read(ctx.profile_dir, path, missing_ok=True)
    if data is None:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReviewError("unavailable") from exc


def _apply_dry(ctx: Ctx, payload: Dict[str, Any], before: str) -> Tuple[Any, str, bool]:
    target = payload["target"]
    _round_trip(ctx, before, _target_limit(ctx, target))
    store = ctx.DryRun(
        before,
        memory_char_limit=ctx.memory_char_limit,
        user_char_limit=ctx.user_char_limit,
        memory_enabled=ctx.memory_enabled,
        user_profile_enabled=ctx.user_profile_enabled,
    )
    try:
        result = ctx.apply_memory_pending(payload, store)
    except ReviewError:
        raise
    except Exception as exc:
        raise ReviewError("unavailable") from exc
    if not isinstance(result, dict):
        raise ReviewError("unavailable")
    if not result.get("success"):
        raise ReviewError(_map_store_error(result))
    if store.did_write:
        if store.intended_entries is None:
            raise ReviewError("unavailable")
        for entry in store.intended_entries:
            before_entries = ctx.MemoryStore._parse_entries(before)
            if entry not in before_entries:
                _reject_new_text(ctx, entry)
        after = ctx.ENTRY_DELIMITER.join(store.intended_entries)
        if len(after.encode("utf-8")) > MAX_BYTES:
            raise ReviewError("capacity")
        return store, after, True
    return store, before, False


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


def _receipt_body(rec: Dict[str, Any]) -> Dict[str, Any]:
    return {k: rec[k] for k in RECEIPT_KEYS if k != "mac"}


def _sign_receipt(ctx: Ctx, rec: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(rec)
    out["mac"] = _hmac_hex(ctx.key, b"realbud-memory-receipt-v1\0" + _canonical(_receipt_body(out)).encode("ascii"))
    return out


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


def _receipt_path(ctx: Ctx, item_id: str) -> str:
    return os.path.join(ctx.reviews_dir, "%s.json" % item_id)


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


def _write_receipt(ctx: Ctx, rec: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_helper_dir(ctx.reviews_dir, ctx.profile_dir)
    signed = _sign_receipt(ctx, rec)
    data = _canonical(signed).encode("ascii")
    if len(data) > MAX_BYTES:
        raise ReviewError("capacity")
    _atomic_write(ctx.profile_dir, _receipt_path(ctx, rec["id"]), data, 0o600)
    return signed


def _pending_path(ctx: Ctx, item_id: str) -> str:
    return os.path.join(ctx.pending_dir, "%s.json" % item_id)


def _load_pending(ctx: Ctx, item_id: str, *, missing_ok: bool) -> Optional[Dict[str, Any]]:
    path = _pending_path(ctx, item_id)
    data = _safe_read(ctx.profile_dir, path, missing_ok=missing_ok)
    if data is None:
        return None
    return _parse_pending(ctx, data, item_id)


@contextmanager
def _review_lock(ctx: Ctx) -> Iterator[None]:
    _ensure_helper_dir(ctx.reviews_dir, ctx.profile_dir)
    lock_target = os.path.join(ctx.reviews_dir, "review")
    io = _windows_io(ctx.profile_dir)
    if io is not None:
        with io.lock(lock_target + ".lock"):
            yield
        return
    _safe_read(ctx.profile_dir, lock_target + ".lock", missing_ok=True)
    with ctx.MemoryStore._file_lock(Path(lock_target)):
        _safe_read(ctx.profile_dir, lock_target + ".lock")
        yield


@contextmanager
def _target_lock(ctx: Ctx, target: str, *, required: bool) -> Iterator[None]:
    path = ctx.MemoryStore._path_for(target)
    io = _windows_io(ctx.profile_dir)
    if io is not None:
        if os.path.normcase(str(path)) != os.path.normcase(_memory_path(ctx, target)):
            raise ReviewError("unavailable")
        io.ensure_directory(str(path.parent))
        with io.lock(str(path.with_suffix(path.suffix + ".lock"))):
            yield
        return
    if not os.path.lexists(path.parent):
        _ensure_helper_dir(str(path.parent), ctx.profile_dir)
    _check_ancestors(str(path.parent), ctx.profile_dir)
    lock = str(path.with_suffix(path.suffix + ".lock"))
    _safe_read(ctx.profile_dir, lock, missing_ok=True)
    with ctx.MemoryStore._file_lock(path):
        _safe_read(ctx.profile_dir, lock)
        yield


def _scan_dir(path: str, profile: str, remaining: List[int]) -> List[str]:
    io = _windows_io(profile)
    if io is not None:
        names = io.names(path, limit=remaining[0], missing_ok=True)
        remaining[0] -= len(names)
        if remaining[0] < 0:
            raise ReviewError("capacity")
        return [name[:8].lower() for name in names
                if len(name) == 13 and HEX8.match(name[:8].lower()) and name.lower().endswith(".json")]
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    if _is_link(st):
        raise ReviewError("unsafe-storage")
    if not stat.S_ISDIR(st.st_mode):
        raise ReviewError("unsafe-storage")
    _check_ancestors(path, profile)
    ids: List[str] = []
    try:
        with os.scandir(path) as it:
            for ent in it:
                remaining[0] -= 1
                if remaining[0] < 0:
                    raise ReviewError("capacity")
                name = ent.name
                if HEX8.match(name[:8].lower()) and name.lower().endswith(".json") and len(name) == 13:
                    ids.append(name[:8].lower())
    except ReviewError:
        raise
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    return ids


def _collect_ids(ctx: Ctx) -> List[str]:
    remaining = [MAX_DIR]
    pending_ids = _scan_dir(ctx.pending_dir, ctx.profile_dir, remaining)
    review_ids = _scan_dir(ctx.reviews_dir, ctx.profile_dir, remaining)
    return sorted(set(pending_ids) | set(review_ids))


def _item_shell(item_id: str, state: str) -> Dict[str, Any]:
    return {
        "id": item_id,
        "state": state,
        "action": None,
        "target": None,
        "origin": None,
        "createdAt": None,
        "decision": None, "reviewDigest": None,
    }


def _classify(ctx: Ctx, item_id: str) -> Dict[str, Any]:
    receipt = _read_receipt(ctx, item_id)
    claim_present = _path_exists(ctx.profile_dir, _claim_path(ctx.profile_dir, _pending_path(ctx, item_id)))
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


def _require_ready(ctx: Ctx, target: str) -> None:
    if not ctx.write_approval:
        raise ReviewError("disabled")
    if not _target_enabled(ctx, target):
        raise ReviewError("disabled")


def _cmd_list(ctx: Ctx) -> Dict[str, Any]:
    ids = _collect_ids(ctx)
    source = [i for i in ids if ctx.cursor is None or i > ctx.cursor]
    page = source[:PAGE]
    classified = []
    for item_id in ids:
        try:
            classified.append(_classify(ctx, item_id))
        except ReviewError:
            classified.append(_item_shell(item_id, "unavailable"))
    by_id = {item["id"]: item for item in classified}
    held = sum(1 for item in classified if item["state"] in ("recovery-required", "unavailable"))
    return {
        "version": 1,
        "items": [by_id[i] for i in page],
        "nextCursor": page[-1] if len(source) > PAGE else None,
        "total": len(ids),
        "held": held,
    }


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


def _decide_result(receipt: Dict[str, Any]) -> Dict[str, Any]:
    changed = receipt["state"] == "applied" and receipt["beforeDigest"] != receipt["afterDigest"]
    return {
        "version": 1,
        "id": receipt["id"],
        "state": receipt["state"],
        "reviewDigest": receipt["reviewDigest"],
        "changed": changed,
        "at": receipt["at"],
    }


def _finish_remove_pending(ctx: Ctx, rec: Dict[str, Any], missing_ok: bool) -> None:
    _unlink_if_digest(ctx.profile_dir, _pending_path(ctx, rec["id"]), rec["pendingDigest"], missing_ok=missing_ok)


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
    io = _windows_io(ctx.profile_dir)
    if io is not None:
        io.atomic_write(path, after.encode("utf-8"))
        if _read_memory(ctx, target) != after:
            raise ReviewError("recovery-required")
        return
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
        if _path_exists(ctx.profile_dir, path):
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


def _dispatch(ctx: Ctx) -> Dict[str, Any]:
    # Storage primitives are being validated independently on Windows. Keep
    # this authoritative helper held too; a direct stdin call cannot bypass
    # the host's platform gate or imply that the experimental adapter is live.
    if not POSIX or os.name != "posix":
        raise ReviewError("platform-unverified")
    return _dispatch_ready(ctx)


def _dispatch_ready(ctx: Ctx, *, storage: Any = None) -> Dict[str, Any]:
    """Internal candidate seam, never selected through JSON or environment.

    The public entrypoints keep their platform hold. Tests may supply explicit
    fictional IO to exercise real native semantics without claiming Win32 proof.
    """
    if storage is None and os.name == "nt":
        path = Path(__file__).with_name("hermes-memory-windows-journal.py")
        spec = importlib.util.spec_from_file_location("realbud_memory_windows_journal", path)
        if spec is None or spec.loader is None:
            raise ReviewError("unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        storage = module.WindowsJournalIO(ctx.profile_dir)
    token = _REQUEST_STORAGE.set(storage)
    try:
        _windows_io(ctx.profile_dir)  # Bind the captured profile before imports.
        return _dispatch_commands(ctx)
    except ReviewError:
        raise
    except Exception as exc:
        if storage is not None and isinstance(exc, storage.error_type):
            code = getattr(exc, "code", "unavailable")
            allowed = {"unsafe-storage", "capacity", "conflict", "recovery-required", "invalid", "unavailable", "platform-unverified"}
            raise ReviewError(code if code in allowed else "unavailable") from None
        raise ReviewError("unavailable") from None
    finally:
        _REQUEST_STORAGE.reset(token)


def _dispatch_commands(ctx: Ctx) -> Dict[str, Any]:
    _import_native(ctx)
    with _review_lock(ctx):
        io = _windows_io(ctx.profile_dir)
        if io is not None:
            # Once proposal evidence exists, no request (including a normal
            # review-list refresh) may recreate deleted evidence ancestry and
            # thereby turn an unknown state into apparently absent leaves.
            proposal_names = io.names(os.path.join(ctx.reviews_dir, "proposals"), limit=MAX_DIR, missing_ok=True)
            has_proposals = any(len(name) == 69 and name.endswith(".json") and HEX64.fullmatch(name[:64])
                                for name in proposal_names)
            for path in (
                os.path.join(ctx.profile_dir, "memories"),
                os.path.join(ctx.profile_dir, "pending"),
                ctx.pending_dir,
                os.path.join(ctx.reviews_dir, "claims"),
            ):
                if has_proposals:
                    io.verify_directory(path)
                else:
                    io.ensure_directory(path)
        if ctx.command == "list":
            return _cmd_list(ctx)
        if ctx.command == "preview":
            return _cmd_preview(ctx)
        if ctx.command in ("propose", "interrupted-list", "interrupted-close"):
            # Only our bundled sibling module, never a profile/runtime import.
            path = Path(__file__).with_name("hermes-memory-proposals.py")
            spec = importlib.util.spec_from_file_location("realbud_memory_proposals", path)
            if spec is None or spec.loader is None:
                raise ReviewError("unavailable")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if ctx.command == "interrupted-list":
                return module.interrupted_list(sys.modules[__name__], ctx)
            if ctx.command == "interrupted-close":
                return module.interrupted_close(sys.modules[__name__], ctx)
            return module.propose(sys.modules[__name__], ctx, ctx.scope_id, ctx.proposal_input)
        return _cmd_decide(ctx)


def main(argv: Optional[List[str]] = None) -> int:
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN + 1)
        if len(raw) > MAX_STDIN:
            raise ReviewError("capacity")
        try:
            req = _json_loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ReviewError("invalid") from exc
        # Reject the platform before request parsing performs directory/ancestor
        # metadata checks. _dispatch repeats this for direct internal callers.
        if not POSIX or os.name != "posix":
            raise ReviewError("platform-unverified")
        ctx = _parse_request(req)
        result = _dispatch(ctx)
        _emit({"ok": True, "result": result})
        return 0
    except ReviewError as exc:
        _emit({"ok": False, "code": exc.code})
        return 0
    except Exception:
        _emit({"ok": False, "code": "unavailable"})
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
