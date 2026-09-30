using System.Globalization;
using System.Net;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace SparkStudio.Gateway;

public sealed record BackupDestination(string Kind, string Address, string? Username = null, string? Password = null,
    string? Domain = null, int TimeoutSeconds = 300)
{
    // The temporary cleartext credential DTO must not acquire a secret-bearing generated ToString.
    public override string ToString() => "BackupDestination { credentials redacted }";
}
public sealed record BackupDeliveryResult(string ArchiveName, long Bytes, string Sha256, int RemovedCount, string? RetentionWarning);

/// <summary>Delivers already encrypted archives. No destination exception or server reply is exposed to callers.</summary>
public static class BackupDestinations
{
    private const int MaximumEntries = 10_000, MaximumListingBytes = 1024 * 1024;
    private const long MaximumArchiveBytes = GatewayRecovery.MaxTotalBytes + 32L * 1024 * 1024;
    private const string DateFormat = "yyyyMMdd'T'HHmmssfff'Z'";
    private static readonly Regex ArchivePattern = new(@"\Asparkstudio-([0-9a-f]{32})-([0-9]{8}T[0-9]{9}Z)-([0-9a-f]{32})\.sparkbak\z", RegexOptions.CultureInvariant);
    // UNC metadata calls can be delayed in Windows even after cancellation. Keep at most one
    // such worker alive; a timed-out attempt retains this gate until its real IO completes.
    private static readonly SemaphoreSlim SmbWorker = new(1, 1);

    public static string CreateArchiveName(Guid ownerId, DateTimeOffset utc, Guid runId)
    {
        if (ownerId == Guid.Empty || runId == Guid.Empty) throw new ArgumentException("Backup owner and run IDs must be nonempty.");
        return $"sparkstudio-{ownerId:N}-{utc.UtcDateTime.ToString(DateFormat, CultureInfo.InvariantCulture)}-{runId:N}.sparkbak";
    }

    public static BackupDestination Validate(BackupDestination destination)
    {
        if (destination is null || destination.Kind is not ("smb" or "ftp" or "ftps")) throw new ArgumentException("Backup destination must be SMB, FTP or explicit FTPS.");
        if (destination.TimeoutSeconds is < 30 or > 3600) throw new ArgumentException("Backup destination timeout must be 30–3600 seconds.");
        if (string.IsNullOrWhiteSpace(destination.Address) || destination.Address.Length > 1000 || destination.Address.Any(c => char.IsControl(c)))
            throw new ArgumentException("An ordinary destination address is required.");
        foreach (var value in new[] { destination.Username, destination.Domain })
            if (value is { Length: > 256 } || value?.Any(char.IsControl) == true) throw new ArgumentException("Destination user and domain must be bounded names without control characters.");
        if (destination.Password is { Length: > 4096 } || destination.Password?.Any(c => c is '\r' or '\n' or '\0') == true)
            throw new ArgumentException("Destination password is too long or contains an unsupported control character.");
        if (string.IsNullOrEmpty(destination.Username) && (!string.IsNullOrEmpty(destination.Password) || !string.IsNullOrEmpty(destination.Domain)))
            throw new ArgumentException("A destination username is required when supplying a password or domain.");
        if (destination.Kind == "smb")
        {
            var address = destination.Address.TrimEnd('\\');
            if (!address.StartsWith(@"\\", StringComparison.Ordinal) || address.StartsWith(@"\\?\", StringComparison.Ordinal) || address.StartsWith(@"\\.\", StringComparison.Ordinal)
                || address.Contains('/') || address.Contains(':') || address.Contains('"'))
                throw new ArgumentException(@"SMB needs an ordinary UNC directory such as \\server\share\folder; device and mapped-drive paths are not accepted.");
            var parts = address[2..].Split('\\');
            if (parts.Length < 2 || parts.Any(part => part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.Any(c => c is '*' or '?' or '<' or '>' or '|')))
                throw new ArgumentException("SMB needs a server/share and ordinary directory segments without traversal or wildcards.");
            if (destination.Username?.Contains('\\') == true && (destination.Username.Split('\\') is not [var domain, var user] || domain.Length == 0 || user.Length == 0 || !string.IsNullOrEmpty(destination.Domain)))
                throw new ArgumentException("Use domain\\username or separate username and domain, not both.");
            return destination with { Address = address, Username = EmptyToNull(destination.Username), Domain = EmptyToNull(destination.Domain) };
        }
        if (!Uri.TryCreate(destination.Address, UriKind.Absolute, out var uri) || uri.Scheme != "ftp" || uri.Host.Length == 0 || uri.Port is < 1 or > 65535
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || destination.Address.Contains('\\') || destination.Address.Contains('%'))
            throw new ArgumentException("FTP and explicit FTPS use ftp://host:port/directory/ without embedded credentials, query, fragment or encoded path characters.");
        if (!string.IsNullOrEmpty(destination.Domain)) throw new ArgumentException("The separate domain field is used only for SMB.");
        // Uri removes dot segments while canonicalizing; reject them in the original input first.
        if (destination.Address.Split('/').Any(part => part is "." or "..")) throw new ArgumentException("FTP directory traversal is not accepted.");
        var ftpParts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (ftpParts.Any(part => part is "." or ".." || part.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))))
            throw new ArgumentException("FTP directory segments must use letters, digits, periods, underscores or hyphens.");
        if (string.IsNullOrEmpty(destination.Username)) throw new ArgumentException("FTP needs an explicit username; anonymous access must be selected explicitly as username anonymous.");
        return destination with { Address = uri.GetLeftPart(UriPartial.Authority) + "/" + (ftpParts.Length == 0 ? "" : string.Join('/', ftpParts) + "/"), Domain = null };
    }

    public static async Task<BackupDeliveryResult> DeliverAsync(BackupDestination destination, string localArchivePath,
        string archiveName, Guid ownerId, int retentionDays = 7, CancellationToken cancellationToken = default)
    {
        destination = Validate(destination);
        if (destination.Kind == "smb" && !string.IsNullOrEmpty(destination.Username) && string.IsNullOrEmpty(destination.Password))
            throw new ArgumentException("Explicit SMB credentials require a password; leave both fields empty to use the service identity.");
        if (ownerId == Guid.Empty || !TryOwnedArchive(archiveName, ownerId, out _)) throw new ArgumentException("The archive name must match this gateway's generated backup identity.");
        if (retentionDays is < 1 or > 3650) throw new ArgumentException("Backup retention must be 1–3650 days.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(destination.TimeoutSeconds));
        var token = deadline.Token;
        var progress = new DeliveryProgress();
        Task<BackupDeliveryResult>? operation = null;
        try
        {
            if (destination.Kind == "smb")
            {
                if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("SMB backup delivery is currently supported by the Windows gateway.");
                await SmbWorker.WaitAsync(token);
                operation = Task.Run(async () =>
                {
                    try { return await WithSmbIdentity(destination, () => DeliverCoreAsync(new DirectoryRemote(destination.Address), localArchivePath, archiveName, ownerId, retentionDays, progress, token)); }
                    finally { SmbWorker.Release(); }
                }, CancellationToken.None);
            }
            else operation = DeliverCoreAsync(new FtpRemote(destination), localArchivePath, archiveName, ownerId, retentionDays, progress, token);
            // Observe late faults when a native UNC operation has outlived its deadline.
            _ = operation.ContinueWith(task => _ = task.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return await operation.WaitAsync(token);
        }
        catch (OperationCanceledException) when (progress.Committed is not null)
        { return progress.Committed with { RemovedCount = progress.Removed, RetentionWarning = RetentionIncomplete }; }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new TimeoutException("Backup destination exceeded its delivery deadline. No retention is started after timeout; a partial upload may need manual cleanup."); }
        catch (OperationCanceledException) { throw; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or WebException or SecurityException or System.ComponentModel.Win32Exception or InvalidOperationException or DecoderFallbackException or AuthenticationException)
        { throw new InvalidOperationException("Backup destination delivery or verification failed. Check connectivity, destination permissions and credentials; previous backups are retained unless this delivery had already completed and retention had begun."); }
    }

    private static async Task<BackupDeliveryResult> WithSmbIdentity(BackupDestination destination, Func<Task<BackupDeliveryResult>> action)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("SMB backup delivery requires Windows.");
        if (string.IsNullOrEmpty(destination.Username)) return await action();
        var username = destination.Username; var domain = destination.Domain;
        if (username.Contains('\\'))
        {
            var parts = username.Split('\\');
            if (parts.Length != 2 || !string.IsNullOrEmpty(domain)) throw new ArgumentException("Use domain\\username or separate username and domain, not both.");
            domain = parts[0]; username = parts[1];
        }
        if (!LogonUser(username, domain, destination.Password!, 9 /* LOGON32_LOGON_NEW_CREDENTIALS */, 3 /* WINNT50 */, out var token))
            throw new UnauthorizedAccessException("SMB network logon failed.");
        using (token) return await WindowsIdentity.RunImpersonatedAsync(token, action);
    }

    private static async Task<BackupDeliveryResult> DeliverCoreAsync(IRemote remote, string localArchivePath, string archiveName,
        Guid ownerId, int retentionDays, DeliveryProgress progress, CancellationToken cancellation)
    {
        using var local = RecoveryFileSystem.OpenSource(Path.GetFullPath(localArchivePath));
        var length = local.Length;
        if (length is < 80 or > MaximumArchiveBytes) throw new InvalidDataException("Only bounded encrypted gateway archives can be delivered.");
        var magic = new byte[8]; await local.ReadExactlyAsync(magic, cancellation);
        if (!magic.AsSpan().SequenceEqual("SPARKBAK"u8)) throw new InvalidDataException("Only encrypted .sparkbak archives can be delivered.");
        local.Position = 0;
        var digest = await SHA256.HashDataAsync(local, cancellation); local.Position = 0;
        var names = await remote.ListAsync(cancellation);
        if (names.Contains(archiveName, StringComparer.Ordinal)) throw new IOException("The archive already exists at the destination.");
        var temporary = "." + archiveName + "." + Guid.NewGuid().ToString("N") + ".partial";
        var committed = false;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            await remote.UploadAsync(temporary, local, length, cancellation);
            await remote.VerifyAsync(temporary, length, digest, cancellation);
            cancellation.ThrowIfCancellationRequested();
            await remote.RenameAsync(temporary, archiveName, cancellation);
            committed = true;
            progress.Committed = new(archiveName, length, Convert.ToHexString(digest).ToLowerInvariant(), 0, null);
        }
        finally
        {
            if (!committed && !cancellation.IsCancellationRequested)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await remote.DeleteAsync(temporary, cleanup.Token); } catch { /* Never delete another path or expose a server reply. */ }
            }
        }
        var removed = 0; string? warning = null;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            // List again only after the full upload/readback/rename completed. Partial names and
            // entries with path separators never match; clocks on the destination are irrelevant.
            names = await remote.ListAsync(cancellation);
            var cutoff = DateTimeOffset.UtcNow.AddDays(-retentionDays);
            foreach (var name in names)
            {
                cancellation.ThrowIfCancellationRequested();
                if (name == archiveName || !TryOwnedArchive(name, ownerId, out var created) || created >= cutoff) continue;
                await remote.DeleteAsync(name, cancellation); removed++; progress.Removed = removed;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or WebException or OperationCanceledException or InvalidOperationException or SecurityException or DecoderFallbackException or AuthenticationException)
        { warning = RetentionIncomplete; }
        return new(archiveName, length, Convert.ToHexString(digest).ToLowerInvariant(), removed, warning);
    }

    public static bool IsOwnedArchiveName(string name, Guid ownerId) => ownerId != Guid.Empty && TryOwnedArchive(name, ownerId, out _);

    internal static bool TryOwnedArchive(string name, Guid ownerId, out DateTimeOffset created)
    {
        created = default;
        if (name is null || name.Length > 150) return false;
        var match = ArchivePattern.Match(name);
        return match.Success && match.Groups[1].Value == ownerId.ToString("N") && match.Groups[3].Value != Guid.Empty.ToString("N")
            && DateTimeOffset.TryParseExact(match.Groups[2].Value, DateFormat, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out created);
    }

    internal static Task<BackupDeliveryResult> DeliverDirectoryFixtureAsync(string directory, string archive, string name, Guid owner, int days, CancellationToken token)
        => DeliverCoreAsync(new DirectoryRemote(directory), archive, name, owner, days, new DeliveryProgress(), token);
    private const string RetentionIncomplete = "The new archive was verified and delivered, but retention was not completed. Some expired archives may remain.";
    private sealed class DeliveryProgress
    {
        public volatile BackupDeliveryResult? Committed;
        public volatile int Removed;
    }
    private static string? EmptyToNull(string? value) => string.IsNullOrEmpty(value) ? null : value;

    private interface IRemote
    {
        Task<string[]> ListAsync(CancellationToken cancellation);
        Task UploadAsync(string name, Stream source, long length, CancellationToken cancellation);
        Task VerifyAsync(string name, long length, byte[] digest, CancellationToken cancellation);
        Task RenameAsync(string source, string destination, CancellationToken cancellation);
        Task DeleteAsync(string name, CancellationToken cancellation);
    }

    private sealed class DirectoryRemote(string directory) : IRemote
    {
        private string FilePath(string name)
        {
            if (name != Path.GetFileName(name) || name.Contains('/') || name.Contains('\\')) throw new InvalidDataException("Remote file name is invalid.");
            var path = Path.Combine(directory, name);
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Backup target entries must be ordinary files.");
            return path;
        }
        public Task<string[]> ListAsync(CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            var result = new List<string>();
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                cancellation.ThrowIfCancellationRequested();
                if (result.Count >= MaximumEntries) throw new IOException("Backup destination listing exceeds its entry limit.");
                result.Add(Path.GetFileName(entry));
            }
            return Task.FromResult(result.ToArray());
        }
        public async Task UploadAsync(string name, Stream source, long length, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            await using var destination = new FileStream(FilePath(name), FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.Asynchronous);
            await source.CopyToAsync(destination, 1024 * 1024, cancellation); await destination.FlushAsync(cancellation);
            cancellation.ThrowIfCancellationRequested(); destination.Flush(true);
        }
        public async Task VerifyAsync(string name, long length, byte[] digest, CancellationToken cancellation)
        {
            using var source = new FileStream(FilePath(name), FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.Asynchronous);
            if (source.Length != length || !CryptographicOperations.FixedTimeEquals(await SHA256.HashDataAsync(source, cancellation), digest)) throw new IOException("Destination verification failed.");
        }
        public Task RenameAsync(string source, string destination, CancellationToken cancellation)
        { cancellation.ThrowIfCancellationRequested(); File.Move(FilePath(source), FilePath(destination), overwrite: false); return Task.CompletedTask; }
        public Task DeleteAsync(string name, CancellationToken cancellation)
        { cancellation.ThrowIfCancellationRequested(); File.Delete(FilePath(name)); return Task.CompletedTask; }
    }

    private sealed class FtpRemote(BackupDestination destination) : IRemote
    {
        private FtpOperation Request(string? name, string method, CancellationToken cancellation)
        {
            // No new dependency is needed for the offline preview. FtpWebRequest is obsolete
            // for new general-purpose clients, but still supplies bounded FTP/explicit FTPS.
            // A future maintained transport can replace this private adapter without changing settings.
#pragma warning disable SYSLIB0014
            var request = (FtpWebRequest)WebRequest.Create(new Uri(new Uri(destination.Address), name is null ? "" : Uri.EscapeDataString(name)));
            if (destination.Kind == "ftps" && ServicePointManager.ServerCertificateValidationCallback is not null)
                throw new InvalidOperationException("FTPS requires the default strict certificate validation policy.");
#pragma warning restore SYSLIB0014
            request.Method = method; request.Credentials = new NetworkCredential(destination.Username, destination.Password ?? "");
            request.EnableSsl = destination.Kind == "ftps"; request.UsePassive = true; request.UseBinary = true; request.KeepAlive = false;
            request.Proxy = null; request.Timeout = destination.TimeoutSeconds * 1000; request.ReadWriteTimeout = destination.TimeoutSeconds * 1000;
            return new(request, cancellation);
        }
        public async Task<string[]> ListAsync(CancellationToken cancellation)
        {
            using var operation = Request(null, WebRequestMethods.Ftp.ListDirectory, cancellation);
            using var response = (FtpWebResponse)await operation.Request.GetResponseAsync();
            await using var stream = response.GetResponseStream(); using var bytes = new MemoryStream();
            var buffer = new byte[4096]; int count;
            while ((count = await stream.ReadAsync(buffer, cancellation)) != 0)
            { if (bytes.Length + count > MaximumListingBytes) throw new IOException("FTP listing exceeds its byte limit."); await bytes.WriteAsync(buffer.AsMemory(0, count), cancellation); }
            var text = new UTF8Encoding(false, true).GetString(bytes.ToArray());
            var names = text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(value => value.TrimEnd('\r')).ToArray();
            if (names.Length > MaximumEntries) throw new IOException("FTP listing exceeds its entry limit.");
            return names;
        }
        public async Task UploadAsync(string name, Stream source, long length, CancellationToken cancellation)
        {
            using var operation = Request(name, WebRequestMethods.Ftp.UploadFile, cancellation);
            operation.Request.ContentLength = length;
            await using (var output = await operation.Request.GetRequestStreamAsync()) { await source.CopyToAsync(output, 1024 * 1024, cancellation); await output.FlushAsync(cancellation); }
            using var response = (FtpWebResponse)await operation.Request.GetResponseAsync();
        }
        public async Task VerifyAsync(string name, long length, byte[] digest, CancellationToken cancellation)
        {
            using var operation = Request(name, WebRequestMethods.Ftp.DownloadFile, cancellation);
            using var response = (FtpWebResponse)await operation.Request.GetResponseAsync();
            await using var stream = response.GetResponseStream(); using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[1024 * 1024]; long total = 0; int count;
            while ((count = await stream.ReadAsync(buffer, cancellation)) != 0)
            { total += count; if (total > length) throw new IOException("FTP verification length changed."); hash.AppendData(buffer, 0, count); }
            if (total != length || !CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), digest)) throw new IOException("FTP readback verification failed.");
        }
        public async Task RenameAsync(string source, string target, CancellationToken cancellation)
        { using var operation = Request(source, WebRequestMethods.Ftp.Rename, cancellation); operation.Request.RenameTo = target; using var response = (FtpWebResponse)await operation.Request.GetResponseAsync(); }
        public async Task DeleteAsync(string name, CancellationToken cancellation)
        { using var operation = Request(name, WebRequestMethods.Ftp.DeleteFile, cancellation); using var response = (FtpWebResponse)await operation.Request.GetResponseAsync(); }
    }
    private sealed class FtpOperation : IDisposable
    {
        public FtpWebRequest Request { get; }
        private readonly CancellationTokenRegistration abort;
        public FtpOperation(FtpWebRequest request, CancellationToken cancellation) { cancellation.ThrowIfCancellationRequested(); Request = request; abort = cancellation.Register(static state => ((FtpWebRequest)state!).Abort(), request); }
        public void Dispose() { abort.Dispose(); Request.Abort(); }
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool LogonUser(string username, string? domain, string password, int type, int provider, out SafeAccessTokenHandle token);
}
