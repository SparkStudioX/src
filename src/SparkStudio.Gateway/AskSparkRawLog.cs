using System.Text;
using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Principal;

namespace SparkStudio.Gateway;

/// <summary>Optional complete plaintext provider exchanges. Callers supply bodies, never authentication headers.</summary>
public sealed class AskSparkRawLog(string directory, AskSparkSettings settings, ILogger<AskSparkRawLog>? logger = null) : IDisposable
{
    public const string DirectoryName = "askspark";
    private const int MaximumHeaderBytes = 2048;
    private const string Prefix = "ASK_SPARK_RAW_V1 ";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly Action<ILogger, Exception?> WriteWarning = LoggerMessage.Define(LogLevel.Warning,
        new EventId(1, "AskSparkRawLogUnavailable"), "Ask Spark raw provider logging could not write its exchange file. The provider operation continues.");
    private sealed record Header(DateTimeOffset Timestamp, string ExchangeId, string Operation, string Direction,
        int? StatusCode, int BodyBytes, int RetainedBytes, int OmittedBytes);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly string logDirectory = Path.Combine(directory, DirectoryName);
    private readonly Dictionary<string, string> pending = new(StringComparer.Ordinal);
    private bool permissionsReady;

    /// <summary>Append an exact body with correlation metadata. File failures and canceled logging never fail a provider operation.</summary>
    public async Task WriteAsync(string operation, string exchangeId, string direction, string? rawBody,
        int? statusCode = null, CancellationToken cancellation = default)
    {
        if (cancellation.IsCancellationRequested) return;
        try { await gate.WaitAsync(cancellation); }
        catch (OperationCanceledException) { return; }
        try
        {
            if (cancellation.IsCancellationRequested || !settings.Snapshot().LoggingEnabled) return;
            Append(exchangeId, CreateRecord(operation, exchangeId, direction, rawBody ?? "", statusCode));
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or System.Security.SecurityException
            or System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException or ArgumentException)
        {
            // Never put filesystem exception text or raw payloads into ordinary server logs.
            if (logger is not null) WriteWarning(logger, null);
        }
        finally
        {
            if (direction != "request") pending.Remove(exchangeId);
            gate.Release();
        }
    }

    private void Append(string exchangeId, byte[] record)
    {
        RecoveryFileSystem.RejectLinks(logDirectory);
        EnsurePrivateDirectory();
        if (!pending.TryGetValue(exchangeId, out var path))
        {
            var suffix = exchangeId.Length is > 0 and <= 128
                && exchangeId.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_')
                ? exchangeId : Guid.NewGuid().ToString("N");
            var timestamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd'T'HHmmss.fffffff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            path = Path.Combine(logDirectory, $"{timestamp}-{suffix}.txt");
            pending[exchangeId] = path;
        }
        RecoveryFileSystem.RejectLinks(path);
        var options = new FileStreamOptions { Mode = FileMode.Append, Access = FileAccess.Write, Share = FileShare.Read };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using var file = new FileStream(path, options);
        RecoveryFileSystem.CheckOrdinaryFile(file);
        RestrictFile(path);
        file.Write(record);
        file.Flush();
    }

    private void EnsurePrivateDirectory()
    {
        if (permissionsReady) return;
        if (!Directory.Exists(logDirectory)) RecoveryFileSystem.CreatePrivateDirectory(logDirectory);
        else if (OperatingSystem.IsWindows())
        {
            var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
            foreach (var identity in PrivateIdentities()) acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(logDirectory).SetAccessControl(acl);
        }
        else File.SetUnixFileMode(logDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        // Upgrade existing exchange files without modifying their contents or retention.
        foreach (var path in Directory.EnumerateFiles(logDirectory, "*.txt"))
        {
            using var file = RecoveryFileSystem.OpenSource(path);
            RestrictFile(path);
        }
        permissionsReady = true;
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static SecurityIdentifier[] PrivateIdentities() => [WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("The gateway service identity is unavailable."),
        new(WellKnownSidType.BuiltinAdministratorsSid, null), new(WellKnownSidType.LocalSystemSid, null)];

    private static void RestrictFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false);
            foreach (var identity in PrivateIdentities()) acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(acl);
        }
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    private static byte[] CreateRecord(string operation, string exchangeId, string direction, string rawBody, int? statusCode)
    {
        var body = Encoding.UTF8.GetBytes(rawBody);
        var metadata = new Header(DateTimeOffset.UtcNow, Bounded(exchangeId), Bounded(operation), Bounded(direction),
            statusCode, body.Length, body.Length, 0);
        var header = Encoding.UTF8.GetBytes(Prefix + JsonSerializer.Serialize(metadata, Json) + "\n");
        if (header.Length > MaximumHeaderBytes) throw new InvalidDataException("Ask Spark raw log metadata exceeded its size limit.");
        var record = new byte[checked(header.Length + body.Length + 1)];
        header.CopyTo(record, 0);
        body.CopyTo(record, header.Length);
        record[^1] = (byte)'\n';
        return record;
    }

    private static string Bounded(string value) => value[..Math.Min(value.Length, 128)];

    public void Dispose() { gate.Dispose(); GC.SuppressFinalize(this); }
}
