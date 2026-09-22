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
PENDING_TOP = frozenset({
    "id", "kind", "tool", "payload", "summary", "origin", "created_at",
    "createdAt", "status", "detail", "message", "ts",
})
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
    return bool(st.st_mode & 0o002)


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
    if os.name == "nt" and left.st_ino == 0 and right.st_ino == 0:
        return True
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


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
    if not _under(path, profile):
        raise ReviewError("unsafe-storage")
    _check_ancestors(path, profile)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise ReviewError("unavailable") from None
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    if _is_link(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ReviewError("unsafe-storage")
    if POSIX and (st.st_uid != os.geteuid() or _others_writable(st)):
        raise ReviewError("unsafe-storage")
    fd = _open_nofollow(path, os.O_RDONLY)
    try:
        fst = os.fstat(fd)
        if _is_link(fst) or not stat.S_ISREG(fst.st_mode) or fst.st_nlink != 1:
            raise ReviewError("unsafe-storage")
        if not _same_inode(st, fst):
            raise ReviewError("unsafe-storage")
        if POSIX and (fst.st_uid != os.geteuid() or _others_writable(fst)):
            raise ReviewError("unsafe-storage")
        return _read_fd(fd, limit)
    finally:
        os.close(fd)


def _fsync_fd(fd: int) -> None:
    try:
        os.fsync(fd)
    except OSError as exc:
        raise ReviewError("unavailable") from exc


def _fsync_path(path: str, profile: str) -> None:
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
    _check_ancestors(path, profile)
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        fd = _open_nofollow(path, flags)
    except ReviewError:
        if os.name == "nt":
            return
        raise
    try:
        try:
            os.fsync(fd)
        except OSError:
            if os.name == "nt":
                return
            raise ReviewError("unavailable") from None
    finally:
        os.close(fd)


def _ensure_helper_dir(path: str, profile: str) -> None:
    if not _under(path, profile):
        raise ReviewError("unsafe-storage")
    parent = os.path.dirname(path)
    _check_ancestors(parent, profile)
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise ReviewError("unsafe-storage") from exc
    if POSIX and hasattr(os, "chmod"):
        with suppress(OSError):
            os.chmod(path, 0o700)
    st = _lstat(path)
    if _is_link(st) or not stat.S_ISDIR(st.st_mode):
        raise ReviewError("unsafe-storage")
    if POSIX:
        if st.st_uid != os.geteuid():
            raise ReviewError("unsafe-storage")
        if (st.st_mode & 0o077) != 0:
            try:
                os.chmod(path, 0o700)
            except OSError as exc:
                raise ReviewError("unsafe-storage") from exc
            st = _lstat(path)
            if (st.st_mode & 0o077) != 0 or st.st_uid != os.geteuid():
                raise ReviewError("unsafe-storage")
    _check_ancestors(path, profile)


def _atomic_write(profile: str, path: str, data: bytes, mode: int = 0o600) -> None:
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


def _unlink_if_digest(profile: str, path: str, digest: str, *, missing_ok: bool) -> None:
    data = _safe_read(profile, path, missing_ok=True)
    if data is None:
        if missing_ok:
            return
        raise ReviewError("unavailable")
    if _sha(data) != digest:
        raise ReviewError("conflict")
    st = _lstat(path)
    try:
        os.unlink(path)
    except FileNotFoundError:
        if missing_ok:
            return
        raise ReviewError("unavailable") from None
    except OSError as exc:
        raise ReviewError("unavailable") from exc
    try:
        later = os.lstat(path)
    except FileNotFoundError:
        return
    if _same_inode(st, later):
        raise ReviewError("conflict")


@contextmanager
def _silence_stdio() -> Iterator[None]:
    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
    except OSError:
        yield
        return
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
    for key in PROVIDER_KEYS:
        if key not in section:
            continue
        value = section[key]
        if value is None:
            continue
        if isinstance(value, str) and value.strip().lower() in BUILTIN_PROVIDERS:
            continue
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
    if command not in ("list", "preview", "decide"):
        raise ReviewError("invalid")
    if command == "list" and any(k in req for k in ("id", "expectedDigest", "decision")):
        raise ReviewError("invalid")
    if command != "list" and "cursor" in req:
        raise ReviewError("invalid")
    if command == "preview" and any(k in req for k in ("expectedDigest", "decision")):
        raise ReviewError("invalid")
    if command in ("preview", "decide") and "id" not in req:
        raise ReviewError("invalid")
    if command == "decide" and not all(k in req for k in ("expectedDigest", "decision")):
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
    ctx.cursor = _norm_hex(req["cursor"], 8) if "cursor" in req else None
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


def _created_at(obj: Dict[str, Any]) -> Optional[float]:
    present = [(k, obj[k]) for k in ("created_at", "createdAt", "ts") if k in obj]
    if not present:
        return None
    values = [v for _, v in present]
    first = values[0]
    if any(v != first for v in values):
        raise ReviewError("unsupported")
    if isinstance(first, bool) or not isinstance(first, (int, float)):
        raise ReviewError("unsupported")
    if first != first or first in (float("inf"), float("-inf")):
        raise ReviewError("unsupported")
    return first


def _reject_new_text(ctx: Ctx, text: str) -> None:
    if not isinstance(text, str):
        raise ReviewError("invalid")
    if ctx.ENTRY_DELIMITER in text:
        raise ReviewError("blocked-content")
    for ch in text:
        o = ord(ch)
        if (o < 32 and ch not in "\t\n") or o == 127:
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
        elif old_text is not ABSENT:
            raise ReviewError("unsupported")
    else:
        if content is not ABSENT:
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
        elif old_text is not ABSENT:
            raise ReviewError("unsupported")
    else:
        if content is not ABSENT:
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
    if not isinstance(obj, dict):
        raise ReviewError("unsupported")
    if set(obj.keys()) - PENDING_TOP:
        raise ReviewError("unsupported")
    if "payload" not in obj or not isinstance(obj["payload"], dict):
        raise ReviewError("unsupported")
    body_id = obj.get("id", file_id)
    if body_id is not None:
        if not isinstance(body_id, str):
            raise ReviewError("unsupported")
        if body_id.strip().lower() != file_id:
            raise ReviewError("conflict")
    origin = obj.get("origin")
    if origin not in ORIGINS:
        raise ReviewError("unsupported")
    if "kind" in obj and obj["kind"] not in KINDS:
        raise ReviewError("unsupported")
    if "status" in obj and obj["status"] not in STATUSES:
        raise ReviewError("unsupported")
    created = _created_at(obj)
    if created is None:
        raise ReviewError("unsupported")
    payload = _norm_payload(ctx, obj["payload"])
    return {
        "id": file_id,
        "origin": origin,
        "createdAt": created,
        "payload": payload,
        "action": payload["action"],
        "target": payload["target"],
        "pendingDigest": _sha(data),
        "operationCount": len(payload["operations"]) if payload["action"] == "batch" else 1,
    }


def _round_trip(ctx: Ctx, raw: str, limit: int) -> List[str]:
    parsed = ctx.MemoryStore._parse_entries(raw)
    unique = list(dict.fromkeys(parsed))
    if len(unique) != len(parsed):
        raise ReviewError("conflict")
    if raw.strip() and raw.strip() != ctx.ENTRY_DELIMITER.join(parsed):
        raise ReviewError("conflict")
    if parsed and max(map(len, parsed)) > limit:
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
            if raw.strip() and raw.strip() != delimiter.join(parsed):
                return {"success": False, "error": "drift"}
            if parsed and max(map(len, parsed)) > self._char_limit(target):
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
        return data.decode("utf-8-sig")
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
    return _sha(_canonical(payload).encode("ascii"))


def _receipt_body(rec: Dict[str, Any]) -> Dict[str, Any]:
    return {k: rec[k] for k in RECEIPT_KEYS if k != "mac"}


def _sign_receipt(ctx: Ctx, rec: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(rec)
    out["mac"] = _hmac_hex(ctx.key, _canonical(_receipt_body(out)).encode("ascii"))
    return out


def _verify_receipt(ctx: Ctx, obj: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(obj, dict) or tuple(sorted(obj.keys())) != tuple(sorted(RECEIPT_KEYS)):
        return None
    if obj.get("version") != 1:
        return None
    mac = obj.get("mac")
    if not isinstance(mac, str) or not HEX64.match(mac.lower()):
        return None
    expected = _hmac_hex(ctx.key, _canonical(_receipt_body(obj)).encode("ascii"))
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
    if obj.get("id") != ctx.req_id and ctx.req_id is not None and obj.get("id") not in (None, obj.get("id")):
        return None
    if not isinstance(obj.get("createdAt"), (int, float)) or isinstance(obj.get("createdAt"), bool):
        return None
    if not isinstance(obj.get("at"), (int, float)) or isinstance(obj.get("at"), bool):
        return None
    if not isinstance(obj.get("operationCount"), int) or isinstance(obj.get("operationCount"), bool):
        return None
    if not isinstance(obj.get("charLimit"), int) or isinstance(obj.get("charLimit"), bool):
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
    if verified is None:
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
    with ctx.MemoryStore._file_lock(lock_target):
        yield


@contextmanager
def _target_lock(ctx: Ctx, target: str, *, required: bool) -> Iterator[None]:
    path = ctx.MemoryStore._path_for(target)
    parent = str(path.parent)
    exists_parent = False
    exists_file = False
    try:
        pst = os.lstat(parent)
        exists_parent = stat.S_ISDIR(pst.st_mode) and not _is_link(pst)
    except FileNotFoundError:
        exists_parent = False
    try:
        fst = os.lstat(str(path))
        exists_file = stat.S_ISREG(fst.st_mode) and not _is_link(fst)
    except FileNotFoundError:
        exists_file = False
    if not exists_parent and not exists_file and not required:
        yield
        return
    with ctx.MemoryStore._file_lock(path):
        yield


def _scan_dir(path: str, profile: str, remaining: List[int]) -> List[str]:
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
                    try:
                        if ent.is_symlink():
                            raise ReviewError("unsafe-storage")
                    except OSError as exc:
                        raise ReviewError("unsafe-storage") from exc
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
    }


def _classify(ctx: Ctx, item_id: str) -> Dict[str, Any]:
    receipt = _read_receipt(ctx, item_id)
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
        })
        return item
    if receipt is not None and receipt.get("phase") == "final":
        if pending is not None and pending["pendingDigest"] != receipt["pendingDigest"]:
            return _item_shell(item_id, "recovery-required")
        if pending_err is not None and pending_bytes is not None:
            return _item_shell(item_id, "recovery-required")
        item = _item_shell(item_id, receipt["state"])
        item.update({
            "action": receipt.get("action"),
            "target": receipt.get("target"),
            "origin": receipt.get("origin"),
            "createdAt": receipt.get("createdAt"),
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
    classified = [_classify(ctx, i) for i in ids]
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
    rec = _load_pending(ctx, item_id, missing_ok=False)
    if rec is None:
        raise ReviewError("unavailable")
    with _target_lock(ctx, rec["target"], required=False):
        rec = _load_pending(ctx, item_id, missing_ok=False)
        if rec is None:
            raise ReviewError("unavailable")
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
        "at": time.time(),
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
    ctx.MemoryStore._write_file(path, entries)
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
    if changed:
        _write_memory(ctx, live["target"], store.intended_entries or [], after)
    return _finalize_applied(ctx, live, preview_now, missing_pending_ok=False)


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
        if pending is not None:
            _finish_remove_pending(ctx, pending, missing_ok=True)
        return _decide_result(receipt)
    if pending is None and (receipt is None or receipt.get("phase") != "intent"):
        raise ReviewError("unavailable")
    target = (pending or receipt)["target"]  # type: ignore[index]
    with _target_lock(ctx, target, required=ctx.decision == "approve"):
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
        before = _read_memory(ctx, pending["target"])
        if receipt is not None and receipt.get("phase") == "intent":
            return _recover_intent(ctx, pending, receipt, before)
        preview = _preview_state(ctx, pending, before)
        if preview["reviewDigest"] != ctx.expected_digest:
            raise ReviewError("stale-review")
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
        if changed:
            _write_memory(ctx, pending["target"], store.intended_entries or [], after)
        return _finalize_applied(ctx, pending, preview, missing_pending_ok=False)
    raise ReviewError("unavailable")


def _dispatch(ctx: Ctx) -> Dict[str, Any]:
    _import_native(ctx)
    with _review_lock(ctx):
        if ctx.command == "list":
            return _cmd_list(ctx)
        if ctx.command == "preview":
            return _cmd_preview(ctx)
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
        ctx = _parse_request(req)
        result = _dispatch(ctx)
        _emit({"ok": True, "result": result})
        return 0
    except ReviewError as exc:
        _emit({"ok": False, "code": exc.code})
        return 1
    except Exception:
        _emit({"ok": False, "code": "unavailable"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
