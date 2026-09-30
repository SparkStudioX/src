namespace SparkStudio.Gateway;

/// <summary>Caller authority follows queued Python messages without retaining an HTTP request.</summary>
public sealed class PythonExecutionAccess(Func<string, bool> canRead, Func<string, bool> canWrite)
{
    private static readonly AsyncLocal<PythonExecutionAccess?> Ambient = new();
    public static PythonExecutionAccess? Current => Ambient.Value;

    public void RequireTags(IEnumerable<string> paths, bool write)
    {
        // Validate the complete batch before any tag operation can have a side effect.
        if (paths.Any(path => !(write ? canWrite(path) : canRead(path))))
            throw new UnauthorizedAccessException("A requested tag is outside this operator session's permitted scope.");
    }

    public static IDisposable Enter(PythonExecutionAccess? access)
    {
        var previous = Ambient.Value;
        Ambient.Value = access;
        return new Restore(previous);
    }

    private sealed class Restore(PythonExecutionAccess? previous) : IDisposable
    {
        public void Dispose() => Ambient.Value = previous;
    }
}
