using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace SparkStudio.Installer;

internal static class Program
{
    internal const string ProductId = "{C85DA4EA-0382-4B12-943A-CE73A1772FD8}";
    private const string RegistryPath = @"SOFTWARE\SparkStudio\Installer";
    private const string ServiceName = "SparkStudio";
    private static readonly string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SparkStudio");

    public static async Task<int> Main(string[] args)
    {
        string? report = null;
        try
        {
            var options = ParseOptions(args);
            options.TryGetValue("report", out report);
            var action = options.GetValueOrDefault("action") ?? throw new ArgumentException("Missing --action.");
            if (action == "self-test") { SelfTest(); return 0; }
            var directory = ValidateDirectory(options.GetValueOrDefault("install-dir") ?? throw new ArgumentException("Missing --install-dir."));
            if (!int.TryParse(options.GetValueOrDefault("port", "5090"), out var port) || port is < 1 or > 65535)
                throw new ArgumentException("Port must be an integer between 1 and 65535.");
            if (action is not ("preflight" or "prepare" or "install" or "resume" or "remove"))
                throw new ArgumentException("Unknown lifecycle action.");
            if (action != "preflight") RequireAdministrator();
            if (action is not ("remove" or "resume")) CheckMachineEnvironment();
            using var manager = Native.OpenManager();
            using var service = Native.OpenServiceIfPresent(manager, action == "preflight" ? Native.ReadAccess : Native.FullAccess);
            var registration = ReadRegistration();
            var existing = service is null ? null : Native.ReadService(service);
            ValidateOwnership(directory, registration, existing);
            string result;
            switch (action)
            {
                case "preflight":
                    ProbePort(port, existing, registration);
                    result = "Preflight passed. The service and selected loopback port are available.";
                    break;
                case "prepare":
                    ProbePort(port, existing, registration);
                    var running = existing is not null && existing.State != Native.Stopped;
                    if (service is not null) Native.StopAndWait(service);
                    try { ProbePort(port, null, null); }
                    catch { if (running && service is not null) Native.StartAndWait(service); throw; }
                    result = running ? "stopped" : "ready";
                    break;
                case "install":
                    if (!File.Exists(Path.Combine(directory, "SparkStudio.Gateway.exe")) ||
                        !File.Exists(Path.Combine(directory, "runtimes", "python", "windows-x64", "python.exe")))
                        throw new InvalidOperationException("The offline gateway/Python payload is incomplete.");
                    ProbePort(port, null, null);
                    RejectReparsePoints(DataDirectory);
                    Directory.CreateDirectory(DataDirectory);
                    await InstallAsync(manager, service, registration, directory, port);
                    result = $"SparkStudio is running at http://127.0.0.1:{port}. Data is retained in {DataDirectory}.";
                    break;
                case "resume":
                    if (service is not null) Native.StartAndWait(service);
                    result = "Previously owned service resumed.";
                    break;
                default:
                    if (service is not null)
                    {
                        Native.StopAndWait(service);
                        Native.DeleteChecked(service);
                    }
                    if (registration is not null)
                        Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, throwOnMissingSubKey: false);
                    result = $"Service removed. Existing data was retained in {DataDirectory}.";
                    break;
            }
            WriteReport(report, result);
            return 0;
        }
        catch (Exception error)
        {
            var message = error is Win32Exception windows ? $"{windows.Message} (Windows error {windows.NativeErrorCode})." : error.Message;
            try { WriteReport(report, message); } catch { /* Console still reports the original failure. */ }
            Console.Error.WriteLine(message);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        if (args.Length % 2 != 0) throw new ArgumentException("Arguments must be --name value pairs.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var allowed = new HashSet<string>(["action", "install-dir", "port", "report"]);
        for (var index = 0; index < args.Length; index += 2)
        {
            var key = args[index].StartsWith("--", StringComparison.Ordinal) ? args[index][2..] : "";
            if (!allowed.Contains(key) || !result.TryAdd(key, args[index + 1])) throw new ArgumentException("Unknown or duplicate argument.");
        }
        return result;
    }

    private static void WriteReport(string? path, string message)
    {
        if (!string.IsNullOrEmpty(path)) File.WriteAllText(path, message);
        Console.WriteLine(message);
    }

    private static void RequireAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("Windows administrator approval is required to manage the service.");
    }

    private static void CheckMachineEnvironment()
    {
        foreach (var key in new[] { "SPARKSTUDIO_DATA_DIR", "SPARKSTUDIO_PYTHON" })
            if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key, EnvironmentVariableTarget.Machine)))
                throw new InvalidOperationException($"The machine environment variable {key} overrides installer configuration. Remove that override before installing this service.");
    }

    internal static string ValidateDirectory(string value)
    {
        if (value.Any(c => c < ' ' || c == '"') || !Path.IsPathFullyQualified(value) || value.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Installation must use a local absolute path without quotes or control characters.");
        var directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        if (directory.Equals(Path.GetPathRoot(directory), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The installation directory cannot be a drive root.");
        if (directory.Equals(DataDirectory, StringComparison.OrdinalIgnoreCase) || directory.StartsWith(DataDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || DataDirectory.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Program files and retained ProgramData must use separate directories.");
        RejectReparsePoints(directory);
        return directory;
    }

    private static void RejectReparsePoints(string directory)
    {
        for (var current = new DirectoryInfo(directory); current is not null; current = current.Parent)
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Service installation/data directories cannot contain symbolic links or junctions.");
    }

    internal static string Command(string directory, int port) => $"\"{Path.Combine(directory, "SparkStudio.Gateway.exe")}\" --contentRoot \"{directory}\" --DataDirectory \"{DataDirectory}\" --urls http://127.0.0.1:{port}";

    private static Registration? ReadRegistration()
    {
        using var key = Registry.LocalMachine.OpenSubKey(RegistryPath);
        if (key is null) return null;
        return new Registration(key.GetValue("ProductId") as string ?? "", key.GetValue("InstallDirectory") as string ?? "", key.GetValue("DataDirectory") as string ?? "", key.GetValue("Port") is int port ? port : 0);
    }

    private static void SaveRegistration(Registration value)
    {
        using var key = Registry.LocalMachine.CreateSubKey(RegistryPath);
        key.SetValue("ProductId", value.ProductId);
        key.SetValue("InstallDirectory", value.InstallDirectory);
        key.SetValue("DataDirectory", value.DataDirectory);
        key.SetValue("Port", value.Port, RegistryValueKind.DWord);
    }

    internal static void ValidateOwnership(string directory, Registration? registration, ServiceInfo? service)
    {
        if (registration is not null && (registration.ProductId != ProductId ||
            !registration.InstallDirectory.Equals(directory, StringComparison.OrdinalIgnoreCase) ||
            !registration.DataDirectory.Equals(DataDirectory, StringComparison.OrdinalIgnoreCase) || registration.Port is < 1 or > 65535))
            throw new InvalidOperationException("An incompatible SparkStudio installation registration exists. Use its original installer/location; this installer will not replace it.");
        if (service is not null && (registration is null ||
            !service.BinaryPath.Equals(Command(directory, registration.Port), StringComparison.OrdinalIgnoreCase) ||
            !service.Account.Equals(@"NT AUTHORITY\LocalService", StringComparison.OrdinalIgnoreCase) || service.ServiceType != Native.OwnProcess))
            throw new InvalidOperationException("The existing SparkStudio service is not owned by this installer or its configuration was changed. It has not been stopped or modified. Use its original management procedure.");
    }

    private static void ProbePort(int port, ServiceInfo? service, Registration? registration)
    {
        // An owned running service may currently occupy its recorded port. Prepare stops only
        // that verified service and repeats the bind before any payload files are overwritten.
        if (service is not null && service.State != Native.Stopped && registration?.Port == port) return;
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Server.ExclusiveAddressUse = true;
        try { listener.Start(); }
        catch (SocketException) { throw new InvalidOperationException($"Port {port} is already in use. Choose another port in the wizard (for example 5092), or stop its application yourself. No running application was modified."); }
        finally { listener.Stop(); }
    }

    private static async Task InstallAsync(ServiceHandle manager, ServiceHandle? existing, Registration? previous, string directory, int port)
    {
        ServiceHandle? created = null;
        try
        {
            var service = existing ?? (created = Native.CreateChecked(manager, Command(directory, port)));
            if (existing is not null) Native.Configure(existing, Command(directory, port));
            Native.ConfigureIdentity(service);
            // The gateway stores credentials and project code here. Do not inherit the
            // broad Users read access of ProgramData on a fresh installation.
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            foreach (var identity in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(identity, null), FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            var serviceIdentity = (SecurityIdentifier)new NTAccount(@"NT SERVICE\SparkStudio").Translate(typeof(SecurityIdentifier));
            acl.SetAccessRule(new FileSystemAccessRule(serviceIdentity, FileSystemRights.Modify | FileSystemRights.Synchronize,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(DataDirectory).SetAccessControl(acl);
            SaveRegistration(new Registration(ProductId, directory, DataDirectory, port));
            Native.StartAndWait(service);
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(45))
            {
                try
                {
                    using var response = await client.GetAsync($"http://127.0.0.1:{port}/api/health");
                    using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                    if (response.IsSuccessStatusCode && json.RootElement.TryGetProperty("pythonAvailable", out var python) && python.GetBoolean()) return;
                }
                catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException) { }
                await Task.Delay(500);
            }
            throw new InvalidOperationException("The service did not become healthy with bundled Python within 45 seconds. Inspect Windows Event Viewer before retrying. Existing data has been retained.");
        }
        catch
        {
            if (created is not null)
            {
                Native.StopAndWait(created);
                Native.DeleteChecked(created);
                if (previous is null) Registry.LocalMachine.DeleteSubKeyTree(RegistryPath, false); else SaveRegistration(previous);
            }
            else if (existing is not null && previous is not null)
            {
                Native.StopAndWait(existing);
                Native.Configure(existing, Command(previous.InstallDirectory, previous.Port));
                SaveRegistration(previous);
            }
            throw;
        }
        finally { created?.Dispose(); }
    }

    private static void SelfTest()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "SparkStudio");
        var registration = new Registration(ProductId, dir, DataDirectory, 5090);
        var good = new ServiceInfo(Command(dir, 5090), @"NT AUTHORITY\LocalService", Native.OwnProcess, Native.Stopped);
        var checks = 0;
        void Accepted(Action action) { action(); checks++; }
        void Rejected(Action action) { try { action(); } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; } throw new Exception("Expected ownership/path rejection."); }
        Accepted(() => ValidateOwnership(dir, null, null));
        Accepted(() => ValidateOwnership(dir, registration, good));
        Accepted(() => ValidateOwnership(dir.ToUpperInvariant(), registration, good));
        Rejected(() => ValidateOwnership(dir, null, good));
        Rejected(() => ValidateOwnership(dir, registration with { ProductId = "other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { InstallDirectory = @"C:\Other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { DataDirectory = @"C:\Other" }, good));
        Rejected(() => ValidateOwnership(dir, registration with { Port = 0 }, good));
        Rejected(() => ValidateOwnership(dir, registration, good with { BinaryPath = @"C:\Other\service.exe" }));
        Rejected(() => ValidateOwnership(dir, registration, good with { Account = "LocalSystem" }));
        Rejected(() => ValidateOwnership(dir, registration, good with { ServiceType = 32 }));
        Rejected(() => ValidateDirectory(@"C:\"));
        Rejected(() => ValidateDirectory("relative"));
        Rejected(() => ValidateDirectory(@"\\server\share\SparkStudio"));
        Rejected(() => ValidateDirectory("C:\\unsafe\"path"));
        Rejected(() => ValidateDirectory(DataDirectory));
        Rejected(() => ValidateDirectory(Path.Combine(DataDirectory, "bin")));
        Rejected(() => ParseOptions(["--action", "remove", "--action", "install"]));
        Rejected(() => ParseOptions(["--unknown", "value"]));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Server.ExclusiveAddressUse = true;
        listener.Start();
        try { Rejected(() => ProbePort(((IPEndPoint)listener.LocalEndpoint).Port, null, null)); }
        finally { listener.Stop(); }
        Console.WriteLine($"PASS {checks} installer ownership, path, argument and occupied-port checks; no service or registration was changed.");
    }
}

internal sealed record Registration(string ProductId, string InstallDirectory, string DataDirectory, int Port);
internal sealed record ServiceInfo(string BinaryPath, string Account, uint ServiceType, uint State);

internal sealed class ServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private ServiceHandle() : base(true) { }
    protected override bool ReleaseHandle() => Native.CloseServiceHandle(handle);
}

internal static class Native
{
    internal const uint OwnProcess = 0x10, Stopped = 1, Running = 4;
    internal const uint ReadAccess = 0x0001 | 0x0004, FullAccess = 0xF01FF;
    private const int ServiceDoesNotExist = 1060, ServiceNotActive = 1062, AlreadyRunning = 1056;

    internal static ServiceHandle OpenManager()
    {
        var result = OpenSCManager(null, null, 0x0001 | 0x0002);
        if (result.IsInvalid)
        {
            result.Dispose();
            result = OpenSCManager(null, null, 0x0001);
            if (result.IsInvalid) throw new Win32Exception();
        }
        return result;
    }

    internal static ServiceHandle? OpenServiceIfPresent(ServiceHandle manager, uint access)
    {
        var result = OpenService(manager, "SparkStudio", access);
        if (!result.IsInvalid) return result;
        var error = Marshal.GetLastWin32Error();
        result.Dispose();
        if (error == ServiceDoesNotExist) return null;
        throw new Win32Exception(error);
    }

    internal static ServiceInfo ReadService(ServiceHandle service)
    {
        QueryServiceConfig(service, IntPtr.Zero, 0, out var needed);
        if (needed == 0) throw new Win32Exception();
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceConfig(service, buffer, needed, out _)) throw new Win32Exception();
            var config = Marshal.PtrToStructure<ServiceConfiguration>(buffer);
            return new ServiceInfo(Marshal.PtrToStringUni(config.BinaryPath) ?? "", Marshal.PtrToStringUni(config.Account) ?? "", config.Type, Status(service).State);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static ServiceHandle CreateChecked(ServiceHandle manager, string command)
    {
        var result = CreateService(manager, "SparkStudio", "SparkStudio Gateway", FullAccess, OwnProcess, 2, 1, command, null, IntPtr.Zero, null, @"NT AUTHORITY\LocalService", null);
        if (result.IsInvalid) throw new Win32Exception();
        return result;
    }

    internal static void Configure(ServiceHandle service, string command)
    {
        if (!ChangeServiceConfig(service, OwnProcess, 2, 1, command, null, IntPtr.Zero, null, @"NT AUTHORITY\LocalService", null, "SparkStudio Gateway")) throw new Win32Exception();
    }

    internal static void ConfigureIdentity(ServiceHandle service)
    {
        var sid = Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(sid, 1); if (!ChangeServiceConfig2(service, 5, sid)) throw new Win32Exception(); }
        finally { Marshal.FreeHGlobal(sid); }
    }

    internal static void StartAndWait(ServiceHandle service)
    {
        if (Status(service).State == Running) return;
        if (!StartService(service, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != AlreadyRunning) throw new Win32Exception();
        Wait(service, Running);
    }

    internal static void StopAndWait(ServiceHandle service)
    {
        if (Status(service).State == Stopped) return;
        if (!ControlService(service, 1, out _) && Marshal.GetLastWin32Error() != ServiceNotActive) throw new Win32Exception();
        Wait(service, Stopped);
    }

    private static void Wait(ServiceHandle service, uint desired)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(40))
        {
            if (Status(service).State == desired) return;
            Thread.Sleep(200);
        }
        throw new InvalidOperationException($"The SparkStudio service did not reach the expected state within 40 seconds. No unrelated process was terminated.");
    }

    private static ServiceStatus Status(ServiceHandle service)
    {
        if (!QueryServiceStatus(service, out var status)) throw new Win32Exception();
        return status;
    }

    internal static void DeleteChecked(ServiceHandle service) { if (!DeleteService(service)) throw new Win32Exception(); }

    [StructLayout(LayoutKind.Sequential)] private struct ServiceConfiguration
    {
        public uint Type, StartType, ErrorControl;
        public IntPtr BinaryPath, LoadGroup;
        public uint Tag;
        public IntPtr Dependencies, Account, DisplayName;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus
    {
        public uint Type, State, AcceptedControls, Win32ExitCode, SpecificExitCode, CheckPoint, WaitHint;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle OpenService(ServiceHandle manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryServiceConfig(ServiceHandle service, IntPtr buffer, uint size, out uint required);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(ServiceHandle service, out ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern ServiceHandle CreateService(ServiceHandle manager, string name, string displayName, uint access, uint type, uint start, uint error, string path, string? group, IntPtr tag, string? dependencies, string account, string? password);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ChangeServiceConfig(ServiceHandle service, uint type, uint start, uint error, string path, string? group, IntPtr tag, string? dependencies, string account, string? password, string displayName);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ChangeServiceConfig2(ServiceHandle service, uint level, IntPtr info);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool StartService(ServiceHandle service, uint count, IntPtr arguments);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(ServiceHandle service, uint control, out ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(ServiceHandle service);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool CloseServiceHandle(IntPtr handle);
}
