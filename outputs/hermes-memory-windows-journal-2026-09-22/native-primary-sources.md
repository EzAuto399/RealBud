# Native journal primitive evidence — 2026-09-22

Implementation remains unadmitted on Windows. These references support the API design; they do not replace execution on Windows.

- [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex): immediate exclusive locking flags, byte-range offset in OVERLAPPED, beyond-EOF locks, handle-based ownership. The implementation requests exactly byte zero, length one, on a synchronous handle and explicitly bounds retry time.
- [UnlockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-unlockfileex): exact range release and checked BOOL result. The implementation does not suppress a failed release.
- [CRT _locking](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/locking?view=msvc-170): the range starts at the descriptor's current position and may extend beyond EOF. The admitted Hermes memory_tool_store.py `_file_lock` (lines145–182) seeks to zero and uses msvcrt LK_LOCK/LK_UNLCK for one byte. No upstream file was edited. Cross-process interoperability is a native acceptance gate.
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): creation disposition, desired access, sharing, explicit security attributes and reparse-point opening. Lock handles are a separate read/write-sharing case; all handles continue to deny delete sharing.
- [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex): pinned-handle directory query. No pathname enumeration fallback is used.
- [FILE_INFO_BY_HANDLE_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ne-minwinbase-file_info_by_handle_class): FileIdBothDirectoryRestartInfo starts each enumeration; FileIdBothDirectoryInfo continues the same handle.
- [FILE_ID_BOTH_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info): relative record offsets and UTF16 names. The parser bounds buffer offsets, name bytes, alignment, record counts and pagination.

Portable validation: 19 raw ctypes fixture checks, 19 policy checks, 33 protocol checks passed. They include malformed records, distinct missing-parent failures, private lock and directory creation, bounded acquisition, checked release, caller exception preservation, digest flush checks, and deletion reconciliation. See `native-verification.json` for exact source hashes.

The one requested Grok4.7/xhigh contract review used a 4,404-byte prompt, no tools/web/subagents, max one turn and a hard600-second deadline. It timed out without structured output. `native-lock-contract-receipt.json` records an incomplete review, not an approval. No retry was performed.
