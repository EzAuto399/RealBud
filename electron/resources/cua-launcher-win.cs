// Native CUA supervisor. No shell, environment-selected target or general
// supervisor CLI. The only target is the adjacent reviewed cua-driver.exe.
// Host mode reserves stdout for one identity record and observes the empty
// parent-liveness stdin itself. Legacy mode preserves all three stdhandles.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class RealBudCuaLauncher
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    const uint INFINITE = 0xffffffff;
    const uint DUPLICATE_SAME_ACCESS = 2;
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint OPEN_EXISTING = 3;
    static readonly IntPtr Invalid = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION
    { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX
    { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS
    { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    // Standard CRT argv quoting, including empty values, quotes and trailing
    // backslashes. Shell metacharacters are ordinary UTF-16 characters here.
    internal static string QuoteArgument(string value)
    {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); }
            else { quoted.Append('\\', slashes); quoted.Append(c); }
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    static IntPtr InheritedStandardHandle(int kind, bool discard)
    {
        IntPtr original = discard ? IntPtr.Zero : GetStdHandle(kind), temporary = IntPtr.Zero, inherited;
        if (original == IntPtr.Zero || original == Invalid)
        {
            temporary = CreateFileW("NUL", kind == -10 ? GENERIC_READ : GENERIC_WRITE, 3, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (temporary == Invalid) throw new InvalidOperationException();
            original = temporary;
        }
        try
        {
            if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out inherited, 0, true, DUPLICATE_SAME_ACCESS)) throw new InvalidOperationException();
            return inherited;
        }
        finally { if (temporary != IntPtr.Zero) CloseHandle(temporary); }
    }

    static bool DrainJob(IntPtr job)
    {
        // Stop descendants even if the driver itself exited normally. A new
        // daemon must never inherit helpers from the previous generation.
        if (!TerminateJobObject(job, 125)) return false;
        for (int attempt = 0; attempt < 250; attempt++)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return false;
            if (accounting.ActiveProcesses == 0) return true;
            Thread.Sleep(20);
        }
        return false;
    }

    static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        object jobGate = new object();
        IntPtr attributes = IntPtr.Zero, jobAttribute = IntPtr.Zero, handleAttribute = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool started = false, attributesReady = false, drained = false;
        try
        {
            bool hostMode = args.Length > 0 && args[0] == "--realbud-cua-host-v1";
            int firstArgument = hostMode ? 1 : 0;
            if (hostMode && (args.Length <= firstArgument || args[firstArgument] != "serve")) throw new InvalidOperationException();
            string directory = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string binary = Path.Combine(directory, "cua-driver.exe");
            if (!File.Exists(binary)) throw new InvalidOperationException();
            var command = new StringBuilder(QuoteArgument(binary));
            for (int i = firstArgument; i < args.Length; i++)
            {
                command.Append(' ').Append(QuoteArgument(args[i]));
                if (i == firstArgument && args[i] == "serve") command.Append(" --grant existing-profile");
            }
            job = CreateJobObjectW(IntPtr.Zero, null); // The job handle is not inherited.
            if (job == IntPtr.Zero) throw new InvalidOperationException();
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) throw new InvalidOperationException();
            input = InheritedStandardHandle(-10, false); output = InheritedStandardHandle(-11, hostMode); error = InheritedStandardHandle(-12, false);
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) throw new InvalidOperationException();
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize)) throw new InvalidOperationException();
            attributesReady = true;
            jobAttribute = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobAttribute, job);
            handleAttribute = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handleAttribute, 0, input); Marshal.WriteIntPtr(handleAttribute, IntPtr.Size, output); Marshal.WriteIntPtr(handleAttribute, 2 * IntPtr.Size, error);
            // JOB_LIST assigns atomically inside CreateProcess (Windows 10+),
            // including if this launcher dies before CreateProcess returns.
            // Never use create-suspended then assign: that leaves an orphan gap.
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobAttribute, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero) ||
                !UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleAttribute, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException();
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input; startup.StartupInfo.hStdOutput = output; startup.StartupInfo.hStdError = error; startup.AttributeList = attributes;
            if (!CreateProcessW(binary, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref startup, out child)) throw new InvalidOperationException();
            started = true;
            bool assigned;
            if (!IsProcessInJob(child.hProcess, job, out assigned) || !assigned) throw new InvalidOperationException();
            Thread parentMonitor = null;
            if (hostMode)
            {
                // Both readers see EOF on this empty liveness pipe. No bytes,
                // credentials or commands are sent through host-mode stdin.
                // The helper must contain parent death even if the driver
                // hangs and never services its own stdin reader.
                parentMonitor = new Thread(delegate()
                {
                    try { using (Stream parentInput = Console.OpenStandardInput()) { parentInput.ReadByte(); } }
                    catch { /* A broken parent pipe also ends this generation. */ }
                    lock (jobGate) { if (job != IntPtr.Zero) TerminateJobObject(job, 125); }
                });
                parentMonitor.IsBackground = true;
                // Atomic Job assignment has completed; the driver is still
                // suspended and can never write to this reserved stdout pipe.
                string record = "{\"schema\":\"realbud-cua-host\",\"version\":1,\"supervisorPid\":" +
                    System.Diagnostics.Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                    ",\"driverPid\":" + child.dwProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}\n";
                byte[] recordBytes = Encoding.ASCII.GetBytes(record);
                Stream controlOutput = Console.OpenStandardOutput();
                controlOutput.Write(recordBytes, 0, recordBytes.Length);
                controlOutput.Flush();
            }
            if (ResumeThread(child.hThread) == uint.MaxValue) throw new InvalidOperationException();
            // Preclosed stdin is ordinary startup cancellation. Begin EOF
            // termination only after ResumeThread succeeds, so cancellation
            // cannot turn a safely drained suspended child into a false fault.
            if (parentMonitor != null) parentMonitor.Start();
            if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) throw new InvalidOperationException();
            uint code;
            if (!GetExitCodeProcess(child.hProcess, out code) || !DrainJob(job)) throw new InvalidOperationException();
            drained = true;
            // Host mode reserves success for confirmed empty Job membership.
            // Forced/abnormal helper exit is never proof of human release.
            return hostMode ? 0 : unchecked((int)code);
        }
        catch
        {
            // Fixed diagnostic only: argv can contain local profile paths.
            Console.Error.WriteLine("RealBud CUA launcher could not start or stop its owned driver safely.");
            return 125;
        }
        finally
        {
            if (started && !drained)
            {
                TerminateProcess(child.hProcess, 125);
                DrainJob(job);
            }
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobAttribute != IntPtr.Zero) Marshal.FreeHGlobal(jobAttribute);
            if (handleAttribute != IntPtr.Zero) Marshal.FreeHGlobal(handleAttribute);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            lock (jobGate)
            {
                if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            }
        }
    }
}
