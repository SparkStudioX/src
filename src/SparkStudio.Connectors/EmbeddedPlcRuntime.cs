using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using libplctag.NativeImport;

namespace SparkStudio.Connectors;

// NativeImport normally extracts next to the DLL, which is read-only in installed
// services and containers. Resolve only a verified embedded binary from our private cache.
internal static class EmbeddedPlcRuntime
{
    private static readonly object initializationLock = new();
    private static Lazy<nint>? loaded;
    private static string? initializedDataDirectory;
    internal const string WindowsRuntimeSha256 = "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7";
    private static nint windowsRuntime; // Kept loaded with libplctag for the process lifetime.
    internal static bool WindowsRuntimeLoaded => windowsRuntime != 0;
    internal static string NormalizeDataDirectory(string dataDirectory)
    {
        if (string.IsNullOrWhiteSpace(dataDirectory) || !Path.IsPathFullyQualified(dataDirectory))
            throw new ArgumentException("A fully qualified gateway data directory is required for the EtherNet/IP native cache.", nameof(dataDirectory));
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataDirectory));
    }
    internal static void EnsureAvailable(string dataDirectory)
    {
        var root = NormalizeDataDirectory(dataDirectory);
        Lazy<nint> runtime;
        lock (initializationLock)
        {
            if (loaded is null)
            {
                initializedDataDirectory = root;
                loaded = new(() => Load(root), LazyThreadSafetyMode.ExecutionAndPublication);
            }
            else if (!string.Equals(initializedDataDirectory, root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                throw new InvalidOperationException("The EtherNet/IP native runtime is already assigned to a different gateway data directory in this process.");
            runtime = loaded;
        }
        try { _ = runtime.Value; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        { throw new InvalidOperationException("The EtherNet/IP native cache could not be initialized. Check the gateway account's data-directory access.", error); }
    }

    private static nint Load(string dataRoot)
    {
        var assembly = typeof(plctag).Assembly;
        var platform = (OperatingSystem.IsWindows(), OperatingSystem.IsLinux(), RuntimeInformation.ProcessArchitecture) switch
        {
            (true, _, Architecture.X64) => ("win_x64", "plctag.dll"),
            (_, true, Architecture.X64) => ("linux_x64", "libplctag.so"),
            (_, true, Architecture.Arm64) => ("linux_ARM64", "libplctag.so"),
            _ => throw new InvalidOperationException("EtherNet/IP native libraries are packaged for Windows x64 and Linux x64/arm64 only.")
        };
        using var resource = assembly.GetManifestResourceStream($"libplctag.NativeImport.runtime.{platform.Item1}.{platform.Item2}")
            ?? throw new InvalidOperationException("The pinned EtherNet/IP package has no native binary for this platform.");
        using var content = new MemoryStream(); resource.CopyTo(content);
        var binaries = new Dictionary<string, byte[]> { [platform.Item2] = content.ToArray() };
        if (OperatingSystem.IsWindows())
        {
            using var dependency = typeof(EmbeddedPlcRuntime).Assembly.GetManifestResourceStream("SparkStudio.Native.vcruntime140.dll")
                ?? throw new InvalidOperationException("The pinned Windows native runtime dependency is missing from this build.");
            using var bytes = new MemoryStream(); dependency.CopyTo(bytes);
            using var verification = new MemoryStream(bytes.ToArray(), false);
            Verify(verification, Convert.FromHexString(WindowsRuntimeSha256));
            binaries.Add("vcruntime140.dll", bytes.ToArray());
        }
        var retained = RetainVerifiedBundle(binaries, Path.Combine(dataRoot, "native-libraries"));
        var path = retained[platform.Item2];
        // Keep the read handle open through loading. Windows prohibits replacement and
        // writing while this handle is open; Unix files live under a mode-0700 directory.
        var held = new List<FileStream>();
        nint dependencyHandle = 0, handle = 0;
        try
        {
            foreach (var pair in retained)
            {
                var file = new FileStream(pair.Value, FileMode.Open, FileAccess.Read, FileShare.Read);
                held.Add(file); Verify(file, SHA256.HashData(binaries[pair.Key]));
            }
            if (OperatingSystem.IsWindows())
            {
                dependencyHandle = NativeLibrary.Load(retained["vcruntime140.dll"]);
                var actual = new StringBuilder(32768);
                if (GetModuleFileName(dependencyHandle, actual, actual.Capacity) == 0 ||
                    !string.Equals(actual.ToString(), retained["vcruntime140.dll"], StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The native Windows runtime was not loaded from its verified bundled location.");
            }
            plctag.ForceExtractLibrary = false;
            handle = NativeLibrary.Load(path);
            NativeLibrary.SetDllImportResolver(assembly, (name, _, _) => name == "plctag" ? handle : nint.Zero);
            windowsRuntime = dependencyHandle;
            return handle; // Process-wide SDK code may still be executing; never unload it per session.
        }
        catch { if (handle != 0) NativeLibrary.Free(handle); if (dependencyHandle != 0) NativeLibrary.Free(dependencyHandle); throw; }
        finally { foreach (var file in held) file.Dispose(); }
    }

    [DllImport("kernel32.dll", EntryPoint = "GetModuleFileNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetModuleFileName(nint module, StringBuilder name, int capacity);

    internal static IReadOnlyDictionary<string, string> RetainVerifiedBundle(IReadOnlyDictionary<string, byte[]> binaries, string cache)
    {
        using var identity = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var pair in binaries.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(pair.Key) || pair.Key != Path.GetFileName(pair.Key)) throw new ArgumentException("Native cache file names must not contain directories.");
            identity.AppendData(Encoding.UTF8.GetBytes(pair.Key + '\0')); identity.AppendData(SHA256.HashData(pair.Value));
        }
        cache = Path.GetFullPath(cache); RejectLinks(cache); CreatePrivate(cache);
        var directory = Path.Combine(cache, Convert.ToHexStringLower(identity.GetHashAndReset()));
        CreatePrivate(directory);
        return binaries.ToDictionary(pair => pair.Key, pair => RetainFile(pair.Value, directory, pair.Key));
    }

    internal static string RetainVerified(byte[] bytes, string cache, string name)
    {
        if (name != Path.GetFileName(name)) throw new ArgumentException("Native cache file names must not contain directories.");
        cache = Path.GetFullPath(cache);
        RejectLinks(cache);
        CreatePrivate(cache);
        var hash = SHA256.HashData(bytes);
        var directory = Path.Combine(cache, Convert.ToHexStringLower(hash));
        CreatePrivate(directory);
        return RetainFile(bytes, directory, name);
    }

    private static string RetainFile(byte[] bytes, string directory, string name)
    {
        var hash = SHA256.HashData(bytes);
        var target = Path.Combine(directory, name);
        RejectLinks(target);
        if (!File.Exists(target))
        {
            var temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using (var file = new FileStream(temporary, options)) { file.Write(bytes); file.Flush(true); }
                try { File.Move(temporary, target, false); }
                catch (IOException) when (File.Exists(target)) { /* Another process completed the same hash first. */ }
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        RejectLinks(target);
        using (var file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read)) Verify(file, hash);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        return target;
    }

    private static void Verify(Stream stream, byte[] expected)
    {
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(stream), expected))
            throw new InvalidOperationException("The cached EtherNet/IP native library differs from its bundled package resource.");
    }

    private static void CreatePrivate(string directory)
    {
        RejectLinks(directory);
        if (OperatingSystem.IsWindows())
        {
            var identity = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("The native cache requires a Windows user identity.");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(identity);
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(directory).Create(security);
            new DirectoryInfo(directory).SetAccessControl(security);
        }
        else
        {
            Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        RejectLinks(directory);
    }

    private static void RejectLinks(string path)
    {
        for (var current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
        {
            // GetAttributes also detects dangling symlinks; File/Directory.Exists does not.
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("The EtherNet/IP native cache must not contain symbolic links or reparse points.");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
}
