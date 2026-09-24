Review this bounded Windows persistence design. No tools, browsing, shell, subagents, code edits, or further turns. Use only this packet; state uncertainty. Return concise structured findings and recommendation, not reasoning traces. Focus on minimum operations and concrete correctness, not a generic security backlog.

RealBud owns a signed human approval journal around admitted Hermes native memory. Proposal alone cannot change memory. Exact approved digest creates signed intent before memory replacement, then signed final receipt, then exact pending cleanup. Recovery validates context and before/after digests. Files must be regular, one hardlink, private ACL, no reparse ancestors. Windows feature remains held. No Windows execution proof exists. No copy/truncate fallback permitted.

Official Microsoft docs read today (paraphrased, URLs for provenance, do not fetch):
D1 https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
With SetFileInformationByHandle(FileRenameInfo), ReplaceIfExists=false fails if target exists; true replaces it. RootDirectory can be a directory HANDLE resolving relative FileName. FileNameLength is UTF16 bytes. Current docs render a duplicated union member; use SDK ABI. Restrict generated name to single leaf, no slash/colon/ADS. No destination identity CAS documented.
D2 https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
Uses opened source HANDLE with appropriate access. Behavior varies by OS/filesystem. FileRenameInfo=3; FileDispositionInfo=4, DELETE access needed for disposition. No cross-file transaction/durability stated.
D3 https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
Incompatible access/share modes fail. Omitting FILE_SHARE_DELETE denies future delete-access/rename opens. CREATE_NEW fails on existing name. BACKUP_SEMANTICS opens directories. OPEN_REPARSE_POINT affects final component, not all ancestors. WRITE_THROUGH caching remarks explicitly describe NTFS flushing metadata changes including rename resulting from the request. Hardware write-through support is not universal. NO_BUFFERING adds alignment constraints. Opening existing file ignores creation SD.
D4 https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
Flushes buffers to device, needs GENERIC_WRITE. Volume flush needs admin. No documented POSIX directory-fsync equivalent.
D5 https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching
Metadata remains cached even without buffering; flush file or use write-through. Power failure losing cache differs from process exit.
D6 https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
MOVEFILE_WRITE_THROUGH says wait until move reaches disk, but explicit flush guarantee describes copy/delete. COPY_ALLOWED can copy across volumes, even succeed leaving source if delete fails. REPLACE_EXISTING is path-based. Never enable COPY_ALLOWED. Wording alone does not establish cross-file journal ordering.
D7 https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw
NTFS files, same volume. All links share file SD; link does not inherit a new destination SD. Sharing is per-file. Hardlink then unlink leaves nlink=2 if interrupted, incompatible with current admission.
D8 https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
HANDLE-bound DACL setting can propagate inheritable ACEs; explicit child ACEs remain. Sharing constraints/MAXIMUM_ALLOWED can prevent propagation. NULL DACL grants everyone access. Verify each existing child handle.
D9 https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information
PROTECTED_DACL_SECURITY_INFORMATION prevents inheritance into this object's DACL, not propagation of its own inheritable ACEs. Protected parent with safe OI/CI entries can protect newly created native children, but existing explicit grants require independent verification.
D10 https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
Volume serial plus128-bit file ID identifies the object behind two open handles. Keep source handle live; persisted ID is not permanent proof after delete/reuse.
D11 https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/locking?view=msvc-170
CRT byte lock starts at current offset, can extend beyond EOF. LK_LOCK retries at1-second intervals up to10 attempts. Sibling lock coordinates only participants using same lockfile identity.

Proposed minimum design:
A. Eventually admit tested local NTFS only. Check ancestry, pin verified parents with directory handles omitting FILE_SHARE_DELETE. This pins those directory objects, NOT child names or ACLs against same-SID peers. Reject unknown FS, remote/cloud/offline/reparse namespace absent separate evidence.
B. Private protected parent DACL before file creation; safe inheritable current SID/SYSTEM/admin per host policy. Existing child ACL checked by HANDLE. Stage via CREATE_NEW with explicit safe SD or verified private inheritance; GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL, OPEN_REPARSE_POINT|WRITE_THROUGH. Deny WRITE/DELETE sharing; READ only if needed. Validate handle type, linkcount1, volume/fileID, SD before private data. No TEMPORARY/DELETE_ON_CLOSE for recoverable state. Write all bytes, check FlushFileBuffers.
C. New immutable journal/proposal/claim: source-HANDLE SetFileInformationByHandle(FileRenameInfo), verified parent RootDirectory, generated leaf, ReplaceIfExists=false. Same volume, no fallback. Flush source HANDLE after rename; verify destination identity+HMAC. Reopening destination must have sharing compatible with existing source DELETE access (new read handle needs FILE_SHARE_DELETE); original source still denies others' DELETE access.
D. Mutable memory/final receipt: same operation with ReplaceIfExists=true under native target sibling lock + helper review lock, current digest revalidated immediately before. This is NOT target identity CAS: old-target handle denying DELETE blocks our own replacement; allowing DELETE permits uncoordinated path substitution. Conditional on cooperative native writers/private namespace. If exact target identity despite arbitrary concurrent replacements is required, consider HANDLE-claim old target into no-clobber backup then publish new no-clobber, but this adds missing-target crash state and recovery changes. Is that necessary for this scope?
E. Pending cleanup: retain DELETE+READ source handle denying WRITE/DELETE; verify exact digest/type/SD; rename that handle into no-clobber claim; verify/digest then FileDispositionInfo delete by handle. Final signed receipt survives interrupted cleanup. Recreated live name remains conflict, never blindly deleted.
F. Sharing/access failures: bounded retries with context, locks, fresh identity checks; error5 may be ACL. Preserve journal, return busy/recovery-required. Never native fallback. Ambiguous rename/flush result reconciles signed disk state. Process-kill tests at every boundary. Power loss stays separate: write-through+pre/postFlush is requested NTFS persistence, not hardware guarantee or cross-file atomic transaction. Keep Windows hold.

Questions: Is public RootDirectory+HANDLE rename valid and compatible with source deny-delete sharing/verification? Is WRITE_THROUGH+post-rename flush the smallest defensible metadata flush request? Does MoveFileExW offer a stronger same-volume guarantee worth source-path race? Do hardlinks justify extra recovery states? Are parent pin/ACL claims accurate? What exact process-crash/retry defect remains? Separate blockers, assumptions and unproved power-loss guarantees.

Actual admitted Hermes source excerpts follow. Runtime commit345cd2b057a452236de401d3534b8502a7465e8d; SHA256 checked. RealBud reuses transformation/limits/threat checks and locks but must bypass Windows persistence fallback.

tools/memory_tool_store.py:145-181; SHA256=811ef2eb98a8b3f0448294b2c23d422ff7ebd4dc45835475b12df0557d7e5366
```python
    def _file_lock(path: Path):
        """Exclusive lock on a separate .lock file so the memory file itself can
        still be atomically replaced."""
        from tools import memory_tool as _mt  # fcntl/msvcrt live (and are patched) there
        fcntl, msvcrt = _mt.fcntl, _mt.msvcrt
        lock_path = path.with_suffix(path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        if fcntl is None and msvcrt is None:
            yield
            return
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        raw_fd = os.open(lock_path, flags, 0o600)
        try:
            # The creation mode is filtered through the process umask and does
            # not repair a lock left loose by an older Hermes process. Tighten
            # the opened inode before acquiring the lock so both cases are
            # owner-only. Operating on the fd avoids a path-swap window.
            if hasattr(os, "fchmod"):
                os.fchmod(raw_fd, 0o600)
            fd = os.fdopen(raw_fd, "r+", encoding="utf-8")
        except Exception:
            os.close(raw_fd)
            raise
        with fd:
            def _flock(unlock: bool):
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX)
                else:
                    fd.seek(0)
                    msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK if unlock else msvcrt.LK_LOCK, 1)
            _flock(False)
            try:
                yield
            finally:
                with suppress(OSError):
```

tools/memory_tool_store.py:418-425; SHA256=811ef2eb98a8b3f0448294b2c23d422ff7ebd4dc45835475b12df0557d7e5366
```python
    def _write_file(path: Path, entries: List[str]):
        """Atomic temp-file + rename: readers never see a truncated file. Also used by
        agent/learning_mutations.py."""
        try:
            atomic_write_text(path, ENTRY_DELIMITER.join(entries), tmp_prefix=".mem_")
        except OSError as e:
            raise RuntimeError(f"Failed to write memory file {path}: {e}")

```

utils.py:99-216; SHA256=1414f177e14940750ad80d6dd5020685219ca26b0b7d500299ab2f170118ed07
```python
# Windows rename failures possibly caused by another handle on the target. CPython opens files
# without FILE_SHARE_DELETE, so ``os.replace`` onto an open file is denied with 5 ERROR_ACCESS_DENIED
# (what a held *target* handle actually reports — measured: a plain reader yields 5, NOT 32),
# 32 ERROR_SHARING_VIOLATION (the *source* temp file is held) or 33 ERROR_LOCK_VIOLATION (byte-range
# lock on the target). Ambiguous (a real ACL denial is also 5), so recovery is bounded and a
# still-failing write is re-raised unchanged rather than classified up front.
_WINDOWS_CONTENDED_REPLACE_ERRORS = frozenset({5, 32, 33})
# Retry budget for the atomic rename. A rename that wins here keeps the write fully atomic, so the
# budget covers a realistic hold (desktop auth-init holds auth.json >100 ms): ~200 ms recovered
# atomically, ~310 ms worst case. The cap matters as much as the count — gateway_state.json is
# rewritten every turn, so a permanently-held target pays the full budget per write. Jittered so
# concurrent writers don't retry in lockstep.
_REPLACE_RETRY_ATTEMPTS = 4
_REPLACE_RETRY_BASE_DELAY_S = 0.02
_REPLACE_RETRY_MAX_DELAY_S = 0.1
_CROSS_DEVICE_ERRNOS = (errno.EXDEV, errno.EBUSY)


def _is_contended_windows_replace_error(exc: OSError) -> bool:
    """Candidate-only: winerror 5 also covers a genuine ACL denial."""
    return _IS_WINDOWS and getattr(exc, "winerror", None) in _WINDOWS_CONTENDED_REPLACE_ERRORS


def _rewrite_in_place(tmp_str: str, real_path: str) -> None:
    """Overwrite *real_path* through the existing file — last resort for a still-held target.

    Not atomic (a smaller window than a copy, not none), so it runs only after the rename has
    genuinely failed. Writing through the target also preserves its ACL, which ``os.replace``
    does not (the temp file's inherited ACL wins there).
    """
    with open(tmp_str, "rb") as src:
        data = src.read()
    fd = os.open(real_path, os.O_WRONLY | getattr(os, "O_BINARY", 0))
    try:
        written = 0
        while written < len(data):
            written += os.write(fd, data[written:])
        os.ftruncate(fd, len(data))
        with suppress(OSError):
            os.fsync(fd)
    finally:
        os.close(fd)
    os.unlink(tmp_str)


def _copy_fallback(tmp_str: str, real_path: str) -> None:
    """Copy/fsync/unlink fallback for cross-device and bind-mount renames."""
    shutil.copyfile(tmp_str, real_path)
    with suppress(OSError):
        shutil.copystat(tmp_str, real_path)
    with suppress(OSError), open(real_path, "rb") as f:
        os.fsync(f.fileno())
    os.unlink(tmp_str)


def atomic_replace(tmp_path: Union[str, Path], target: Union[str, Path]) -> str:
    """Atomically move *tmp_path* onto *target*, preserving symlinks.

    Resolves a symlink first so ``os.replace`` writes the real file in place and the symlink
    survives. Otherwise identical to ``os.replace`` unless the rename fails with EXDEV/EBUSY
    (cross-device, bind-mount, busy file: copy/fsync/unlink immediately — these never clear on
    retry) or a Windows rename contended by another open handle (winerror 5/32/33: bounded retry,
    then in-place rewrite).
    """
    target_str = str(target)
    real_path = os.path.realpath(target_str) if os.path.islink(target_str) else target_str
    tmp_str = str(tmp_path)
    try:
        os.replace(tmp_str, real_path)
        return real_path
    except OSError as exc:
        contended = _is_contended_windows_replace_error(exc)
        if exc.errno not in _CROSS_DEVICE_ERRNOS and not contended:
            raise
        if contended:
            # Lazy: keeps ``utils`` free of a package-level dependency on ``agent``.
            from agent.retry_utils import jittered_backoff
            for attempt in range(1, _REPLACE_RETRY_ATTEMPTS + 1):
                time.sleep(jittered_backoff(attempt, base_delay=_REPLACE_RETRY_BASE_DELAY_S, max_delay=_REPLACE_RETRY_MAX_DELAY_S))
                try:
                    os.replace(tmp_str, real_path)
                    return real_path
                except OSError as retry_exc:
                    exc = retry_exc
                    if retry_exc.errno in _CROSS_DEVICE_ERRNOS:
                        contended = False  # not contention after all — stop burning the budget
                        break
                    if not _is_contended_windows_replace_error(retry_exc):
                        raise
        logger.debug("atomic_replace: %s -> %s failed with %s; falling back to %s", tmp_str, real_path,
                     getattr(exc, "winerror", None) or errno.errorcode.get(exc.errno or 0, exc.errno),
                     "in-place rewrite" if contended else "copy")
        # The rewrite re-raises its own error, so an ACL denial is reported as such, not as contention.
        (_rewrite_in_place if contended else _copy_fallback)(tmp_str, real_path)
    return real_path


def fsync_directory(path: Union[str, Path]) -> None:
    """Best-effort fsync of a directory entry so a just-renamed file survives power loss.

    No-op on Windows (directories can't be opened with ``os.open``; the file fsync still applies)
    and on any OSError — durability of the directory entry is never worth failing a write that
    has already been replaced into place.
    """
    if os.name == "nt":
        return
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        with suppress(OSError):
            os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, write, *, prefix: str, encoding: str = "utf-8", mode: "int | None" = None,
```

tools/write_approval.py:73-89; SHA256=9404792bc8c6637e5bd78a87f5a6dfabda6cd6a1a61083b450647ddb2951c470
```python
def stage_write(subsystem: str, payload: Dict[str, Any], *, summary: str, origin: str) -> Dict[str, Any]:
    """Persist a pending write and return its record (``id`` + metadata). ``payload`` is the exact
    kwargs to replay the write on approval; ``origin`` is ``foreground`` or ``background_review``.
    Best-effort: on disk failure it logs and still returns a record — the write is lost, which is
    the safe failure for an approval gate (nothing silently committed)."""
    pid = uuid.uuid4().hex[:8]
    record = {
        "id": pid, "subsystem": subsystem, "action": payload.get("action", ""),
        "summary": (summary or "").strip(), "origin": origin or "foreground",
        "created_at": time.time(), "payload": payload,
    }
    try:
        atomic_json_write(_pending_path(subsystem, pid), record)
    except Exception as e:  # pragma: no cover - disk failure path
        logger.error("Failed to stage pending %s write: %s", subsystem, e, exc_info=True)
    return record

```

RealBud integration: _review_lock invokes native MemoryStore._file_lock(reviews/review); _target_lock invokes same native method on MEMORY.md/USER.md. _write_memory currently invokes native _write_file then fsync; Windows branch must persist already-native-rendered after bytes through strict own writer. stage_write does not use review lock and can return a record after failure. Signed journal contains workspace/profile/runtime, decision, pending/config/before/after/review digests, phase=intent|final. Recovery matches exact before/after, conflicts blocked.
