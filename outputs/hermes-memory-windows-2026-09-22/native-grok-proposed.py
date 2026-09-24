"""Windows object-handle foundation for RealBud private memory files.

Caller obligation: pin every ancestor directory handle before using these
object opens. FILE_SHARE_DELETE is excluded on the leaf only; that does not
protect parent path components. Path strings never replace ancestor pins.

Supported here: NTFS, FILE_PERSISTENT_ACLS, DRIVE_FIXED, same-volume
identity. No ReFS/SMB/FAT/removable claim. No rename, atomic replace,
hardlink, publication, delete, ACL repair, or provider features.

Safety limits: bounded synchronous IO (<=131072 bytes); CREATE_NEW / open-
existing only; flush is a file FlushFileBuffers, not directory durability,
rename atomicity, or power-loss safety. Not wired into the helper.
"""
from __future__ import annotations

import ctypes
import re
import sys
from ctypes import byref
from dataclasses import dataclass

# CreateFileW https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
# GetSecurityInfo https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo
# GetSecurityDescriptorControl https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getsecuritydescriptorcontrol
# GetAce https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getace
# GetFileInformationByHandle https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle
# GetFinalPathNameByHandleW https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
# GetVolumeInformationByHandleW https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew
# GetTokenInformation https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation
# SECURITY_ATTRIBUTES https://learn.microsoft.com/en-us/windows/win32/api/wtypesbase/ns-wtypesbase-security_attributes
# ConvertStringSecurityDescriptorToSecurityDescriptorW https://learn.microsoft.com/en-us/windows/win32/api/sddl/nf-sddl-convertstringsecuritydescriptortosecuritydescriptorw
# FlushFileBuffers https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers

DWORD = ctypes.c_uint32
BOOL = ctypes.c_int32
WORD = ctypes.c_uint16
BYTE = ctypes.c_ubyte
HANDLE = ctypes.c_void_p
WCHAR = ctypes.c_wchar
LPCWSTR = ctypes.c_wchar_p

_BS = chr(92)
_EXT_DOS = _BS + _BS + '?' + _BS
_DEV_NS = _BS + _BS + '.' + _BS
_EXT_UNC = _EXT_DOS + 'UNC' + _BS
_CODES = frozenset({'unavailable', 'unsafe-storage', 'conflict', 'capacity', 'invalid'})
_MAX_IO = 131072
_MAX_WCHARS = 32767
_MAX_ACL = 65536
_MAX_TOKEN = 65536
_FA = 0x001F01FF
_GEN_ALL = 0x10000000
_GEN_READ = 0x80000000
_GEN_WRITE = 0x40000000
_GEN_EXEC = 0x20000000
_FILE_GENERIC_READ = 0x00120089
_FILE_GENERIC_WRITE = 0x00120116
_FILE_GENERIC_EXECUTE = 0x001200A0
_INHERIT_ONLY = 0x8
_INHERITED = 0x10
_VALID_ACE_FLAGS = 0x1 | 0x2 | 0x4 | 0x8 | 0x10
_ATTR_DIR = 0x10
_ATTR_REPARSE = 0x400
_ATTR_DEVICE = 0x40
_DRIVE_FIXED = 3
_PERSISTENT_ACLS = 0x8
_SYS = 'S-1-5-18'
_ADMINS = 'S-1-5-32-544'
_SID_RE = re.compile('^S-1-5(-[0-9]+){1,14}$')
_HANDLE_NEW = object()
_PROTO = (
    'current_user_sid', 'open_file', 'create_directory', 'file_identity',
    'security_info', 'seek_start', 'read', 'write', 'flush', 'close',
)
_RESERVED = frozenset(
    {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$'}
    | {'COM%d' % i for i in range(10)}
    | {'LPT%d' % i for i in range(10)}
)

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
READ_CONTROL = 0x00020000
FILE_READ_ATTRIBUTES = 0x80
FILE_SHARE_READ = 0x1
FILE_SHARE_WRITE = 0x2
CREATE_NEW = 1
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x80
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_TYPE_DISK = 1
FILE_NAME_NORMALIZED = 0x8
VOLUME_NAME_DOS = 0x0
SE_FILE_OBJECT = 1
OWNER_SECURITY_INFORMATION = 0x1
DACL_SECURITY_INFORMATION = 0x4
SE_DACL_PRESENT = 0x4
SE_DACL_PROTECTED = 0x1000
TOKEN_QUERY = 0x8
TokenUser = 1
FILE_BEGIN = 0
SDDL_REVISION_1 = 1
ERROR_FILE_NOT_FOUND = 2
ERROR_PATH_NOT_FOUND = 3
ERROR_ACCESS_DENIED = 5
ERROR_HANDLE_DISK_FULL = 39
ERROR_SHARING_VIOLATION = 32
ERROR_FILE_EXISTS = 80
ERROR_DISK_FULL = 112
ERROR_INSUFFICIENT_BUFFER = 122
ERROR_ALREADY_EXISTS = 183
ERROR_NO_TOKEN = 1008


def _fail(code: str) -> None:
    raise NativeError(code) from None


def _safe(fn):
    def wrapped(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except NativeError:
            raise
        except Exception:
            raise NativeError('unavailable') from None
    wrapped.__name__ = fn.__name__
    wrapped.__qualname__ = fn.__qualname__
    return wrapped


class NativeError(Exception):
    __slots__ = ('code',)

    def __init__(self, code: object = 'unavailable') -> None:
        if code not in _CODES:
            code = 'unavailable'
        self.code = code
        super().__init__(code)

    def __str__(self) -> str:
        return self.code

    def __repr__(self) -> str:
        return 'NativeError(%r)' % (self.code,)


@dataclass(frozen=True, repr=False)
class Ace:
    ace_type: int
    flags: int
    mask: int
    sid: str

    def __repr__(self) -> str:
        return 'Ace()'


@dataclass(frozen=True, repr=False)
class SecurityInfo:
    owner: str
    protected: bool
    dacl_present: bool
    aces: tuple[Ace, ...]

    def __repr__(self) -> str:
        return 'SecurityInfo()'


@dataclass(frozen=True, repr=False)
class FileIdentity:
    volume_serial: int
    file_index: int
    attributes: int
    links: int
    size: int
    creation_ticks: int
    last_write_ticks: int
    final_path: str
    filesystem: str
    volume_flags: int
    drive_type: int

    def __repr__(self) -> str:
        return 'FileIdentity()'


class Handle:
    __slots__ = (
        '_owner', '_token', '_raw', '_canon', '_kind', '_writable', '_created',
        '_closed', '_write_attempted', '_private_root',
    )

    def __init__(self, token: object, owner: object, raw: int, kind: str, writable: bool, created: bool) -> None:
        if token is not _HANDLE_NEW or owner is None:
            _fail('invalid')
        self._owner = owner
        self._token = owner._token
        self._raw = raw
        self._canon = None
        self._kind = kind
        self._writable = writable
        self._created = created
        self._closed = False
        self._write_attempted = False
        self._private_root = None

    def __repr__(self) -> str:
        st = 'closed' if self._closed else 'open'
        return 'Handle(%s, %s)' % (self._kind, st)

    def __enter__(self) -> Handle:
        if self._closed:
            _fail('invalid')
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def close(self) -> None:
        owner = self._owner
        if not isinstance(owner, Win32Native):
            _fail('invalid')
        owner.close(self)


class FILETIME(ctypes.Structure):
    _pack_ = 4
    _fields_ = [('dwLowDateTime', DWORD), ('dwHighDateTime', DWORD)]


class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('dwFileAttributes', DWORD),
        ('ftCreationTime', FILETIME),
        ('ftLastAccessTime', FILETIME),
        ('ftLastWriteTime', FILETIME),
        ('dwVolumeSerialNumber', DWORD),
        ('nFileSizeHigh', DWORD),
        ('nFileSizeLow', DWORD),
        ('nNumberOfLinks', DWORD),
        ('nFileIndexHigh', DWORD),
        ('nFileIndexLow', DWORD),
    ]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ('nLength', DWORD),
        ('lpSecurityDescriptor', ctypes.c_void_p),
        ('bInheritHandle', BOOL),
    ]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [('Sid', ctypes.c_void_p), ('Attributes', DWORD)]


class TOKEN_USER(ctypes.Structure):
    _fields_ = [('User', SID_AND_ATTRIBUTES)]


class ACL(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('AclRevision', BYTE), ('Sbz1', BYTE), ('AclSize', WORD),
        ('AceCount', WORD), ('Sbz2', WORD),
    ]


class ACE_HEADER(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('AceType', BYTE), ('AceFlags', BYTE), ('AceSize', WORD)]


def _need_int(n: object, hi: int, code: str = 'unsafe-storage') -> int:
    if isinstance(n, bool) or not isinstance(n, int) or n < 0 or n > hi:
        _fail(code)
    return n


def _valid_sid_str(s: object) -> bool:
    return isinstance(s, str) and 5 <= len(s) <= 256 and _SID_RE.fullmatch(s) is not None


def _reserved_comp(comp: str) -> bool:
    u = comp.upper()
    if u in _RESERVED:
        return True
    return u.split('.', 1)[0] in _RESERVED


def _drive_case(path: str) -> str:
    chars = list(path)
    if path.startswith(_EXT_DOS) and len(path) >= 6:
        chars[4] = chars[4].upper()
    elif len(path) >= 1:
        chars[0] = chars[0].upper()
    return ''.join(chars)


def _validate_dos_path(path: object) -> str:
    if not isinstance(path, str) or not path or len(path) >= _MAX_WCHARS:
        _fail('invalid')
    if any(ord(c) < 32 for c in path):
        _fail('invalid')
    if '/' in path:
        _fail('invalid')
    low = path.upper()
    if path.startswith(_DEV_NS) or low.startswith(_EXT_UNC.upper()):
        _fail('invalid')
    if path.startswith(_BS + _BS) and not path.startswith(_EXT_DOS):
        _fail('invalid')
    rest = path[4:] if path.startswith(_EXT_DOS) else path
    if len(rest) < 4 or rest[1] != ':' or rest[2] != _BS:
        _fail('invalid')
    drive = rest[0]
    if not ('A' <= drive <= 'Z' or 'a' <= drive <= 'z'):
        _fail('invalid')
    if ':' in rest[2:]:
        _fail('invalid')
    tail = rest[3:]
    if not tail or tail.endswith(_BS) or tail.endswith(' '):
        _fail('invalid')
    for ch in '<>"|?*':
        if ch in tail:
            _fail('invalid')
    parts = tail.split(_BS)
    if '' in parts:
        _fail('invalid')
    for comp in parts:
        if comp in ('.', '..') or comp.endswith('.') or comp.endswith(' ') or _reserved_comp(comp):
            _fail('invalid')
    return path


def _split_parts(path: str) -> tuple[str, tuple[str, ...]]:
    p = _drive_case(path)
    if p.startswith(_EXT_DOS):
        p = p[4:]
    rest = p[3:] if len(p) > 3 else ''
    return p[0], (tuple(rest.split(_BS)) if rest else ())


def _map_generic(mask: int) -> int:
    mask &= 0xFFFFFFFF
    if mask & _GEN_ALL:
        return _FA
    out = mask & 0x01FFFFFF
    if mask & _GEN_READ:
        out |= _FILE_GENERIC_READ
    if mask & _GEN_WRITE:
        out |= _FILE_GENERIC_WRITE
    if mask & _GEN_EXEC:
        out |= _FILE_GENERIC_EXECUTE
    return out & 0xFFFFFFFF


def _file_sddl(sid: str) -> str:
    return 'O:' + sid + 'D:P(A;;FA;;;' + sid + ')(A;;FA;;;SY)'


def _dir_sddl(sid: str) -> str:
    return 'O:' + sid + 'D:P(A;OICI;FA;;;' + sid + ')(A;OICI;FA;;;SY)'


def _policy(sec: SecurityInfo, user: str, *, allow_inherited: bool) -> None:
    if not isinstance(sec, SecurityInfo) or not isinstance(sec.protected, bool) or not isinstance(sec.dacl_present, bool):
        _fail('unavailable')
    if not sec.dacl_present or (not allow_inherited and not sec.protected):
        _fail('unsafe-storage')
    if not _valid_sid_str(sec.owner) or not _valid_sid_str(user):
        _fail('unsafe-storage')
    allowed = {user, _SYS, _ADMINS}
    if sec.owner not in allowed:
        _fail('unsafe-storage')
    aces = sec.aces
    if not isinstance(aces, tuple) or not aces or len(aces) > 256:
        _fail('unsafe-storage')
    effective = 0
    for ace in aces:
        if not isinstance(ace, Ace):
            _fail('unsafe-storage')
        if ace.ace_type != 0:
            _fail('unsafe-storage')
        flags = _need_int(ace.flags, 0xFF)
        mask = _need_int(ace.mask, 0xFFFFFFFF)
        if flags & ~_VALID_ACE_FLAGS:
            _fail('unsafe-storage')
        if (not allow_inherited) and (flags & _INHERITED):
            _fail('unsafe-storage')
        if not _valid_sid_str(ace.sid) or ace.sid not in allowed:
            _fail('unsafe-storage')
        if (flags & _INHERIT_ONLY) == 0 and ace.sid == user:
            effective |= _map_generic(mask)
    if (effective & _FA) != _FA:
        _fail('unsafe-storage')


def _validate_identity(ident: object, *, directory: bool, canon: str | None) -> FileIdentity:
    if not isinstance(ident, FileIdentity):
        _fail('unavailable')
    vs = _need_int(ident.volume_serial, 0xFFFFFFFF)
    idx = _need_int(ident.file_index, 0xFFFFFFFFFFFFFFFF)
    attr = _need_int(ident.attributes, 0xFFFFFFFF)
    links = _need_int(ident.links, 0xFFFFFFFF)
    _need_int(ident.size, 0xFFFFFFFFFFFFFFFF)
    _need_int(ident.creation_ticks, 0xFFFFFFFFFFFFFFFF)
    _need_int(ident.last_write_ticks, 0xFFFFFFFFFFFFFFFF)
    vf = _need_int(ident.volume_flags, 0xFFFFFFFF)
    dt = _need_int(ident.drive_type, 0xFFFFFFFF)
    if vs == 0 or idx == 0:
        _fail('unsafe-storage')
    if not isinstance(ident.filesystem, str) or ident.filesystem != 'NTFS':
        _fail('unsafe-storage')
    if dt != _DRIVE_FIXED or (vf & _PERSISTENT_ACLS) == 0:
        _fail('unsafe-storage')
    if attr & (_ATTR_REPARSE | _ATTR_DEVICE):
        _fail('unsafe-storage')
    is_dir = (attr & _ATTR_DIR) != 0
    if is_dir != directory:
        _fail('unsafe-storage')
    if not directory and links != 1:
        _fail('unsafe-storage')
    if directory and links < 1:
        _fail('unsafe-storage')
    path = _validate_dos_path(ident.final_path)
    if canon is not None and _drive_case(path) != _drive_case(canon):
        _fail('unsafe-storage')
    return ident


def _stable(a: FileIdentity, b: FileIdentity) -> bool:
    return (
        a.volume_serial == b.volume_serial and a.file_index == b.file_index
        and a.attributes == b.attributes and a.links == b.links
        and a.size == b.size and a.creation_ticks == b.creation_ticks
        and a.last_write_ticks == b.last_write_ticks
        and _drive_case(a.final_path) == _drive_case(b.final_path)
        and a.filesystem == b.filesystem and a.volume_flags == b.volume_flags
        and a.drive_type == b.drive_type
    )


def _strict_desc(root: FileIdentity, child: FileIdentity) -> None:
    if root.volume_serial != child.volume_serial:
        _fail('unsafe-storage')
    rd, rp = _split_parts(root.final_path)
    cd, cp = _split_parts(child.final_path)
    if rd != cd or len(cp) <= len(rp) or cp[:len(rp)] != rp:
        _fail('unsafe-storage')


def _has_protocol(bindings: object) -> bool:
    return all(callable(getattr(bindings, name, None)) for name in _PROTO)


def _set_sig(fn: object, restype: object, argtypes: list) -> object:
    try:
        fn.restype = restype
        fn.argtypes = argtypes
    except (AttributeError, TypeError):
        pass
    return fn


class CtypesBindings:
    def __init__(self, kernel32: object = None, advapi32: object = None) -> None:
        try:
            if (kernel32 is None) != (advapi32 is None):
                _fail('invalid')
            if kernel32 is None:
                if sys.platform != 'win32':
                    _fail('unavailable')
                kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
                advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
            self._bind(kernel32, advapi32)
        except NativeError:
            raise
        except Exception:
            raise NativeError('unavailable') from None

    def _bind(self, k32: object, a32: object) -> None:
        def k(name, restype, argtypes):
            fn = getattr(k32, name, None)
            if fn is None:
                _fail('unavailable')
            return _set_sig(fn, restype, argtypes)

        def a(name, restype, argtypes):
            fn = getattr(a32, name, None)
            if fn is None:
                _fail('unavailable')
            return _set_sig(fn, restype, argtypes)

        P = ctypes.c_void_p
        PD = ctypes.POINTER(DWORD)
        PW = ctypes.POINTER(WORD)
        PH = ctypes.POINTER(ctypes.c_void_p)
        PI64 = ctypes.POINTER(ctypes.c_int64)
        self._CreateFileW = k('CreateFileW', HANDLE, [LPCWSTR, DWORD, DWORD, P, DWORD, DWORD, HANDLE])
        self._CreateDirectoryW = k('CreateDirectoryW', BOOL, [LPCWSTR, P])
        self._CloseHandle = k('CloseHandle', BOOL, [HANDLE])
        self._GetFileInformationByHandle = k(
            'GetFileInformationByHandle', BOOL, [HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
        )
        self._GetFileType = k('GetFileType', DWORD, [HANDLE])
        self._GetFinalPathNameByHandleW = k('GetFinalPathNameByHandleW', DWORD, [HANDLE, ctypes.c_void_p, DWORD, DWORD])
        self._GetVolumeInformationByHandleW = k(
            'GetVolumeInformationByHandleW', BOOL, [HANDLE, LPCWSTR, DWORD, PD, PD, PD, ctypes.c_void_p, DWORD]
        )
        self._GetDriveTypeW = k('GetDriveTypeW', UINT_DRIVE if False else DWORD, [LPCWSTR])
        self._ReadFile = k('ReadFile', BOOL, [HANDLE, P, DWORD, PD, P])
        self._WriteFile = k('WriteFile', BOOL, [HANDLE, P, DWORD, PD, P])
        self._FlushFileBuffers = k('FlushFileBuffers', BOOL, [HANDLE])
        self._SetFilePointerEx = k('SetFilePointerEx', BOOL, [HANDLE, ctypes.c_int64, PI64, DWORD])
        self._GetCurrentProcess = k('GetCurrentProcess', HANDLE, [])
        self._GetCurrentThread = k('GetCurrentThread', HANDLE, [])
        self._LocalFree = k('LocalFree', P, [P])
        self._OpenProcessToken = a('OpenProcessToken', BOOL, [HANDLE, DWORD, PH])
        self._OpenThreadToken = a('OpenThreadToken', BOOL, [HANDLE, DWORD, BOOL, PH])
        self._GetTokenInformation = a('GetTokenInformation', BOOL, [HANDLE, ctypes.c_int32, P, DWORD, PD])
        self._GetSecurityInfo = a('GetSecurityInfo', DWORD, [HANDLE, DWORD, DWORD, PH, PH, PH, PH, PH])
        self._GetSecurityDescriptorControl = a('GetSecurityDescriptorControl', BOOL, [P, PW, PD])
        self._IsValidSecurityDescriptor = a('IsValidSecurityDescriptor', BOOL, [P])
        self._IsValidAcl = a('IsValidAcl', BOOL, [P])
        self._GetAce = a('GetAce', BOOL, [P, DWORD, PH])
        self._IsValidSid = a('IsValidSid', BOOL, [P])
        self._GetLengthSid = a('GetLengthSid', DWORD, [P])
        self._ConvertSidToStringSidW = a('ConvertSidToStringSidW', BOOL, [P, PH])
        self._ConvertSDDL = a(
            'ConvertStringSecurityDescriptorToSecurityDescriptorW', BOOL, [LPCWSTR, DWORD, PH, PD]
        )

    def _last_error(self) -> int:
        try:
            return int(ctypes.get_last_error())
        except Exception:
            return 0

    def _raise_win(self, default: str = 'unavailable') -> None:
        e = self._last_error()
        if e in (ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS):
            _fail('conflict')
        if e in (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND):
            _fail('unavailable')
        if e in (ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL):
            _fail('capacity')
        if e in (ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION):
            _fail('unsafe-storage')
        _fail(default)

    def _as_handle(self, raw: object) -> object:
        if isinstance(raw, bool) or not isinstance(raw, int):
            _fail('invalid')
        if raw in (0, -1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
            _fail('invalid')
        return ctypes.c_void_p(raw)

    def _local_free(self, p: object) -> None:
        if p:
            try:
                self._LocalFree(p)
            except Exception:
                pass

    def _sid_str(self, sid_ptr: object) -> str:
        out = ctypes.c_void_p()
        if not self._ConvertSidToStringSidW(sid_ptr, byref(out)) or not out:
            _fail('unsafe-storage')
        try:
            s = ctypes.wstring_at(out)
        finally:
            self._local_free(out)
        if not _valid_sid_str(s):
            _fail('unsafe-storage')
        return s

    def _sd_from_sddl(self, sddl: str) -> ctypes.c_void_p:
        if not isinstance(sddl, str) or not sddl or len(sddl) > 1024 or any(ord(c) < 32 for c in sddl):
            _fail('invalid')
        psd = ctypes.c_void_p()
        if not self._ConvertSDDL(sddl, DWORD(SDDL_REVISION_1), byref(psd), None) or not psd:
            _fail('unavailable')
        return psd

    def _final_path(self, h: object) -> str:
        flags = DWORD(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)
        cap = 520
        while True:
            if cap > _MAX_WCHARS:
                _fail('capacity')
            buf = (WCHAR * cap)()
            n = int(self._GetFinalPathNameByHandleW(h, buf, DWORD(cap), flags))
            if n == 0:
                self._raise_win('unavailable')
            if n < cap:
                s = ctypes.wstring_at(ctypes.addressof(buf), n)
                return _validate_dos_path(s)
            cap = n if n > cap else n + 1

    @_safe
    def current_user_sid(self) -> str:
        th = ctypes.c_void_p()
        if self._OpenThreadToken(self._GetCurrentThread(), DWORD(TOKEN_QUERY), BOOL(1), byref(th)):
            self._local_free  # keep attribute use obvious to readers
            try:
                self._CloseHandle(th)
            except Exception:
                pass
            _fail('unsafe-storage')
        if self._last_error() != ERROR_NO_TOKEN:
            _fail('unavailable')
        token = ctypes.c_void_p()
        if not self._OpenProcessToken(self._GetCurrentProcess(), DWORD(TOKEN_QUERY), byref(token)):
            self._raise_win('unavailable')
        try:
            needed = DWORD(0)
            ok = self._GetTokenInformation(token, TokenUser, None, DWORD(0), byref(needed))
            if ok or self._last_error() != ERROR_INSUFFICIENT_BUFFER:
                _fail('unavailable')
            n = int(needed.value)
            if n < ctypes.sizeof(TOKEN_USER) or n > _MAX_TOKEN:
                _fail('unavailable')
            buf = (BYTE * n)()
            if not self._GetTokenInformation(token, TokenUser, buf, DWORD(n), byref(needed)):
                self._raise_win('unavailable')
            tu = TOKEN_USER.from_buffer(buf)
            sid = tu.User.Sid
            addr = int(sid) if sid else 0
            base = ctypes.addressof(buf)
            if addr < base or addr >= base + n:
                _fail('unsafe-storage')
            if not self._IsValidSid(sid):
                _fail('unsafe-storage')
            slen = int(self._GetLengthSid(sid))
            if slen < 8 or addr + slen > base + n:
                _fail('unsafe-storage')
            return self._sid_str(sid)
        finally:
            try:
                self._CloseHandle(token)
            except Exception:
                pass

    @_safe
    def open_file(self, path: str, *, directory: bool, writable: bool, create: bool, security_sddl: str | None) -> int:
        if not isinstance(path, str) or any(ord(c) < 32 for c in path):
            _fail('invalid')
        if create:
            if directory or not writable or not isinstance(security_sddl, str):
                _fail('invalid')
            disp = CREATE_NEW
            access = GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES
            share = FILE_SHARE_READ
            flags = FILE_ATTRIBUTE_NORMAL
        else:
            if security_sddl is not None:
                _fail('invalid')
            disp = OPEN_EXISTING
            if directory:
                if writable:
                    _fail('invalid')
                access = READ_CONTROL | FILE_READ_ATTRIBUTES
                share = FILE_SHARE_READ | FILE_SHARE_WRITE
                flags = FILE_FLAG_BACKUP_SEMANTICS
            else:
                access = GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES
                if writable:
                    access |= GENERIC_WRITE
                share = FILE_SHARE_READ
                flags = FILE_ATTRIBUTE_NORMAL
        psd = None
        sap = None
        sa = SECURITY_ATTRIBUTES()
        try:
            if security_sddl is not None:
                psd = self._sd_from_sddl(security_sddl)
                sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
                sa.lpSecurityDescriptor = psd
                sa.bInheritHandle = 0
                sap = ctypes.byref(sa)
            h = self._CreateFileW(
                path, DWORD(access), DWORD(share), sap, DWORD(disp), DWORD(flags), None,
            )
        finally:
            self._local_free(psd)
        raw = h.value if isinstance(h, ctypes.c_void_p) else h
        if raw in (None, 0, -1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
            self._raise_win('unavailable')
        if isinstance(raw, bool) or not isinstance(raw, int):
            _fail('unavailable')
        return int(raw)

    @_safe
    def create_directory(self, path: str, security_sddl: str) -> None:
        if not isinstance(path, str) or any(ord(c) < 32 for c in path):
            _fail('invalid')
        psd = self._sd_from_sddl(security_sddl)
        sa = SECURITY_ATTRIBUTES()
        sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
        sa.lpSecurityDescriptor = psd
        sa.bInheritHandle = 0
        try:
            if not self._CreateDirectoryW(path, ctypes.byref(sa)):
                self._raise_win('unavailable')
        finally:
            self._local_free(psd)

    @_safe
    def file_identity(self, raw_handle: int) -> FileIdentity:
        h = self._as_handle(raw_handle)
        if int(self._GetFileType(h)) != FILE_TYPE_DISK:
            _fail('unsafe-storage')
        info = BY_HANDLE_FILE_INFORMATION()
        if not self._GetFileInformationByHandle(h, byref(info)):
            self._raise_win('unavailable')
        path = self._final_path(h)
        serial = DWORD(0)
        maxc = DWORD(0)
        flags = DWORD(0)
        fsbuf = (WCHAR * 32)()
        if not self._GetVolumeInformationByHandleW(
            h, None, DWORD(0), byref(serial), byref(maxc), byref(flags), fsbuf, DWORD(32)
        ):
            self._raise_win('unsafe-storage')
        fs = ctypes.cast(fsbuf, LPCWSTR).value
        if fs != 'NTFS':
            _fail('unsafe-storage')
        drive, _parts = _split_parts(path)
        dt = int(self._GetDriveTypeW(drive + ':' + _BS))
        if dt != _DRIVE_FIXED:
            _fail('unsafe-storage')
        if int(serial.value) != int(info.dwVolumeSerialNumber):
            _fail('unsafe-storage')
        idx = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
        size = (int(info.nFileSizeHigh) << 32) | int(info.nFileSizeLow)
        ctime = (int(info.ftCreationTime.dwHighDateTime) << 32) | int(info.ftCreationTime.dwLowDateTime)
        wtime = (int(info.ftLastWriteTime.dwHighDateTime) << 32) | int(info.ftLastWriteTime.dwLowDateTime)
        return FileIdentity(
            volume_serial=int(info.dwVolumeSerialNumber),
            file_index=idx,
            attributes=int(info.dwFileAttributes),
            links=int(info.nNumberOfLinks),
            size=size,
            creation_ticks=ctime,
            last_write_ticks=wtime,
            final_path=path,
            filesystem=fs,
            volume_flags=int(flags.value),
            drive_type=dt,
        )

    @_safe
    def security_info(self, raw_handle: int) -> SecurityInfo:
        h = self._as_handle(raw_handle)
        owner = ctypes.c_void_p()
        dacl = ctypes.c_void_p()
        psd = ctypes.c_void_p()
        err = int(self._GetSecurityInfo(
            h, DWORD(SE_FILE_OBJECT),
            DWORD(OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION),
            byref(owner), None, byref(dacl), None, byref(psd),
        ))
        if err != 0 or not psd:
            _fail('unsafe-storage')
        try:
            if not self._IsValidSecurityDescriptor(psd):
                _fail('unsafe-storage')
            ctrl = WORD(0)
            rev = DWORD(0)
            if not self._GetSecurityDescriptorControl(psd, byref(ctrl), byref(rev)):
                _fail('unsafe-storage')
            cval = int(ctrl.value)
            if (cval & SE_DACL_PRESENT) == 0 or not dacl or not owner:
                _fail('unsafe-storage')
            if not self._IsValidSid(owner) or not self._IsValidAcl(dacl):
                _fail('unsafe-storage')
            owner_sid = self._sid_str(owner)
            aclhdr = ACL.from_address(int(dacl.value))
            acl_size = int(aclhdr.AclSize)
            ace_count = int(aclhdr.AceCount)
            if acl_size < 8 or acl_size > _MAX_ACL or ace_count > 256:
                _fail('unsafe-storage')
            buf = (BYTE * acl_size)()
            ctypes.memmove(buf, dacl, acl_size)
            if not self._IsValidAcl(buf):
                _fail('unsafe-storage')
            base = ctypes.addressof(buf)
            aces = []
            for i in range(ace_count):
                pace = ctypes.c_void_p()
                if not self._GetAce(buf, DWORD(i), byref(pace)) or not pace.value:
                    _fail('unsafe-storage')
                off = int(pace.value) - base
                if off < 8 or off > acl_size - 16:
                    _fail('unsafe-storage')
                hdr = ACE_HEADER.from_buffer(buf, off)
                asz = int(hdr.AceSize)
                if asz < 16 or off + asz > acl_size or int(hdr.AceType) != 0:
                    _fail('unsafe-storage')
                mask = int.from_bytes(bytes(buf[off + 4:off + 8]), 'little')
                sid_off = off + 8
                sid_ptr = ctypes.c_void_p(base + sid_off)
                if not self._IsValidSid(sid_ptr):
                    _fail('unsafe-storage')
                slen = int(self._GetLengthSid(sid_ptr))
                if slen < 8 or sid_off + slen > off + asz:
                    _fail('unsafe-storage')
                aces.append(Ace(0, int(hdr.AceFlags), mask, self._sid_str(sid_ptr)))
            return SecurityInfo(owner_sid, bool(cval & SE_DACL_PROTECTED), True, tuple(aces))
        finally:
            self._local_free(psd)

    @_safe
    def seek_start(self, raw_handle: int) -> None:
        h = self._as_handle(raw_handle)
        newp = ctypes.c_int64(-1)
        if not self._SetFilePointerEx(h, ctypes.c_int64(0), byref(newp), DWORD(FILE_BEGIN)):
            self._raise_win('unavailable')
        if int(newp.value) != 0:
            _fail('unsafe-storage')

    @_safe
    def read(self, raw_handle: int, count: int) -> bytes:
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > _MAX_IO + 1:
            _fail('invalid')
        h = self._as_handle(raw_handle)
        out = bytearray()
        remain = count
        while remain > 0:
            chunk = remain
            buf = (ctypes.c_char * chunk)()
            n = DWORD(0)
            if not self._ReadFile(h, buf, DWORD(chunk), byref(n), None):
                self._raise_win('unavailable')
            got = int(n.value)
            if got == 0:
                break
            if got > chunk:
                _fail('unsafe-storage')
            out.extend(ctypes.string_at(buf, got))
            remain -= got
        return bytes(out)

    @_safe
    def write(self, raw_handle: int, data: bytes) -> int:
        if not isinstance(data, bytes):
            _fail('invalid')
        if len(data) > _MAX_IO:
            _fail('capacity')
        if not data:
            return 0
        h = self._as_handle(raw_handle)
        buf = (ctypes.c_char * len(data)).from_buffer_copy(data)
        n = DWORD(0)
        if not self._WriteFile(h, buf, DWORD(len(data)), byref(n), None):
            self._raise_win('unavailable')
        got = int(n.value)
        if got > len(data):
            _fail('unsafe-storage')
        return got

    @_safe
    def flush(self, raw_handle: int) -> None:
        h = self._as_handle(raw_handle)
        if not self._FlushFileBuffers(h):
            self._raise_win('unavailable')

    @_safe
    def close(self, raw_handle: int) -> None:
        h = self._as_handle(raw_handle)
        if not self._CloseHandle(h):
            self._raise_win('unavailable')


class Win32Native:
    def __init__(self, bindings: object = None) -> None:
        try:
            if bindings is None:
                if sys.platform != 'win32':
                    _fail('unavailable')
                bindings = CtypesBindings()
            if not _has_protocol(bindings):
                _fail('invalid')
            self._b = bindings
            self._token = object()
        except NativeError:
            raise
        except Exception:
            raise NativeError('unavailable') from None

    def _check_handle(self, handle: object, *, allow_closed: bool = False) -> Handle:
        if not isinstance(handle, Handle) or handle._owner is not self or handle._token is not self._token:
            _fail('invalid')
        if handle._closed and not allow_closed:
            _fail('invalid')
        if not handle._closed:
            raw = handle._raw
            if isinstance(raw, bool) or not isinstance(raw, int) or raw in (0, -1):
                _fail('invalid')
        return handle

    def _abandon(self, handle: Handle) -> None:
        if handle._closed:
            return
        try:
            self._b.close(handle._raw)
        except Exception:
            pass
        handle._closed = True
        handle._raw = 0

    def _adopt(self, raw: object, kind: str, writable: bool, created: bool) -> Handle:
        if isinstance(raw, bool) or not isinstance(raw, int) or raw in (0, -1):
            _fail('unavailable')
        return Handle(_HANDLE_NEW, self, int(raw), kind, writable, created)

    def _reverify(self, handle: Handle) -> None:
        root = handle._private_root
        if root is None:
            self.verify_private(handle)
            return
        self.verify_private(handle, private_root=root)

    @_safe
    def open_existing(self, path: str, *, directory: bool = False, writable: bool = False) -> Handle:
        path = _validate_dos_path(path)
        if directory and writable:
            _fail('invalid')
        raw = self._b.open_file(
            path, directory=directory, writable=writable, create=False, security_sddl=None,
        )
        h = self._adopt(raw, 'directory' if directory else 'file', writable, False)
        try:
            self.snapshot(h)
            return h
        except NativeError:
            self._abandon(h)
            raise

    @_safe
    def create_private_file(self, path: str) -> Handle:
        path = _validate_dos_path(path)
        sid = self._b.current_user_sid()
        if not _valid_sid_str(sid):
            _fail('unsafe-storage')
        raw = self._b.open_file(
            path, directory=False, writable=True, create=True, security_sddl=_file_sddl(sid),
        )
        h = self._adopt(raw, 'file', True, True)
        try:
            self.verify_private(h)
            ident = self.snapshot(h)
            if ident.size != 0:
                _fail('unsafe-storage')
            return h
        except NativeError:
            self._abandon(h)
            raise

    @_safe
    def create_private_directory(self, path: str) -> Handle:
        path = _validate_dos_path(path)
        sid = self._b.current_user_sid()
        if not _valid_sid_str(sid):
            _fail('unsafe-storage')
        self._b.create_directory(path, _dir_sddl(sid))
        raw = self._b.open_file(
            path, directory=True, writable=False, create=False, security_sddl=None,
        )
        h = self._adopt(raw, 'directory', False, True)
        try:
            self.verify_private(h)
            return h
        except NativeError:
            self._abandon(h)
            raise

    @_safe
    def snapshot(self, handle: Handle) -> FileIdentity:
        handle = self._check_handle(handle)
        ident = self._b.file_identity(handle._raw)
        ident = _validate_identity(
            ident, directory=(handle._kind == 'directory'), canon=handle._canon,
        )
        if handle._canon is None:
            handle._canon = ident.final_path
        return ident

    @_safe
    def verify_private(self, handle: Handle, *, private_root: Handle | None = None) -> None:
        handle = self._check_handle(handle)
        ident = self.snapshot(handle)
        sec = self._b.security_info(handle._raw)
        user = self._b.current_user_sid()
        if private_root is None:
            _policy(sec, user, allow_inherited=False)
            handle._private_root = None
            return
        if private_root is handle:
            _fail('invalid')
        root = self._check_handle(private_root)
        if root._kind != 'directory':
            _fail('unsafe-storage')
        root_ident = self.snapshot(root)
        if (root_ident.attributes & _ATTR_DIR) == 0:
            _fail('unsafe-storage')
        root_sec = self._b.security_info(root._raw)
        _policy(root_sec, user, allow_inherited=False)
        if not root_sec.protected:
            _fail('unsafe-storage')
        _strict_desc(root_ident, ident)
        _policy(sec, user, allow_inherited=True)
        handle._private_root = root

    @_safe
    def read(self, handle: Handle, limit: int = _MAX_IO) -> bytes:
        handle = self._check_handle(handle)
        if handle._kind != 'file':
            _fail('invalid')
        if isinstance(limit, bool) or not isinstance(limit, int):
            _fail('invalid')
        if limit < 0:
            _fail('invalid')
        if limit > _MAX_IO:
            _fail('capacity')
        self._reverify(handle)
        before = self.snapshot(handle)
        self._b.seek_start(handle._raw)
        data = self._b.read(handle._raw, limit + 1)
        if not isinstance(data, bytes):
            _fail('unavailable')
        if len(data) > limit:
            _fail('capacity')
        after = self.snapshot(handle)
        if not _stable(before, after) or after.size != len(data):
            _fail('unsafe-storage')
        self._reverify(handle)
        return data

    @_safe
    def write(self, handle: Handle, data: bytes) -> None:
        handle = self._check_handle(handle)
        if not isinstance(data, bytes):
            _fail('invalid')
        if len(data) > _MAX_IO:
            _fail('capacity')
        if handle._kind != 'file' or not handle._created or not handle._writable:
            _fail('invalid')
        if handle._write_attempted:
            _fail('conflict')
        self._reverify(handle)
        before = self.snapshot(handle)
        if before.size != 0:
            _fail('conflict')
        handle._write_attempted = True
        self._b.seek_start(handle._raw)
        sent = 0
        while sent < len(data):
            n = self._b.write(handle._raw, data[sent:])
            if isinstance(n, bool) or not isinstance(n, int) or n <= 0:
                _fail('unavailable')
            if n > len(data) - sent:
                _fail('unsafe-storage')
            sent += n
        after = self.snapshot(handle)
        if (
            after.size != len(data)
            or after.volume_serial != before.volume_serial
            or after.file_index != before.file_index
        ):
            _fail('unsafe-storage')
        self._reverify(handle)

    @_safe
    def flush(self, handle: Handle) -> None:
        handle = self._check_handle(handle)
        if handle._kind != 'file' or not handle._writable:
            _fail('invalid')
        self._reverify(handle)
        self._b.flush(handle._raw)
        self._reverify(handle)

    @_safe
    def close(self, handle: Handle) -> None:
        handle = self._check_handle(handle, allow_closed=True)
        if handle._closed:
            return
        self._b.close(handle._raw)
        handle._closed = True
        handle._raw = 0
