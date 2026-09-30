internal static class TestEnvironment
{
    public static string PythonExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("SPARKSTUDIO_PYTHON");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!Path.IsPathFullyQualified(configured) || !File.Exists(configured)) throw new InvalidOperationException("SPARKSTUDIO_PYTHON must identify an existing absolute executable path.");
            return configured;
        }
        // Discover from the assembly, never the caller's current directory. Isolated
        // --artifacts-path output remains beneath the checkout.
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "runtimes", "python", "windows-x64", "python.exe");
            if (OperatingSystem.IsWindows() && File.Exists(candidate)) return candidate;
        }
        if (!OperatingSystem.IsWindows() && File.Exists("/usr/bin/python3")) return "/usr/bin/python3";
        throw new InvalidOperationException("CPython is required. Set SPARKSTUDIO_PYTHON to its absolute executable path or run tools/bootstrap.ps1.");
    }
}
