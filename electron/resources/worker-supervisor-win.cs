// Native Windows containment for one-shot workers. No shell, PATH lookup,
// persisted PID, customer configuration, or diagnostic echo of arguments.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WorkerSupervisor {
    const uint KillOnJobClose = 0x2000, InheritHandle = 1, DuplicateSameAccess = 2;
    const uint CreateSuspended = 4, ExtendedStartup = 0x80000, UnicodeEnvironment = 0x400, NoWindow = 0x08000000;
    const uint WaitObject = 0, Infinite = 0xffffffff;
    static readonly object JobLock = new object();
    static IntPtr parentJob = IntPtr.Zero;
    static bool parentLost;

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool included);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    public static string QuoteArgument(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            result.Append(ch); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static void Require(bool success) { if (!success) throw new InvalidOperationException(); }
    static bool AbsoluteExecutable(string value) {
        string path = value.Replace('/', '\\');
        if (path.Length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && path[2] == '\\') return true;
        if (!path.StartsWith("\\\\")) return false;
        string[] parts = path.Substring(2).Split('\\');
        return parts.Length >= 3 && parts[0].Length > 0 && parts[1].Length > 0 && parts[2].Length > 0;
    }
    static bool Valid(IntPtr handle) { return handle != IntPtr.Zero && handle != new IntPtr(-1); }
    static IntPtr InheritableCopy(IntPtr source) {
        IntPtr copy; Require(Valid(source));
        Require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out copy, 0, true, DuplicateSameAccess)); return copy;
    }
    static bool EmptyJob(IntPtr job) {
        Accounting info; Require(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return info.ActiveProcesses == 0;
    }
    static void WatchParent(object unused) {
        try { var input = Console.OpenStandardInput(); while (input.ReadByte() != -1) {} } catch {}
        lock (JobLock) { parentLost = true; if (Valid(parentJob)) TerminateJobObject(parentJob, 125); }
    }

    static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("realbud-worker-supervisor 1"); return 0; }
        if (args.Length < 2 || args[0] != "--" || !AbsoluteExecutable(args[1])) return 125;
        IntPtr job = IntPtr.Zero, nul = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero;
        bool attributesReady = false, created = false; ProcessInfo process = new ProcessInfo();
        try {
            job = CreateJobObjectW(IntPtr.Zero, null); Require(Valid(job));
            Require(SetHandleInformation(job, InheritHandle, 0));
            var limits = new ExtendedLimits(); limits.Basic.Flags = KillOnJobClose;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            // Only these three handles reach the worker. Parent-liveness stdin
            // and the job handle remain exclusively owned by the supervisor.
            nul = CreateFileW("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); Require(Valid(nul));
            input = InheritableCopy(nul); output = InheritableCopy(GetStdHandle(-11)); error = InheritableCopy(GetStdHandle(-12));
            UIntPtr bytes = UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            Require(bytes.ToUInt64() > 0 && bytes.ToUInt64() < 1024 * 1024);
            attributes = Marshal.AllocHGlobal(checked((int)bytes.ToUInt64()));
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes)); attributesReady = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero));
            // Windows 10+ assigns the job atomically during creation. A killed
            // supervisor cannot strand an unassigned suspended process between
            // CreateProcess and a later AssignProcessToJobObject call.
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupInfoEx(); startup.Startup.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x100; startup.Startup.Input = input; startup.Startup.Output = output; startup.Startup.Error = error; startup.Attributes = attributes;
            var command = new StringBuilder();
            for (int i = 1; i < args.Length; i++) { if (i > 1) command.Append(' '); command.Append(QuoteArgument(args[i])); }
            lock (JobLock) { parentJob = job; }
            ThreadPool.QueueUserWorkItem(WatchParent);
            Require(CreateProcessW(args[1], command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | ExtendedStartup | UnicodeEnvironment | NoWindow, IntPtr.Zero, null, ref startup, out process));
            created = true; bool included; Require(IsProcessInJob(process.Process, job, out included) && included);
            lock (JobLock) { Require(!parentLost); Require(ResumeThread(process.Thread) != 0xffffffff); }
            Require(WaitForSingleObject(process.Process, Infinite) == WaitObject);
            uint exitCode; Require(GetExitCodeProcess(process.Process, out exitCode));
            // A successful leader may have left grandchildren or inherited
            // output handles behind. End the complete job before mirroring it.
            Require(TerminateJobObject(job, 125));
            int attempts = 0; while (!EmptyJob(job) && attempts++ < 100) Thread.Sleep(20);
            Require(EmptyJob(job));
            lock (JobLock) { if (parentLost) return 125; }
            return unchecked((int)exitCode);
        } catch { try { Console.Error.WriteLine("Worker containment could not complete."); } catch {} return 125; }
        finally {
            lock (JobLock) { parentJob = IntPtr.Zero; }
            if (created && Valid(process.Process)) { uint status; if (GetExitCodeProcess(process.Process, out status) && status == 259) TerminateProcess(process.Process, 125); }
            if (Valid(job)) CloseHandle(job);
            if (Valid(process.Thread)) CloseHandle(process.Thread); if (Valid(process.Process)) CloseHandle(process.Process);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles); if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            foreach (IntPtr handle in new IntPtr[] { input, output, error, nul }) if (Valid(handle)) CloseHandle(handle);
        }
    }
}
