// QA fixture only. Run the scenario inside the installed Worker supervisor's
// non-breakaway Job with the same user SID and denied administrator groups.
// This is not a Windows11 standard-user/UAC simulation or a product launcher.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class RestrictedQaProcess {
    const uint Query = 8, Duplicate = 2, AssignPrimary = 1, AdjustDefault = 0x80;
    const uint Suspended = 4, Extended = 0x80000, Unicode = 0x400, NoWindow = 0x08000000;
    const uint KillOnClose = 0x2000, Breakaway = 0x800, SilentBreakaway = 0x1000;
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct AclSize { public uint Count, Used, Free; }
    sealed class NativeFailure : Exception {
        public readonly string Stage; public readonly uint Code;
        public NativeFailure(string stage) { Stage = stage; Code = unchecked((uint)Marshal.GetLastWin32Error()); }
        public NativeFailure(string stage, uint code) { Stage = stage; Code = code; }
    }
    struct Snapshot {
        public bool Admin, PowerUsers, Elevated, OwnerIsUser; public uint ElevationType;
        public string JsonFields() {
            return "\"administratorEnabled\":" + Bool(Admin) + ",\"powerUsersEnabled\":" + Bool(PowerUsers) +
                ",\"elevated\":" + Bool(Elevated) + ",\"elevationType\":" + ElevationType + ",\"tokenDefaultOwnerIsUser\":" + Bool(OwnerIsUser);
        }
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool included);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ExtendedLimits limits, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, [In] SidAttributes[] disabled, uint deleteCount, IntPtr deleted, uint restrictCount, IntPtr restricted, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token, byte[] sid, out bool member);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out uint value, uint size, out uint returned);
    [DllImport("advapi32.dll", EntryPoint="GetTokenInformation", SetLastError=true)] static extern bool GetTokenBuffer(IntPtr token, int kind, IntPtr value, uint size, out uint returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr value, uint size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetAclInformation(IntPtr acl, out AclSize value, uint size, int kind);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);

    static string Bool(bool value) { return value ? "true" : "false"; }
    static bool Valid(IntPtr value) { return value != IntPtr.Zero && value != new IntPtr(-1); }
    static void Require(bool value, string stage) { if (!value) throw new NativeFailure(stage); }
    static byte[] Sid(WellKnownSidType kind) {
        var value = new SecurityIdentifier(kind, null); var bytes = new byte[value.BinaryLength]; value.GetBinaryForm(bytes, 0); return bytes;
    }
    static Snapshot Inspect(IntPtr token) {
        IntPtr duplicate = IntPtr.Zero;
        try {
            Require(DuplicateToken(token, 2, out duplicate), "duplicate-token");
            var result = new Snapshot();
            Require(CheckTokenMembership(duplicate, Sid(WellKnownSidType.BuiltinAdministratorsSid), out result.Admin), "administrator-membership");
            Require(CheckTokenMembership(duplicate, Sid(WellKnownSidType.BuiltinPowerUsersSid), out result.PowerUsers), "power-users-membership");
            uint elevated, returned;
            Require(GetTokenInformation(token, 20, out elevated, 4, out returned) && returned == 4 && elevated <= 1, "elevation");
            result.Elevated = elevated == 1;
            Require(GetTokenInformation(token, 18, out result.ElevationType, 4, out returned) && returned == 4 && result.ElevationType >= 1 && result.ElevationType <= 3, "elevation-type");
            result.OwnerIsUser = TokenSid(token, 4, "owner").Equals(User(token));
            return result;
        } finally { if (Valid(duplicate)) CloseHandle(duplicate); }
    }
    static SecurityIdentifier User(IntPtr token) { return TokenSid(token, 1, "user"); }
    static SecurityIdentifier TokenSid(IntPtr token, int kind, string stage) {
        uint bytes; GetTokenBuffer(token, kind, IntPtr.Zero, 0, out bytes);
        Require(bytes >= IntPtr.Size && bytes <= 4096, stage + "-size");
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)bytes));
        try {
            Require(GetTokenBuffer(token, kind, buffer, bytes, out bytes), stage + "-query");
            return new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void NormalizeOwner(IntPtr token) {
        // TOKEN_OWNER is one PSID pointer, not the SID bytes themselves. The SID
        // already belongs to TokenUser; only this new restricted token changes.
        var user = User(token); var bytes = new byte[user.BinaryLength]; user.GetBinaryForm(bytes, 0);
        IntPtr sid = IntPtr.Zero, owner = IntPtr.Zero;
        try {
            sid = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, sid, bytes.Length);
            owner = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(owner, sid);
            Require(SetTokenInformation(token, 4, owner, (uint)IntPtr.Size), "set-default-owner");
        } finally { if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner); if (sid != IntPtr.Zero) Marshal.FreeHGlobal(sid); }
    }
    static bool ObjectOwnerIsUser(string path, SecurityIdentifier user) {
        try {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new NativeFailure("object-owner-query", 0);
            FileSystemSecurity security = (attributes & FileAttributes.Directory) != 0
                ? (FileSystemSecurity)new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner)
                : new FileInfo(path).GetAccessControl(AccessControlSections.Owner);
            return security.GetOwner(typeof(SecurityIdentifier)).Equals(user);
        } catch { throw new NativeFailure("object-owner-query", 0); }
    }
    static int QueryProcess(int pid, string objectPath) {
        IntPtr process = IntPtr.Zero, token = IntPtr.Zero, current = IntPtr.Zero;
        try {
            process = OpenProcess(0x1000, false, pid); Require(Valid(process), "open-process");
            Require(OpenProcessToken(process, Query | Duplicate, out token), "open-token");
            Require(OpenProcessToken(GetCurrentProcess(), Query, out current), "current-token");
            var snapshot = Inspect(token);
            bool same = User(token).Equals(User(current));
            string owner = objectPath == null ? "" : ",\"objectOwnerIsUser\":" + Bool(ObjectOwnerIsUser(objectPath, User(token)));
            Console.WriteLine("{\"schema\":1,\"pid\":" + pid + ",\"outcome\":\"queried\",\"sameUser\":" + Bool(same) + "," + snapshot.JsonFields() + owner + "}");
            return 0;
        } finally {
            if (Valid(current)) CloseHandle(current); if (Valid(token)) CloseHandle(token); if (Valid(process)) CloseHandle(process);
        }
    }
    static bool Absolute(string value) {
        string path = value.Replace('/', '\\');
        if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\') return true;
        if (!path.StartsWith("\\\\")) return false;
        string[] parts = path.Substring(2).Split('\\');
        return parts.Length >= 3 && parts[0].Length > 0 && parts[1].Length > 0 && parts[2].Length > 0;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes); result.Append(ch); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static IntPtr CopyHandle(int kind) {
        IntPtr source = GetStdHandle(kind), copy; Require(Valid(source), "standard-handle");
        Require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out copy, 0, true, 2), "copy-handle"); return copy;
    }
    // Opt-in startup diagnostics only. These masks describe ACEs, not effective
    // access. No SID, ACL bytes, account name or arbitrary path is printed.
    static string DefaultDacl(IntPtr token) {
        uint size; GetTokenBuffer(token, 6, IntPtr.Zero, 0, out size);
        Require(size >= IntPtr.Size && size <= 65536, "default-dacl-size");
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)size));
        try {
            Require(GetTokenBuffer(token, 6, buffer, size, out size), "default-dacl-query");
            IntPtr acl = Marshal.ReadIntPtr(buffer);
            uint count = 0, userAllow = 0, userDeny = 0, adminAllow = 0, systemAllow = 0, other = 0;
            if (acl != IntPtr.Zero) {
                AclSize information;
                Require(GetAclInformation(acl, out information, (uint)Marshal.SizeOf(typeof(AclSize)), 2), "default-dacl-information");
                Require(information.Count <= 1024 && information.Used <= 65536, "default-dacl-bounds"); count = information.Count;
                var user = User(token); var admin = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
                var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
                for (uint i = 0; i < count; i++) {
                    IntPtr ace; Require(GetAce(acl, i, out ace), "default-dacl-ace");
                    byte kind = Marshal.ReadByte(ace); ushort bytes = unchecked((ushort)Marshal.ReadInt16(ace, 2));
                    if ((kind != 0 && kind != 1) || bytes < 16) { other++; continue; }
                    uint mask = unchecked((uint)Marshal.ReadInt32(ace, 4));
                    var sid = new SecurityIdentifier(new IntPtr(ace.ToInt64() + 8));
                    if (sid.Equals(user)) { if (kind == 0) userAllow |= mask; else userDeny |= mask; }
                    else if (kind == 0 && sid.Equals(admin)) adminAllow |= mask;
                    else if (kind == 0 && sid.Equals(system)) systemAllow |= mask;
                    else other++;
                }
            }
            return "{\"present\":" + Bool(acl != IntPtr.Zero) + ",\"aceCount\":" + count + ",\"userAllowMask\":" + userAllow +
                ",\"userDenyMask\":" + userDeny + ",\"administratorsAllowMask\":" + adminAllow + ",\"systemAllowMask\":" + systemAllow + ",\"otherAceCount\":" + other + "}";
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static string OpenResult(bool opened, uint error) { return "{\"opened\":" + Bool(opened) + ",\"win32Error\":" + error + "}"; }
    static string OwnedChildAccess(IntPtr childToken, uint childPid) {
        IntPtr duplicate = IntPtr.Zero; bool impersonating = false;
        try {
            Require(DuplicateToken(childToken, 2, out duplicate), "diagnostic-duplicate-token");
            Require(ImpersonateLoggedOnUser(duplicate), "diagnostic-impersonate"); impersonating = true;
            var result = new StringBuilder("{");
            string[] names = { "queryLimited", "queryInformation", "vmRead", "duplicateHandle", "synchronize" };
            uint[] rights = { 0x1000, 0x400, 0x10, 0x40, 0x100000 };
            for (int i = 0; i < names.Length; i++) {
                IntPtr opened = OpenProcess(rights[i], false, checked((int)childPid));
                uint error = Valid(opened) ? 0 : unchecked((uint)Marshal.GetLastWin32Error());
                try { if (i > 0) result.Append(','); result.Append('"').Append(names[i]).Append("\":").Append(OpenResult(Valid(opened), error)); }
                finally { if (Valid(opened)) CloseHandle(opened); }
            }
            IntPtr process = IntPtr.Zero, token = IntPtr.Zero; uint tokenError = 0; bool tokenOpened = false;
            try {
                process = OpenProcess(0x1000, false, checked((int)childPid));
                if (Valid(process)) { tokenOpened = OpenProcessToken(process, Query | Duplicate, out token); if (!tokenOpened) tokenError = unchecked((uint)Marshal.GetLastWin32Error()); }
                else tokenError = unchecked((uint)Marshal.GetLastWin32Error());
                result.Append(",\"tokenQueryDuplicate\":").Append(OpenResult(tokenOpened, tokenError)).Append('}');
            } finally { if (Valid(token)) CloseHandle(token); if (Valid(process)) CloseHandle(process); }
            return result.ToString();
        } finally {
            // Failure must abort Launch; its finally terminates the still-
            // suspended owned child. Never resume after an uncertain reversion.
            bool reverted = !impersonating || RevertToSelf();
            uint error = reverted ? 0 : unchecked((uint)Marshal.GetLastWin32Error());
            if (Valid(duplicate)) CloseHandle(duplicate);
            if (!reverted) throw new NativeFailure("diagnostic-revert", error);
        }
    }
    static int Launch(string[] args, bool diagnostics = false) {
        bool included; ExtendedLimits limits;
        Require(IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out included) && included, "parent-job");
        Require(QueryInformationJobObject(IntPtr.Zero, 9, out limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero), "job-limits");
        Require((limits.Basic.Flags & KillOnClose) != 0 && (limits.Basic.Flags & (Breakaway | SilentBreakaway)) == 0, "job-containment");
        IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero, childToken = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false, created = false, exited = false; var process = new ProcessInfo();
        var sids = new SidAttributes[2];
        try {
            Require(OpenProcessToken(GetCurrentProcess(), Query | Duplicate | AssignPrimary | AdjustDefault, out original), "launch-token");
            var parent = Inspect(original);
            var kinds = new [] { WellKnownSidType.BuiltinAdministratorsSid, WellKnownSidType.BuiltinPowerUsersSid };
            for (int i = 0; i < kinds.Length; i++) { byte[] bytes = Sid(kinds[i]); sids[i].Sid = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, sids[i].Sid, bytes.Length); }
            Require(CreateRestrictedToken(original, 1, 2, sids, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "restrict-token");
            var reduced = Inspect(restricted);
            bool ownerBefore = reduced.OwnerIsUser;
            if (!ownerBefore) NormalizeOwner(restricted);
            reduced = Inspect(restricted);
            Require(!reduced.Admin && !reduced.PowerUsers && reduced.OwnerIsUser && User(original).Equals(User(restricted)), "restricted-authority");
            input = CopyHandle(-10); output = CopyHandle(-11); error = CopyHandle(-12);
            UIntPtr size = UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            Require(size.ToUInt64() > 0 && size.ToUInt64() < 1024 * 1024, "attribute-size");
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "attributes"); initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "handle-list");
            var startup = new StartupInfoEx(); startup.Startup.cb = Marshal.SizeOf(typeof(StartupInfoEx)); startup.Startup.Flags = 0x100;
            startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error; startup.Attributes = attributes;
            var command = new StringBuilder(); for (int i = 1; i < args.Length; i++) { if (i > 1) command.Append(' '); command.Append(Quote(args[i])); }
            // No BREAKAWAY flags: the child inherits the installed Worker's Job
            // at creation. Restriction changes token authority, not containment.
            Require(CreateProcessAsUserW(restricted, args[1], command, IntPtr.Zero, IntPtr.Zero, true, Suspended | Extended | Unicode | NoWindow, IntPtr.Zero, null, ref startup, out process), "create-restricted"); created = true;
            Require(IsProcessInJob(process.Process, IntPtr.Zero, out included) && included, "child-job");
            Require(OpenProcessToken(process.Process, Query | Duplicate, out childToken), "child-token");
            var child = Inspect(childToken); bool same = User(original).Equals(User(childToken));
            Require(same && !child.Admin && !child.PowerUsers && child.OwnerIsUser, "child-authority");
            string diagnostic = null;
            if (diagnostics) {
                diagnostic = "REALBUD_QA_STARTUP_SECURITY_V1 {\"schema\":1,\"launcherPid\":" + GetCurrentProcessId() + ",\"childPid\":" + process.ProcessId +
                    ",\"parentDefaultDacl\":" + DefaultDacl(original) + ",\"restrictedDefaultDacl\":" + DefaultDacl(restricted) +
                    ",\"childDefaultDacl\":" + DefaultDacl(childToken) + ",\"objectAccessAsChild\":" + OwnedChildAccess(childToken, process.ProcessId) + ",\"reverted\":true}";
            }
            Console.WriteLine("REALBUD_QA_RESTRICTED_V1 {\"schema\":1,\"launcherPid\":" + GetCurrentProcessId() + ",\"childPid\":" + process.ProcessId +
                ",\"sameUser\":true,\"jobInherited\":true,\"parentAdministratorEnabled\":" + Bool(parent.Admin) + ",\"parentPowerUsersEnabled\":" + Bool(parent.PowerUsers) +
                ",\"parentDefaultOwnerIsUser\":" + Bool(parent.OwnerIsUser) + ",\"restrictedDefaultOwnerWasUser\":" + Bool(ownerBefore) +
                ",\"restrictedDefaultOwnerIsUser\":" + Bool(reduced.OwnerIsUser) + "," + child.JsonFields() + "}");
            if (diagnostic != null) Console.WriteLine(diagnostic);
            Console.Out.Flush();
            Require(ResumeThread(process.Thread) != 0xffffffff, "resume");
            Require(WaitForSingleObject(process.Process, 0xffffffff) == 0, "wait"); exited = true;
            uint code; Require(GetExitCodeProcess(process.Process, out code), "exit-code"); return unchecked((int)code);
        } finally {
            if (created && !exited) { TerminateProcess(process.Process, 125); WaitForSingleObject(process.Process, 2000); }
            if (Valid(process.Thread)) CloseHandle(process.Thread); if (Valid(process.Process)) CloseHandle(process.Process);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            foreach (IntPtr handle in new [] { childToken, restricted, original, input, output, error }) if (Valid(handle)) CloseHandle(handle);
            foreach (var sid in sids) if (sid.Sid != IntPtr.Zero) Marshal.FreeHGlobal(sid.Sid);
        }
    }
    static string QueryFailure(int pid, string stage, uint code) {
        return "{\"schema\":1,\"pid\":" + pid + ",\"outcome\":\"query-failed\",\"stage\":\"" + stage + "\",\"win32Error\":" + code + "}";
    }
    static int Main(string[] args) {
        int queryPid = 0;
        try {
            if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("realbud-qa-restricted-process 1"); return 0; }
            int pid;
            if ((args.Length == 2 || args.Length == 3) && args[0] == "--inspect" && Int32.TryParse(args[1], out pid) && pid > 0 && (args.Length == 2 || Absolute(args[2]))) { queryPid = pid; return QueryProcess(pid, args.Length == 3 ? args[2] : null); }
            if (args.Length >= 3 && args[0] == "--diagnostic-launch" && args[1] == "--" && Absolute(args[2])) {
                var launch = new string[args.Length - 1]; Array.Copy(args, 1, launch, 0, launch.Length); return Launch(launch, true);
            }
            if (args.Length < 2 || args[0] != "--" || !Absolute(args[1])) return 125;
            return Launch(args);
        } catch (NativeFailure error) {
            if (queryPid > 0) { Console.WriteLine(QueryFailure(queryPid, error.Stage, error.Code)); return 0; }
            Console.Error.WriteLine("Restricted QA process refused: stage=" + error.Stage + " code=" + error.Code); return 125;
        } catch {
            if (queryPid > 0) { Console.WriteLine(QueryFailure(queryPid, "managed", 0)); return 0; }
            Console.Error.WriteLine("Restricted QA process refused: stage=managed code=0"); return 125;
        }
    }
}
