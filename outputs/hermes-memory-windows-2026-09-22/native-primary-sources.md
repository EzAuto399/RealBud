# Windows native foundation: primary-source decisions

Read on 2026-09-22. This is source/design evidence, not observed Windows behavior. All production Windows holds remain.

- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): Creation-time SECURITY_ATTRIBUTES; CREATE_NEW no-clobber; leaf reparse handling; no DELETE sharing; write-through cache semantics.
- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo): Security is read through the actual handle; owner and DACL pointers belong to allocated security descriptor; LocalFree required.
- [GetAce](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getace): ACE pointers are bounded within the returned ACL before SID fields are read.
- [GetSecurityDescriptorControl](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getsecuritydescriptorcontrol): Verify present/protected/self-relative descriptor control bits.
- [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle): Use volume serial and file index together, with kind/link/time/size metadata.
- [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew): Get normalized extended DOS path from the opened handle with bounded output allocation.
- [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation): Read TokenUser from the process token with bounded two-pass allocation; no environment identity.
- [SECURITY_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/wtypesbase/ns-wtypesbase-security_attributes): Explicit descriptor and non-inheritable handle are passed to creation.
- [ConvertStringSecurityDescriptorToSecurityDescriptorW](https://learn.microsoft.com/en-us/windows/win32/api/sddl/nf-sddl-convertstringsecuritydescriptortosecuritydescriptorw): Convert locally generated protected private SDDL; free descriptor after creation.
- [GetVolumeInformationByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew): Admit only NTFS with persistent ACLs and matching volume identity.
- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers): A checked file flush is not a directory metadata or physical power-loss guarantee.
- [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info): Use source handle, parent RootDirectory handle, relative UTF16 leaf and explicit replace flag; no path-based fallback.
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle): FileRenameInfo and FileDispositionInfo require appropriate access rights; delete marks the opened file until close.
- [FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info): DeleteFile marks the already opened source; one-byte BOOLEAN ABI.
- [GetSecurityDescriptorDacl](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-getsecuritydescriptordacl): A present NULL DACL grants broad access and must be refused.
- [ACCESS_ALLOWED_ACE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-access_allowed_ace): Simple allow ACE layout is header, mask, SID; object/callback/deny ACEs conservatively refused.

[Absolute and self-relative security descriptors](https://learn.microsoft.com/en-us/windows/win32/secauthz/absolute-and-self-relative-security-descriptors) documents contiguous returned security descriptors; pointer ranges are checked against their validated length.

The backend admits strict case-preserving component paths with normalized drive case. Aliases, reparse targets, nonlocal/non-NTFS volumes and hardlinked files fail closed. The caller must pin the full ancestor chain; the leaf handle does not prove ancestor safety. No global ACL policy was relaxed.
