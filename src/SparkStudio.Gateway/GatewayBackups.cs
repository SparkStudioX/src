using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

public sealed record BackupDestinationSettings(string Kind, string Address, string? Username = null, string? Domain = null, int TimeoutSeconds = 300);
public sealed record BackupScheduleSettings(bool Enabled, string DailyTime, string TimeZoneId, int RetentionDays, BackupDestinationSettings Destination);
public sealed record BackupSettingsRequest(string Revision, BackupScheduleSettings Settings, string? DestinationPassword = null, string? ArchivePassphrase = null, bool ClearDestinationPassword = false);
public sealed record BackupRunRequest(bool Deliver);
public sealed record BackupRunStatus(string Id, string Status, DateTimeOffset StartedAt, DateTimeOffset? CompletedAt, string Message, string? ArchiveName = null, long? Bytes = null, int RemovedCount = 0);
public sealed record BackupSettingsDocument(int Version, Guid OwnerId, string Revision, BackupScheduleSettings Settings, string? ProtectedDestinationPassword, string? ProtectedArchivePassphrase);
public sealed record BackupRunDocument(int Version, string? LastScheduledDate, BackupRunStatus? LastRun, string? DownloadId, string? ArchiveName);

/// <summary>One configuration snapshot at a time; uploads never hold the configuration monitor.</summary>
public sealed class GatewayBackups : BackgroundService
{
    public const string Coverage = "Configuration only: projects, publications, scripts, assets, users/grants, tags, connections, keys, certificates and gateway settings. Database contents, audit/history and other runtime files are excluded. Use the offline full backup and database-specific backups for those.";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true, UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
    private readonly string directory, settingsPath, statePath, workDirectory;
    private readonly IDataProtector protector;
    private readonly RecoveryQuarantine recovery;
    private readonly SecurityStore security;
    private readonly CancellationTokenSource shutdown;
    private BackupSettingsDocument document;
    private BackupRunDocument state = new(1, null, null, null, null);
    private string diskRevision = "unreadable";
    private string? configurationError;
    private Task? activeRun;

    public GatewayBackups(string directory, IDataProtectionProvider protection, RecoveryQuarantine recovery, SecurityStore security, IHostApplicationLifetime lifetime)
    {
        this.directory = Path.GetFullPath(directory); this.recovery = recovery; this.security = security;
        protector = protection.CreateProtector("SparkStudio.BackupSettings.v1");
        settingsPath = Path.Combine(this.directory, "backup-settings.json"); statePath = Path.Combine(this.directory, "backup-state.json");
        workDirectory = Path.Combine(this.directory, "backup-work"); shutdown = CancellationTokenSource.CreateLinkedTokenSource(lifetime.ApplicationStopping);
        document = new(1, Guid.NewGuid(), Guid.NewGuid().ToString("N"), Defaults(), null, null);
        lock (GatewayConfigurationLock.SyncRoot)
        {
            try
            {
                diskRevision = Fingerprint(settingsPath);
                if (File.Exists(settingsPath))
                {
                    document = Read<BackupSettingsDocument>(settingsPath);
                    if (document.Version != 1 || document.OwnerId == Guid.Empty || string.IsNullOrWhiteSpace(document.Revision)) throw new InvalidDataException();
                    ValidateSettings(document.Settings);
                }
                else { Write(settingsPath, document); diskRevision = Fingerprint(settingsPath); }
            }
            catch (Exception error) when (IsStorageError(error))
            { document = new(1, Guid.NewGuid(), diskRevision, Defaults(), null, null); configurationError = "Saved backup settings are invalid or unreadable. Scheduling is disabled. Review and save replacement settings."; }
            try { if (File.Exists(statePath)) state = Read<BackupRunDocument>(statePath); }
            catch (Exception error) when (IsStorageError(error)) { state = new(1, null, null, null, null); }
            if (state.Version != 1) state = new(1, null, null, null, null);
            if (state.LastRun?.Status == "running")
                state = state with { LastRun = state.LastRun with { Status = "failed", CompletedAt = DateTimeOffset.UtcNow, Message = "The gateway stopped before this backup completed. No completed remote copy is assumed." } };
        }
    }

    public static BackupScheduleSettings Defaults() => new(false, "02:00", TimeZoneInfo.Local.Id, 7, new("smb", ""));
    public object Snapshot()
    {
        lock (GatewayConfigurationLock.SyncRoot) return new
        {
            document.Revision, saved = document.Settings,
            hasDestinationPassword = document.ProtectedDestinationPassword is not null,
            hasArchivePassphrase = document.ProtectedArchivePassphrase is not null,
            gatewayTimeZoneId = TimeZoneInfo.Local.Id, running = activeRun is { IsCompleted: false },
            nextDueAt = !recovery.Active && configurationError is null && document.Settings.Enabled ? NextDue(document.Settings, state.LastScheduledDate, DateTimeOffset.UtcNow) : (DateTimeOffset?)null,
            lastRun = state.LastRun, downloadId = DownloadExists() ? state.DownloadId : null,
            recoveryBlocked = recovery.Active, coverage = Coverage, configurationError
        };
    }

    public object Save(BackupSettingsRequest request)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (activeRun is { IsCompleted: false }) throw new InvalidOperationException("Wait for the current backup before changing settings.");
            if (request.Revision != document.Revision || Fingerprint(settingsPath) != diskRevision) throw new InvalidOperationException("Backup settings changed. Reload and review them again.");
            ValidateSettings(request.Settings);
            if (request.ArchivePassphrase is not null && request.ArchivePassphrase.Length is < 12 or > 1024) throw new ArgumentException("The archive passphrase must contain 12–1024 characters.");
            if (request.DestinationPassword?.Length > 4096 || request.ClearDestinationPassword && request.DestinationPassword is not null) throw new ArgumentException("Choose a replacement destination password or clear it.");
            var secret = request.ArchivePassphrase is null ? document.ProtectedArchivePassphrase : protector.Protect(request.ArchivePassphrase);
            var password = request.ClearDestinationPassword ? null : request.DestinationPassword is null ? document.ProtectedDestinationPassword : protector.Protect(request.DestinationPassword);
            if (request.Settings.Enabled && secret is null) throw new ArgumentException("Set an archive passphrase before enabling scheduled backups.");
            var next = new BackupSettingsDocument(1, document.OwnerId, Guid.NewGuid().ToString("N"), request.Settings, password, secret);
            Write(settingsPath, next); document = next; diskRevision = Fingerprint(settingsPath); configurationError = null;
            return Snapshot();
        }
    }

    public object StartManual(bool deliver, SecurityUser actor)
    {
        lock (GatewayConfigurationLock.SyncRoot) { StartRun(deliver, null, actor); return Snapshot(); }
    }

    private void StartRun(bool deliver, string? scheduledDate, SecurityUser? actor)
    {
        recovery.EnsureOperationsAllowed();
        if (configurationError is not null) throw new InvalidOperationException(configurationError);
        if (shutdown.IsCancellationRequested) throw new InvalidOperationException("Gateway shutdown is in progress.");
        if (activeRun is { IsCompleted: false }) throw new InvalidOperationException("A backup is already running.");
        if (document.ProtectedArchivePassphrase is null) throw new ArgumentException("Save an archive passphrase before creating a backup.");
        if (deliver && string.IsNullOrWhiteSpace(document.Settings.Destination.Address)) throw new ArgumentException("Configure a destination first.");
        var captured = document;
        var run = new BackupRunStatus(Guid.NewGuid().ToString("N"), "running", DateTimeOffset.UtcNow, null, "Capturing gateway configuration…");
        state = state with { LastRun = run, LastScheduledDate = scheduledDate ?? state.LastScheduledDate };
        Write(statePath, state);
        activeRun = Task.Run(() => RunAsync(captured, run, deliver, actor, shutdown.Token), CancellationToken.None);
    }

    private async Task RunAsync(BackupSettingsDocument settings, BackupRunStatus run, bool deliver, SecurityUser? actor, CancellationToken token)
    {
        string? archive = null;
        try
        {
            string passphrase, password;
            try { passphrase = protector.Unprotect(settings.ProtectedArchivePassphrase!); password = settings.ProtectedDestinationPassword is null ? "" : protector.Unprotect(settings.ProtectedDestinationPassword); }
            catch (CryptographicException) { throw new InvalidOperationException("Reenter backup credentials and archive passphrase for this machine and service account."); }
            RecoveryFileSystem.RejectLinks(workDirectory);
            if (!Directory.Exists(workDirectory)) RecoveryFileSystem.CreatePrivateDirectory(workDirectory);
            var name = BackupDestinations.CreateArchiveName(settings.OwnerId, run.StartedAt, Guid.ParseExact(run.Id, "N"));
            archive = Path.Combine(workDirectory, name);
            await ConfigurationBackupSnapshot.CreateAsync(directory, archive, passphrase, token);
            await GatewayRecovery.InspectAsync(archive, passphrase, token);
            var bytes = new FileInfo(archive).Length;
            lock (GatewayConfigurationLock.SyncRoot)
            {
                state = state with { DownloadId = run.Id, ArchiveName = name, LastRun = run with { ArchiveName = name, Bytes = bytes, Message = deliver ? "Archive verified. Copying to destination…" : "Archive verified." } };
                Write(statePath, state);
            }
            var removed = 0; string? warning = null;
            if (deliver)
            {
                var target = settings.Settings.Destination;
                var result = await BackupDestinations.DeliverAsync(new(target.Kind, target.Address, target.Username, password, target.Domain, target.TimeoutSeconds), archive, name, settings.OwnerId, settings.Settings.RetentionDays, token);
                removed = result.RemovedCount; warning = result.RetentionWarning;
            }
            CompleteRun(run with { Status = "succeeded", CompletedAt = DateTimeOffset.UtcNow, ArchiveName = name, Bytes = bytes, RemovedCount = removed,
                Message = (deliver ? "Backup copied and verified. " : "Encrypted backup is ready to download. ") + (warning ?? "") });
            try { PruneLocal(settings.OwnerId, name); } catch (Exception cleanup) when (IsStorageError(cleanup)) { }
            try { security.Audit(actor, deliver ? "gateway.backup.delivery" : "gateway.backup.download-created", null, "success", resource: run.Id); }
            catch (Exception auditError) when (IsStorageError(auditError)) { }
        }
        catch (Exception error)
        {
            var message = error is OperationCanceledException ? "Backup cancelled or timed out. Existing remote archives were retained."
                : error is InvalidOperationException && error.Message.StartsWith("Reenter backup credentials", StringComparison.Ordinal) ? error.Message
                : "Backup failed. Check destination permissions, connectivity, free space and certificate trust. A verified local download may still be available. If delivery completed before this failure, inspect the destination and retention result.";
            lock (GatewayConfigurationLock.SyncRoot)
            {
                state = state with { LastRun = run with { Status = "failed", CompletedAt = DateTimeOffset.UtcNow, Message = message, ArchiveName = state.DownloadId == run.Id ? state.ArchiveName : null } };
                try { Write(statePath, state); } catch (Exception failure) when (IsStorageError(failure)) { configurationError = "Backup status could not be saved. Check gateway disk space and permissions."; }
            }
            try { security.Audit(actor, "gateway.backup", null, "failed", resource: run.Id); } catch (Exception failure) when (IsStorageError(failure)) { }
        }
    }

    private void CompleteRun(BackupRunStatus completed)
    {
        // Only called after verification and, when requested, delivery/retention.
        // A local bookkeeping failure cannot undo that completed remote operation.
        lock (GatewayConfigurationLock.SyncRoot)
        {
            state = state with { LastRun = completed };
            try { Write(statePath, state); }
            catch (Exception error) when (IsStorageError(error))
            {
                const string warning = "The backup completed, but its final status could not be saved locally. This result is available only in this process; after restart the recorded result may be incomplete. Check gateway disk space and permissions, then review and save backup settings before scheduling resumes.";
                state = state with { LastRun = completed with { Message = completed.Message.TrimEnd() + " " + warning } };
                configurationError = warning;
            }
        }
    }

    public (Stream Stream, string Name) Download(string id)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (state.DownloadId != id || !DownloadExists()) throw new KeyNotFoundException("That backup download is no longer available. Create another backup.");
            var path = Path.Combine(workDirectory, state.ArchiveName!); RecoveryFileSystem.RejectLinks(path);
            return (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete), state.ArchiveName!);
        }
    }

    private bool DownloadExists() => Guid.TryParseExact(state.DownloadId, "N", out _) && state.ArchiveName is { } name
        && BackupDestinations.IsOwnedArchiveName(name, document.OwnerId) && File.Exists(Path.Combine(workDirectory, name));
    private void PruneLocal(Guid owner, string keep)
    {
        // Only completed archives created by this owner. Never traverse or recursively remove directories.
        foreach (var item in Directory.EnumerateFiles(workDirectory, $"sparkstudio-{owner:N}-*.sparkbak").Take(10001))
        {
            if (Path.GetFileName(item) == keep || !BackupDestinations.IsOwnedArchiveName(Path.GetFileName(item), owner)) continue;
            RecoveryFileSystem.RejectLinks(item);
            try { File.Delete(item); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, shutdown.Token);
        while (!linked.IsCancellationRequested)
        {
            lock (GatewayConfigurationLock.SyncRoot)
            {
                if (!recovery.Active && configurationError is null && document.Settings.Enabled && activeRun is not { IsCompleted: false }
                    && DueDate(document.Settings, state.LastScheduledDate, DateTimeOffset.UtcNow) is { } date)
                {
                    try { StartRun(true, date, null); }
                    catch (Exception error) when (IsStorageError(error)) { configurationError = "Scheduled backup could not start. Review backup settings, disk space and permissions."; }
                }
            }
            try { await Task.Delay(TimeSpan.FromSeconds(15), linked.Token); } catch (OperationCanceledException) { break; }
        }
    }
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        shutdown.Cancel(); await base.StopAsync(cancellationToken);
        Task? current; lock (GatewayConfigurationLock.SyncRoot) current = activeRun;
        if (current is not null) { try { await current.WaitAsync(cancellationToken); } catch (OperationCanceledException) { } }
    }
    public override void Dispose() { shutdown.Cancel(); shutdown.Dispose(); base.Dispose(); }

    public static string? DueDate(BackupScheduleSettings settings, string? lastDate, DateTimeOffset utc)
    {
        var local = TimeZoneInfo.ConvertTime(utc, TimeZoneInfo.FindSystemTimeZoneById(settings.TimeZoneId));
        var date = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return local.TimeOfDay >= TimeSpan.ParseExact(settings.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture) && string.CompareOrdinal(lastDate, date) < 0 ? date : null;
    }
    public static DateTimeOffset NextDue(BackupScheduleSettings settings, string? lastDate, DateTimeOffset utc)
    {
        if (DueDate(settings, lastDate, utc) is not null) return utc;
        var zone = TimeZoneInfo.FindSystemTimeZoneById(settings.TimeZoneId);
        var date = TimeZoneInfo.ConvertTime(utc, zone).Date;
        if (DateTime.TryParseExact(lastDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var previous) && previous.Date >= date) date = previous.Date.AddDays(1);
        var local = DateTime.SpecifyKind(date + TimeSpan.ParseExact(settings.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture), DateTimeKind.Unspecified);
        while (zone.IsInvalidTime(local)) local = local.AddMinutes(1);
        var offset = zone.IsAmbiguousTime(local) ? zone.GetAmbiguousTimeOffsets(local).Max() : zone.GetUtcOffset(local);
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }
    public static void ValidateSettings(BackupScheduleSettings settings)
    {
        if (settings is null || settings.Destination is null || settings.DailyTime?.Length != 5 || !TimeSpan.TryParseExact(settings.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture, out var time) || time.TotalHours >= 24
            || settings.RetentionDays is < 1 or > 3650 || string.IsNullOrWhiteSpace(settings.TimeZoneId) || settings.TimeZoneId.Length > 128)
            throw new ArgumentException("Choose a daily HH:mm time, time zone and retention from 1 to 3650 days.");
        try { _ = TimeZoneInfo.FindSystemTimeZoneById(settings.TimeZoneId); } catch (Exception error) when (error is TimeZoneNotFoundException or InvalidTimeZoneException) { throw new ArgumentException("Choose an available time zone."); }
        var destination = settings.Destination;
        if (destination.Kind is not ("smb" or "ftp" or "ftps") || destination.Address is null || destination.Address.Length > 2048 || destination.Username?.Length > 256 || destination.Domain?.Length > 256 || destination.TimeoutSeconds is < 30 or > 3600)
            throw new ArgumentException("Invalid backup destination settings.");
        if (!string.IsNullOrWhiteSpace(destination.Address)) BackupDestinations.Validate(new(destination.Kind, destination.Address, destination.Username, null, destination.Domain, destination.TimeoutSeconds));
        else if (settings.Enabled) throw new ArgumentException("A remote destination is required for scheduled backups.");
    }
    private static bool IsStorageError(Exception error) => error is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or CryptographicException;
    private static T Read<T>(string path)
    {
        RecoveryFileSystem.RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > 65536) throw new InvalidDataException("Backup settings are too large.");
        return JsonSerializer.Deserialize<T>(input, Json) ?? throw new InvalidDataException("Backup settings are empty.");
    }
    private static string Fingerprint(string path)
    {
        if (!File.Exists(path)) return "missing";
        RecoveryFileSystem.RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > 65536) return "oversized";
        return Convert.ToHexString(SHA256.HashData(input));
    }
    private static void Write<T>(string path, T value)
    {
        RecoveryFileSystem.RejectLinks(path); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { JsonSerializer.Serialize(stream, value, Json); stream.Flush(true); }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

public static class GatewayBackupEndpoints
{
    public static void MapGatewayBackupEndpoints(this WebApplication app)
    {
        app.MapGet("/api/gateway/backups", (GatewayBackups backups) => backups.Snapshot()).Access("admin");
        app.MapPut("/api/gateway/backups", (BackupSettingsRequest request, GatewayBackups backups) => backups.Save(request)).Access("admin", audit: true);
        app.MapPost("/api/gateway/backups/run", (BackupRunRequest request, GatewayBackups backups, HttpContext context)
            => Results.Json(backups.StartManual(request.Deliver, GatewayAccess.Actor(context)), statusCode: 202)).Access("admin", audit: true);
        app.MapGet("/api/gateway/backups/download/{id}", (string id, GatewayBackups backups) =>
        { var file = backups.Download(id); return Results.File(file.Stream, "application/octet-stream", file.Name, enableRangeProcessing: false); }).Access("admin", audit: true);
    }
}
