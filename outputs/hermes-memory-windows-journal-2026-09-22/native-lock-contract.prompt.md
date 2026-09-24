Source-only bounded Windows locking contract review. No tools/web/subagents/source access. Return concrete issues only; this is not native Windows verification. Review this ONE contract: exclusive byte0 locking interoperating with an existing Python msvcrt.locking user, plus exact missing-file classification for lock initialization. No general storage/UI/ACL design review.

Actual admitted upstream _file_lock:
lock_path = path.with_suffix(path.suffix + ".lock")
flags = os.O_RDWR | os.O_CREAT
raw_fd = os.open(lock_path, flags, 0o600)
if hasattr(os,"fchmod"): os.fchmod(raw_fd,0o600)
with os.fdopen(raw_fd,"r+",encoding="utf-8") as fd:
  fd.seek(0)
  msvcrt.locking(fd.fileno(), msvcrt.LK_LOCK, 1)
  try: yield
  finally:
    with suppress(OSError):
      fd.seek(0); msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)

Our proposed owned adapter (no upstream changes; product Windows holds remain):
- Caller pins/verifies every directory from drive root through parent, protects profile root, verifies each child's actual ACL/identity. Special lock file is either OPEN_EXISTING or CREATE_NEW with explicit protected current-user/SYSTEM ACL installed via SECURITY_ATTRIBUTES before content. Initial lock may be empty; never write a dummybyte or truncate. Source-file ordinary IO handle policy remains unchanged.
- Lock HANDLE has GENERIC_READ|GENERIC_WRITE|READ_CONTROL|FILE_READ_ATTRIBUTES, FILE_SHARE_READ|FILE_SHARE_WRITE, no FILE_SHARE_DELETE, synchronous FILE_FLAG_OPEN_REPARSE_POINT. Verify regular file, no reparse, linkcount1, stable volume/file-index/creation identity, local fixed NTFS, effective private ACL. No path-based fd reopen, no CRT handle conversion, no temp-lock rename.
- New fixed code not-found ONLY when CreateFileW OPEN_EXISTING fails with native ERROR_FILE_NOT_FOUND=2. ERROR_PATH_NOT_FOUND=3, access denied, sharing violation and other failures stay unavailable. All ancestors already pinned so no-parent absence must never be mistaken for an empty target. For lock creation: openexisting->not-found->CREATE_NEW; on ERROR_FILE_EXISTS80/ALREADY_EXISTS183, reopenexisting exactly once and verify the winner. No ACL repair.
- LockFileEx uses flags LOCKFILE_EXCLUSIVE_LOCK(2)|LOCKFILE_FAIL_IMMEDIATELY(1), dwReserved0, lenLow1,lenHigh0, zeroed OVERLAPPED Offset0,OffsetHigh0,hEventNULL. Synchronous HANDLE, no OVERLAPPED createflag. If false+ERROR_LOCK_VIOLATION33: retry every<=25ms against time.monotonic deadline (default1000ms,max10000ms); all other errors fixedunavailable. No busy wait/unbounded blocking. A final checked call is not issued after deadline; timeout fixedunavailable. On success immediately recordheld before re-verifying metadata/ACL so later failure stillreleases.
- UnlockFileEx must match sameHANDLE, byte0,len1, zeroreserved, zeroOVERLAPPED; false returnsfixedunavailable and state remainsheld. Contextmanager finally attempts unlock thencheckedclose; native close releases remaining locks but doesnot erase/unreport failedexplicitunlock. No rawpath/SID/data/Win32error text exposed. A closefailure never marksreleased. Parentlock/body exceptions similarly fixed. Context holds pinned ancestry throughout.

Official primary requirements already read:
https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex : required OVERLAPPED offset,event; FAIL_IMMEDIATELY avoids waiting; exclusivebyte ranges; beyondEOF is legal; closing/processdeath releases locks with timing caveat; mappedviews notblocked.
https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-unlockfileex : unlock exactlockedrange; checkBOOL; locksreleased beforeCloseHandlefinishes.
https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/locking?view=msvc-170 : CRT lockstarts atcurrentfilepositionfornbytes; LK_LOCK repeats10timesone-secondintervals, LK_NBLCK doesnotretry. Real cross-processWindows interoperability still requires acceptance evidence; do not infer it from source.

Question: Is there a demonstrable Win32/CRT contract bug in the proposed HANDLE/flags/range/error/release protocol that must change before implementation? Also distinguish gaps requiring real Windows acceptance from concrete errors. Do not redesign the whole system or invent undocumented guarantees. Return verdict, findings(location,trigger,fix), and remaining nativeWindowsproof requirements. Output only final structured answer, no hidden reasoning.
