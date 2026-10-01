using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace SparkStudio.Gateway;

public sealed record BackupDestinationSettings(string Kind, string Address, string? Username = null, string? Domain = null, int TimeoutSeconds = 300, bool AllowInsecureFtp = false,
    string? Bucket = null, string? Region = null, string? Prefix = null, string? AccessKeyId = null, string? Endpoint = null, bool ForcePathStyle = false);
// Version-one DTOs are retained for migration and callers of the original service API.
public sealed record BackupScheduleSettings(bool Enabled, string DailyTime, string TimeZoneId, int RetentionDays, BackupDestinationSettings Destination);
public sealed record BackupSettingsRequest(string Revision, BackupScheduleSettings Settings, string? DestinationPassword = null, string? ArchivePassphrase = null, bool ClearDestinationPassword = false)
{ public override string ToString() => "BackupSettingsRequest { credentials redacted }"; }
public sealed record BackupSettingsDocument(int Version, Guid OwnerId, string Revision, BackupScheduleSettings Settings, string? ProtectedDestinationPassword, string? ProtectedArchivePassphrase);
public sealed record BackupRunDocument(int Version, string? LastScheduledDate, BackupRunStatus? LastRun, string? DownloadId, string? ArchiveName);

public sealed record BackupNamedDestination(string Id, string Name, BackupDestinationSettings Settings);
public sealed record BackupNamedSchedule(string Id, string Name, bool Enabled, string DestinationId, string DailyTime, string TimeZoneId, int RetentionDays, int[]? DaysOfWeek = null);
public sealed record BackupConfigurationSettings(BackupNamedDestination[] Destinations, BackupNamedSchedule[] Schedules);
public sealed record BackupDestinationSecretsRequest(string DestinationId, string? Password = null, string? SecretAccessKey = null, string? SessionToken = null,
    bool ClearPassword = false, bool ClearSecretAccessKey = false, bool ClearSessionToken = false)
{ public override string ToString() => "BackupDestinationSecretsRequest { credentials redacted }"; }
public sealed record BackupConfigurationRequest(string Revision, BackupConfigurationSettings Settings, BackupDestinationSecretsRequest[]? DestinationSecrets = null, string? ArchivePassphrase = null)
{ public override string ToString() => "BackupConfigurationRequest { credentials redacted }"; }
public sealed record BackupRunRequest(bool Deliver, string? DestinationId = null, string? ScheduleId = null);
public sealed record BackupRunStatus(string Id, string Status, DateTimeOffset StartedAt, DateTimeOffset? CompletedAt, string Message, string? ArchiveName = null, long? Bytes = null, int RemovedCount = 0,
    string? DestinationId = null, string? ScheduleId = null);
public sealed record BackupDestinationDocument(BackupNamedDestination Destination, Guid ManualRetentionOwnerId, string? ProtectedPassword, string? ProtectedSecretAccessKey, string? ProtectedSessionToken);
public sealed record BackupScheduleDocument(BackupNamedSchedule Schedule, Guid RetentionOwnerId);
public sealed record BackupSettingsDocumentV2(int Version, Guid OwnerId, string Revision, BackupDestinationDocument[] Destinations, BackupScheduleDocument[] Schedules, string? ProtectedArchivePassphrase);
public sealed record BackupScheduleRunState(string ScheduleId, string? LastScheduledDate, BackupRunStatus? LastRun);
public sealed record BackupRunDocumentV2(int Version, BackupScheduleRunState[] Schedules, BackupRunStatus? LastRun, string? DownloadId, string? ArchiveName, Guid? ArchiveOwnerId);

/// <summary>Independent schedules share one serial worker; uploads never hold the configuration monitor.</summary>
public sealed class GatewayBackups : BackgroundService
{
    public const string Coverage = "Configuration only: projects, publications, scripts, assets, users/grants, tags, connections, keys, certificates and gateway settings. Database contents, audit/history and other runtime files are excluded. Use the offline full backup and database-specific backups for those.";
    private const string DefaultDestinationId = "default-destination", DefaultScheduleId = "default-schedule";
    private const int MaximumDocumentBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true, UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
    private readonly string directory, settingsPath, statePath, workDirectory;
    private readonly IDataProtector protector;
    private readonly RecoveryQuarantine recovery;
    private readonly SecurityStore security;
    private readonly CancellationTokenSource shutdown;
    private readonly CancellationToken shutdownToken;
    private readonly object shutdownGate = new();
    private bool disposed;
    private BackupSettingsDocumentV2 document;
    private BackupRunDocumentV2 state = EmptyState();
    private string diskRevision = "unreadable";
    private string? configurationError;
    private Task? activeRun;
    private readonly ProjectStore? gatewayStore;

    public GatewayBackups(string directory, IDataProtectionProvider protection, RecoveryQuarantine recovery, SecurityStore security, IHostApplicationLifetime lifetime, ProjectStore? gatewayStore = null)
    {
        this.gatewayStore = gatewayStore;
        this.directory = Path.GetFullPath(directory); this.recovery = recovery; this.security = security;
        // Keep the original protection purpose so migration does not invalidate saved credentials.
        protector = protection.CreateProtector("SparkStudio.BackupSettings.v1");
        settingsPath = Path.Combine(this.directory, "backup-settings.json"); statePath = Path.Combine(this.directory, "backup-state.json");
        workDirectory = Path.Combine(this.directory, "backup-work"); shutdown = CancellationTokenSource.CreateLinkedTokenSource(lifetime.ApplicationStopping);
        shutdownToken = shutdown.Token;
        document = NewDocument();
        lock (GatewayConfigurationLock.SyncRoot)
        {
            try
            {
                diskRevision = Fingerprint(settingsPath);
                if (File.Exists(settingsPath))
                {
                    var version = ReadVersion(settingsPath);
                    document = version == 1 ? Migrate(Read<BackupSettingsDocument>(settingsPath)) : version == 2 ? Read<BackupSettingsDocumentV2>(settingsPath) : throw new InvalidDataException();
                    ValidateDocument(document);
                    if (version == 1) { Write(settingsPath, document); diskRevision = Fingerprint(settingsPath); }
                }
                else { Write(settingsPath, document); diskRevision = Fingerprint(settingsPath); }
            }
            catch (Exception error) when (IsStorageError(error))
            {
                document = NewDocument() with { Revision = diskRevision };
                configurationError = "Saved backup settings are invalid or unreadable. Scheduling is disabled. Review and save replacement settings.";
            }
            try
            {
                if (File.Exists(statePath))
                {
                    var version = ReadVersion(statePath);
                    state = version == 1 ? Migrate(Read<BackupRunDocument>(statePath)) : version == 2 ? Read<BackupRunDocumentV2>(statePath) : throw new InvalidDataException();
                    ValidateState(state);
                }
            }
            catch (Exception error) when (IsStorageError(error))
            {
                state = EmptyState();
                configurationError ??= "Saved backup schedule status is invalid or unreadable. Scheduling is disabled because previous attempted dates cannot be verified. Review and save backup settings to replace the status file.";
            }
            state = state with { LastRun = Interrupted(state.LastRun), Schedules = state.Schedules.Select(item => item with { LastRun = Interrupted(item.LastRun) }).ToArray() };
        }
    }

    public static BackupScheduleSettings Defaults() => new(false, "02:00", TimeZoneInfo.Local.Id, 7, new("smb", ""));
    public static BackupConfigurationSettings ConfigurationDefaults() => new([new(DefaultDestinationId, "Primary destination", Defaults().Destination)],
        [new(DefaultScheduleId, "Daily backup", false, DefaultDestinationId, "02:00", TimeZoneInfo.Local.Id, 7)]);
    private static BackupSettingsDocumentV2 NewDocument()
    {
        var defaults = ConfigurationDefaults();
        return new(2, Guid.NewGuid(), Guid.NewGuid().ToString("N"), [new(defaults.Destinations[0], Guid.NewGuid(), null, null, null)], [new(defaults.Schedules[0], Guid.NewGuid())], null);
    }
    private static BackupRunDocumentV2 EmptyState() => new(2, [], null, null, null, null);
    private static BackupSettingsDocumentV2 Migrate(BackupSettingsDocument old)
    {
        if (old.Version != 1 || old.OwnerId == Guid.Empty || string.IsNullOrWhiteSpace(old.Revision)) throw new InvalidDataException();
        ValidateSettings(old.Settings);
        return new(2, old.OwnerId, old.Revision, [new(new(DefaultDestinationId, "Primary destination", old.Settings.Destination), Guid.NewGuid(), old.ProtectedDestinationPassword, null, null)],
            [new(new(DefaultScheduleId, "Daily backup", old.Settings.Enabled, DefaultDestinationId, old.Settings.DailyTime, old.Settings.TimeZoneId, old.Settings.RetentionDays), old.OwnerId)], old.ProtectedArchivePassphrase);
    }
    private BackupRunDocumentV2 Migrate(BackupRunDocument old)
    {
        if (old.Version != 1) throw new InvalidDataException();
        BackupRunStatus? AddIdentity(BackupRunStatus? run) => run is null ? null : run with { DestinationId = DefaultDestinationId, ScheduleId = old.LastScheduledDate is null ? null : DefaultScheduleId };
        return new(2, [new(DefaultScheduleId, old.LastScheduledDate, AddIdentity(old.LastRun))], AddIdentity(old.LastRun), old.DownloadId, old.ArchiveName, old.ArchiveName is null ? null : document.OwnerId);
    }
    private static BackupRunStatus? Interrupted(BackupRunStatus? run) => run?.Status == "running" ? run with { Status = "failed", CompletedAt = DateTimeOffset.UtcNow, Message = "The gateway stopped before this backup completed. No completed remote copy is assumed." } : run;

    public object Snapshot()
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            var now = DateTimeOffset.UtcNow;
            var scheduleStates = document.Schedules.Select(item =>
            {
                var previous = ScheduleState(item.Schedule.Id);
                return new { scheduleId = item.Schedule.Id, previous.LastScheduledDate, previous.LastRun,
                    nextDueAt = !recovery.Active && configurationError is null && item.Schedule.Enabled ? NextDue(item.Schedule, previous.LastScheduledDate, now) : (DateTimeOffset?)null };
            }).ToArray();
            return new
            {
                document.Revision, saved = PublicSettings(document),
                destinationSecrets = document.Destinations.Select(item => new { destinationId = item.Destination.Id, hasPassword = item.ProtectedPassword is not null, hasSecretAccessKey = item.ProtectedSecretAccessKey is not null, hasSessionToken = item.ProtectedSessionToken is not null }).ToArray(),
                hasArchivePassphrase = document.ProtectedArchivePassphrase is not null,
                // Original service callers may still use the singleton password indicator.
                hasDestinationPassword = document.Destinations.FirstOrDefault()?.ProtectedPassword is not null,
                gatewayTimeZoneId = TimeZoneInfo.Local.Id, running = activeRun is { IsCompleted: false }, scheduleStates,
                nextDueAt = scheduleStates.Select(item => item.nextDueAt).Where(value => value is not null).Min(),
                lastRun = state.LastRun, downloadId = DownloadExists() ? state.DownloadId : null,
                recoveryBlocked = recovery.Active, coverage = Coverage, configurationError
            };
        }
    }

    public object Save(BackupSettingsRequest request)
    {
        if (request.Settings is null) throw new ArgumentException("Backup settings are required.");
        var settings = new BackupConfigurationSettings([new(DefaultDestinationId, "Primary destination", request.Settings.Destination)],
            [new(DefaultScheduleId, "Daily backup", request.Settings.Enabled, DefaultDestinationId, request.Settings.DailyTime, request.Settings.TimeZoneId, request.Settings.RetentionDays)]);
        return SaveConfiguration(new BackupConfigurationRequest(request.Revision, settings, [new(DefaultDestinationId, Password: request.DestinationPassword, ClearPassword: request.ClearDestinationPassword)], request.ArchivePassphrase));
    }

    public object SaveConfiguration(BackupConfigurationRequest request)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (shutdownToken.IsCancellationRequested) throw new InvalidOperationException("Gateway shutdown is in progress.");
            if (activeRun is { IsCompleted: false }) throw new InvalidOperationException("Wait for the current backup before changing settings.");
            if (request.Revision != document.Revision || Fingerprint(settingsPath) != diskRevision) throw new InvalidOperationException("Backup settings changed. Reload and review them again.");
            ValidateSettings(request.Settings);
            foreach (var target in request.Settings.Destinations)
            {
                var placeholder = target.Id == DefaultDestinationId && target.Settings.Kind == "smb" && string.IsNullOrWhiteSpace(target.Settings.Address)
                    && string.IsNullOrWhiteSpace(target.Settings.Username) && string.IsNullOrWhiteSpace(target.Settings.Domain) && !request.Settings.Schedules.Any(item => item.Enabled && item.DestinationId == target.Id);
                if (!placeholder) ValidateDestination(target.Settings, true);
            }
            if (request.ArchivePassphrase is not null && request.ArchivePassphrase.Length is < 12 or > 1024) throw new ArgumentException("The archive passphrase must contain 12–1024 characters.");
            var updates = request.DestinationSecrets ?? [];
            if (updates.Length > 32 || updates.Any(item => item is null || !request.Settings.Destinations.Any(target => target.Id == item.DestinationId)) || updates.Select(item => item.DestinationId).Distinct(StringComparer.Ordinal).Count() != updates.Length)
                throw new ArgumentException("Credential updates must identify each saved destination at most once.");
            foreach (var update in updates) { ValidateSecret(update.Password, update.ClearPassword); ValidateSecret(update.SecretAccessKey, update.ClearSecretAccessKey); ValidateSecret(update.SessionToken, update.ClearSessionToken); }
            var secret = request.ArchivePassphrase is null ? document.ProtectedArchivePassphrase : protector.Protect(request.ArchivePassphrase);
            if (request.Settings.Schedules.Any(item => item.Enabled) && secret is null) throw new ArgumentException("Set an archive passphrase before enabling scheduled backups.");
            var destinations = request.Settings.Destinations.Select(item =>
            {
                var old = document.Destinations.FirstOrDefault(target => target.Destination.Id == item.Id);
                var update = updates.FirstOrDefault(value => value.DestinationId == item.Id);
                return new BackupDestinationDocument(item, old?.ManualRetentionOwnerId ?? Guid.NewGuid(),
                    ProtectReplacement(update?.Password, update?.ClearPassword == true, old?.ProtectedPassword),
                    ProtectReplacement(update?.SecretAccessKey, update?.ClearSecretAccessKey == true, old?.ProtectedSecretAccessKey),
                    ProtectReplacement(update?.SessionToken, update?.ClearSessionToken == true, old?.ProtectedSessionToken));
            }).ToArray();
            var schedules = request.Settings.Schedules.Select(item =>
            {
                var old = document.Schedules.FirstOrDefault(value => value.Schedule.Id == item.Id && value.Schedule.DestinationId == item.DestinationId);
                // Persist a fresh ownership identity on creation or a target change. Reusing a deleted
                // display ID can never adopt the previous schedule's remote archives.
                return new BackupScheduleDocument(item, old?.RetentionOwnerId ?? Guid.NewGuid());
            }).ToArray();
            foreach (var schedule in schedules.Where(item => item.Schedule.Enabled)) ValidateCredentialAvailability(destinations.Single(item => item.Destination.Id == schedule.Schedule.DestinationId));
            var next = new BackupSettingsDocumentV2(2, document.OwnerId, Guid.NewGuid().ToString("N"), destinations, schedules, secret);
            Write(settingsPath, next); document = next; diskRevision = Fingerprint(settingsPath); configurationError = null;
            // Removed jobs cannot cause an unbounded operational-state document. Existing jobs
            // retain their attempted date even after changing names, timing, or destination.
            state = state with { Schedules = state.Schedules.Where(item => schedules.Any(value => value.Schedule.Id == item.ScheduleId)).ToArray() };
            try { Write(statePath, state); }
            catch (Exception error) when (IsStorageError(error)) { configurationError = "Backup settings were saved, but schedule status could not be saved. Check gateway disk space and permissions, then review and save settings before scheduling resumes."; }
            return Snapshot();
        }
    }
    private string? ProtectReplacement(string? value, bool clear, string? existing) => clear ? null : value is null ? existing : protector.Protect(value);
    private static void ValidateSecret(string? value, bool clear)
    {
        if (value is { Length: 0 or > 4096 } || value is not null && System.Text.Encoding.UTF8.GetByteCount(value) > 4096 || value?.Any(char.IsControl) == true || clear && value is not null)
            throw new ArgumentException("Choose a nonempty replacement credential of at most 4096 UTF-8 bytes without control characters, or explicitly clear it.");
    }
    private static void ValidateCredentialAvailability(BackupDestinationDocument target)
    {
        var settings = target.Destination.Settings;
        if (settings.Kind == "s3" && target.ProtectedSecretAccessKey is null
            || settings.Kind == "smb" && !string.IsNullOrWhiteSpace(settings.Username) && target.ProtectedPassword is null
            || settings.Kind is "ftp" or "ftps" && !string.Equals(settings.Username, "anonymous", StringComparison.OrdinalIgnoreCase) && target.ProtectedPassword is null)
            throw new ArgumentException("Save destination credentials before enabling its scheduled backups.");
    }

    public object StartManual(bool deliver, SecurityUser actor) => StartManual(new BackupRunRequest(deliver), actor);
    public object StartManual(BackupRunRequest request, SecurityUser actor)
    {
        lock (GatewayConfigurationLock.SyncRoot)
        {
            if (request.DestinationId is not null && request.ScheduleId is not null || !request.Deliver && (request.DestinationId is not null || request.ScheduleId is not null)) throw new ArgumentException("Choose one destination or schedule for delivery, or create a local download.");
            var schedule = request.ScheduleId is null ? null : document.Schedules.FirstOrDefault(item => item.Schedule.Id == request.ScheduleId) ?? throw new ArgumentException("That backup schedule is no longer saved.");
            var destinationId = schedule?.Schedule.DestinationId ?? request.DestinationId;
            var destination = destinationId is null ? request.Deliver && document.Destinations.Length == 1 ? document.Destinations[0] : null
                : document.Destinations.FirstOrDefault(item => item.Destination.Id == destinationId) ?? throw new ArgumentException("That backup destination is no longer saved.");
            if (request.Deliver && destination is null) throw new ArgumentException("Choose a saved destination or schedule for delivery.");
            StartRun(destination, schedule, null, actor); return Snapshot();
        }
    }

    private void StartRun(BackupDestinationDocument? destination, BackupScheduleDocument? schedule, string? scheduledDate, SecurityUser? actor)
    {
        recovery.EnsureOperationsAllowed();
        if (configurationError is not null) throw new InvalidOperationException(configurationError);
        if (shutdownToken.IsCancellationRequested) throw new InvalidOperationException("Gateway shutdown is in progress.");
        if (activeRun is { IsCompleted: false }) throw new InvalidOperationException("A backup is already running.");
        if (document.ProtectedArchivePassphrase is null) throw new ArgumentException("Save an archive passphrase before creating a backup.");
        if (destination is not null) ValidateDestination(destination.Destination.Settings, true);
        var run = new BackupRunStatus(Guid.NewGuid().ToString("N"), "running", DateTimeOffset.UtcNow, null, "Capturing gateway configuration…", DestinationId: destination?.Destination.Id, ScheduleId: schedule?.Schedule.Id);
        state = state with { LastRun = run };
        if (schedule is not null)
        {
            var previous = ScheduleState(schedule.Schedule.Id);
            SetScheduleState(previous with { LastRun = run, LastScheduledDate = scheduledDate ?? previous.LastScheduledDate });
        }
        try { Write(statePath, state); }
        catch (Exception error) when (IsStorageError(error))
        {
            var failed = run with { Status = "failed", CompletedAt = DateTimeOffset.UtcNow, Message = "Backup could not start because its attempt could not be saved. Check gateway disk space and permissions." };
            UpdateRunState(failed); configurationError = failed.Message; throw new InvalidOperationException(failed.Message);
        }
        var captured = document;
        activeRun = Task.Run(() => RunAsync(captured, destination, schedule, run, actor, shutdownToken), CancellationToken.None);
    }

    private async Task RunAsync(BackupSettingsDocumentV2 settings, BackupDestinationDocument? destination, BackupScheduleDocument? schedule, BackupRunStatus run, SecurityUser? actor, CancellationToken token)
    {
        try
        {
            string passphrase; BackupDestination? target = null;
            try
            {
                passphrase = protector.Unprotect(settings.ProtectedArchivePassphrase!);
                if (destination is not null) target = ReadTransport(destination);
            }
            catch (CryptographicException) { throw new InvalidOperationException("Reenter backup credentials and archive passphrase for this machine and service account."); }
            RecoveryFileSystem.RejectLinks(workDirectory);
            if (!Directory.Exists(workDirectory)) RecoveryFileSystem.CreatePrivateDirectory(workDirectory);
            var owner = schedule?.RetentionOwnerId ?? destination?.ManualRetentionOwnerId ?? settings.OwnerId;
            var name = BackupDestinations.CreateArchiveName(owner, run.StartedAt, Guid.ParseExact(run.Id, "N"));
            var archive = Path.Combine(workDirectory, name);
            gatewayStore?.FlushMemoryValues();
            await ConfigurationBackupSnapshot.CreateAsync(directory, archive, passphrase, token);
            await GatewayRecovery.InspectAsync(archive, passphrase, token);
            var bytes = new FileInfo(archive).Length;
            string? previousDownload;
            lock (GatewayConfigurationLock.SyncRoot)
            {
                previousDownload = DownloadExists() ? Path.Combine(workDirectory, state.ArchiveName!) : null;
                state = state with { DownloadId = run.Id, ArchiveName = name, ArchiveOwnerId = owner };
                UpdateRunState(run with { ArchiveName = name, Bytes = bytes, Message = target is not null ? "Archive verified. Copying to destination…" : "Archive verified." });
                Write(statePath, state);
            }
            var removed = 0; string? warning = null;
            if (target is not null)
            {
                var result = await BackupDestinations.DeliverAsync(target, archive, name, owner, schedule?.Schedule.RetentionDays ?? 7, token);
                removed = result.RemovedCount; warning = result.RetentionWarning;
            }
            CompleteRun(run with { Status = "succeeded", CompletedAt = DateTimeOffset.UtcNow, ArchiveName = name, Bytes = bytes, RemovedCount = removed,
                Message = (target is not null ? "Backup copied and verified. " : "Encrypted backup is ready to download. ") + (warning ?? "") });
            try
            {
                PruneLocal(owner, name);
                if (previousDownload is not null && previousDownload != archive) { RecoveryFileSystem.RejectLinks(previousDownload); File.Delete(previousDownload); }
            }
            catch (Exception cleanup) when (IsStorageError(cleanup)) { }
            try { security.Audit(actor, target is not null ? "gateway.backup.delivery" : "gateway.backup.download-created", null, "success", resource: run.Id); }
            catch (Exception auditError) when (IsStorageError(auditError)) { }
        }
        catch (Exception error)
        {
            var message = error is OperationCanceledException ? "Backup cancelled or timed out. Existing remote archives were retained."
                : error is InvalidOperationException && error.Message.StartsWith("Reenter backup credentials", StringComparison.Ordinal) ? error.Message
                : "Backup failed. Check destination permissions, connectivity, credentials, free space and certificate trust. A verified local download may still be available. If delivery completed before this failure, inspect the destination and retention result.";
            lock (GatewayConfigurationLock.SyncRoot)
            {
                UpdateRunState(run with { Status = "failed", CompletedAt = DateTimeOffset.UtcNow, Message = message, ArchiveName = state.DownloadId == run.Id ? state.ArchiveName : null, Bytes = state.DownloadId == run.Id ? state.LastRun?.Bytes : null });
                try { Write(statePath, state); } catch (Exception failure) when (IsStorageError(failure)) { configurationError = "Backup status could not be saved. Check gateway disk space and permissions."; }
            }
            try { security.Audit(actor, "gateway.backup", null, "failed", resource: run.Id); } catch (Exception failure) when (IsStorageError(failure)) { }
        }
    }
    private string? Unprotect(string? value) => value is null ? null : protector.Unprotect(value);
    private BackupDestination ReadTransport(BackupDestinationDocument destination)
    {
        var settings = destination.Destination.Settings;
        return settings.Kind == "s3" ? Transport(settings, secretAccessKey: Unprotect(destination.ProtectedSecretAccessKey), sessionToken: Unprotect(destination.ProtectedSessionToken))
            : Transport(settings, password: Unprotect(destination.ProtectedPassword));
    }
    private static BackupDestination Transport(BackupDestinationSettings settings, string? password = null, string? secretAccessKey = null, string? sessionToken = null) => settings.Kind == "s3"
        ? new(settings.Kind, "", TimeoutSeconds: settings.TimeoutSeconds, Bucket: settings.Bucket, Region: settings.Region, Prefix: settings.Prefix,
            AccessKeyId: settings.AccessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Endpoint: settings.Endpoint, ForcePathStyle: settings.ForcePathStyle)
        : new(settings.Kind, settings.Address, settings.Username, password, settings.Domain, settings.TimeoutSeconds, settings.AllowInsecureFtp);

    private BackupScheduleRunState ScheduleState(string id) => state.Schedules.FirstOrDefault(item => item.ScheduleId == id) ?? new(id, null, null);
    private void SetScheduleState(BackupScheduleRunState changed) => state = state with { Schedules = state.Schedules.Where(item => item.ScheduleId != changed.ScheduleId).Append(changed).ToArray() };
    private void UpdateRunState(BackupRunStatus run)
    {
        state = state with { LastRun = run };
        if (run.ScheduleId is not null) SetScheduleState(ScheduleState(run.ScheduleId) with { LastRun = run });
    }
    private void CompleteRun(BackupRunStatus completed)
    {
        // A local bookkeeping failure cannot undo the completed remote operation.
        lock (GatewayConfigurationLock.SyncRoot)
        {
            UpdateRunState(completed);
            try { Write(statePath, state); }
            catch (Exception error) when (IsStorageError(error))
            {
                const string warning = "The backup completed, but its final status could not be saved locally. This result is available only in this process; after restart the recorded result may be incomplete. Check gateway disk space and permissions, then review and save backup settings before scheduling resumes.";
                UpdateRunState(completed with { Message = completed.Message.TrimEnd() + " " + warning }); configurationError = warning;
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
    private bool DownloadExists() => Guid.TryParseExact(state.DownloadId, "N", out _) && state.ArchiveName is { } name && state.ArchiveOwnerId is { } owner
        && BackupDestinations.IsOwnedArchiveName(name, owner) && File.Exists(Path.Combine(workDirectory, name));
    private void PruneLocal(Guid owner, string keep)
    {
        foreach (var item in Directory.EnumerateFiles(workDirectory, $"sparkstudio-{owner:N}-*.sparkbak").Take(10001))
        {
            if (Path.GetFileName(item) == keep || !BackupDestinations.IsOwnedArchiveName(Path.GetFileName(item), owner)) continue;
            RecoveryFileSystem.RejectLinks(item);
            try { File.Delete(item); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, shutdownToken);
        while (!linked.IsCancellationRequested)
        {
            lock (GatewayConfigurationLock.SyncRoot)
            {
                if (!recovery.Active && configurationError is null && activeRun is not { IsCompleted: false })
                {
                    try
                    {
                        var now = DateTimeOffset.UtcNow;
                        // Oldest attempted job first gives every simultaneously due schedule a turn,
                        // including when the gateway was stopped for several days.
                        var due = document.Schedules.Where(item => item.Schedule.Enabled && DueDate(item.Schedule, ScheduleState(item.Schedule.Id).LastScheduledDate, now) is not null)
                            .OrderBy(item => ScheduleState(item.Schedule.Id).LastRun?.StartedAt ?? DateTimeOffset.MinValue).ThenBy(item => item.Schedule.Id, StringComparer.Ordinal).FirstOrDefault();
                        if (due is not null) StartRun(document.Destinations.Single(item => item.Destination.Id == due.Schedule.DestinationId), due, DueDate(due.Schedule, ScheduleState(due.Schedule.Id).LastScheduledDate, now), null);
                    }
                    catch (Exception error) when (IsStorageError(error) || error is TimeZoneNotFoundException or InvalidTimeZoneException) { configurationError ??= "Scheduled backup could not start. Review backup settings, time zones, disk space and permissions."; }
                }
            }
            Task? current; lock (GatewayConfigurationLock.SyncRoot) current = activeRun is { IsCompleted: false } ? activeRun : null;
            try
            {
                if (current is not null) await current.WaitAsync(linked.Token);
                else await Task.Delay(TimeSpan.FromSeconds(15), linked.Token);
            }
            catch (OperationCanceledException) { break; }
        }
    }
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        lock (shutdownGate) { if (!disposed) shutdown.Cancel(); }
        await base.StopAsync(cancellationToken);
        Task? current; lock (GatewayConfigurationLock.SyncRoot) current = activeRun;
        if (current is not null) { try { await current.WaitAsync(cancellationToken); } catch (OperationCanceledException) { } }
    }
    public override void Dispose()
    {
        lock (shutdownGate)
        {
            if (disposed) return;
            disposed = true;
            try { shutdown.Cancel(); }
            finally { shutdown.Dispose(); base.Dispose(); }
        }
    }

    public static string? DueDate(BackupScheduleSettings settings, string? lastDate, DateTimeOffset utc) => DueDate(new BackupNamedSchedule(DefaultScheduleId, "Daily backup", settings.Enabled, DefaultDestinationId, settings.DailyTime, settings.TimeZoneId, settings.RetentionDays), lastDate, utc);
    public static DateTimeOffset NextDue(BackupScheduleSettings settings, string? lastDate, DateTimeOffset utc) => NextDue(new BackupNamedSchedule(DefaultScheduleId, "Daily backup", settings.Enabled, DefaultDestinationId, settings.DailyTime, settings.TimeZoneId, settings.RetentionDays), lastDate, utc);
    public static string? DueDate(BackupNamedSchedule settings, string? lastDate, DateTimeOffset utc)
    {
        var local = TimeZoneInfo.ConvertTime(utc, TimeZoneInfo.FindSystemTimeZoneById(settings.TimeZoneId));
        var date = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return OnDay(settings, local.DayOfWeek) && local.TimeOfDay >= TimeSpan.ParseExact(settings.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture) && string.CompareOrdinal(lastDate, date) < 0 ? date : null;
    }
    public static DateTimeOffset NextDue(BackupNamedSchedule settings, string? lastDate, DateTimeOffset utc)
    {
        if (DueDate(settings, lastDate, utc) is not null) return utc;
        var zone = TimeZoneInfo.FindSystemTimeZoneById(settings.TimeZoneId);
        var currentLocal = TimeZoneInfo.ConvertTime(utc, zone);
        var date = currentLocal.Date;
        var time = TimeSpan.ParseExact(settings.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture);
        if (currentLocal.TimeOfDay > time) date = date.AddDays(1);
        if (DateTime.TryParseExact(lastDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var previous) && previous.Date >= date) date = previous.Date.AddDays(1);
        while (!OnDay(settings, date.DayOfWeek)) date = date.AddDays(1);
        var local = DateTime.SpecifyKind(date + time, DateTimeKind.Unspecified);
        while (zone.IsInvalidTime(local)) local = local.AddMinutes(1);
        var offset = zone.IsAmbiguousTime(local) ? zone.GetAmbiguousTimeOffsets(local).Max() : zone.GetUtcOffset(local);
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }
    private static bool OnDay(BackupNamedSchedule settings, DayOfWeek day) => settings.DaysOfWeek is not { Length: > 0 } || settings.DaysOfWeek.Contains((int)day);
    public static void ValidateSettings(BackupScheduleSettings settings)
    {
        if (settings is null) throw new ArgumentException("Backup settings are required.");
        ValidateSettings(new BackupConfigurationSettings([new(DefaultDestinationId, "Primary destination", settings.Destination)], [new(DefaultScheduleId, "Daily backup", settings.Enabled, DefaultDestinationId, settings.DailyTime, settings.TimeZoneId, settings.RetentionDays)]));
    }
    public static void ValidateSettings(BackupConfigurationSettings settings)
    {
        if (settings is null || settings.Destinations is null || settings.Schedules is null || settings.Destinations.Length > 32 || settings.Schedules.Length > 64 || settings.Destinations.Any(item => item is null) || settings.Schedules.Any(item => item is null))
            throw new ArgumentException("Save at most 32 destinations and 64 schedules.");
        if (settings.Destinations.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() != settings.Destinations.Length || settings.Schedules.Select(item => item.Id).Distinct(StringComparer.Ordinal).Count() != settings.Schedules.Length)
            throw new ArgumentException("Destination and schedule IDs must be unique.");
        foreach (var destination in settings.Destinations) { ValidateIdentity(destination.Id, destination.Name); ValidateDestination(destination.Settings, false); }
        foreach (var schedule in settings.Schedules)
        {
            ValidateIdentity(schedule.Id, schedule.Name);
            if (schedule.DailyTime?.Length != 5 || !TimeSpan.TryParseExact(schedule.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture, out var time) || time.TotalHours >= 24
                || schedule.RetentionDays is < 1 or > 3650 || string.IsNullOrWhiteSpace(schedule.TimeZoneId) || schedule.TimeZoneId.Length > 128 || schedule.DaysOfWeek?.Length > 7
                || schedule.DaysOfWeek?.Any(day => day is < 0 or > 6) == true || schedule.DaysOfWeek?.Distinct().Count() != schedule.DaysOfWeek?.Length)
                throw new ArgumentException("Choose an HH:mm time, available time zone, unique weekdays and retention from 1 to 3650 days.");
            try { _ = TimeZoneInfo.FindSystemTimeZoneById(schedule.TimeZoneId); } catch (Exception error) when (error is TimeZoneNotFoundException or InvalidTimeZoneException) { throw new ArgumentException("Choose an available time zone."); }
            var target = settings.Destinations.FirstOrDefault(item => item.Id == schedule.DestinationId) ?? throw new ArgumentException("Every schedule must reference a saved destination.");
            if (schedule.Enabled) ValidateDestination(target.Settings, true);
        }
    }
    private static void ValidateIdentity(string id, string name)
    {
        if (id is null || id.Length is < 1 or > 64 || id.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '_' or '-')) || string.IsNullOrWhiteSpace(name) || name.Length > 100 || name.Any(char.IsControl))
            throw new ArgumentException("IDs must use 1–64 letters, digits, underscores or hyphens; names must contain 1–100 ordinary characters.");
    }
    private static void ValidateDestination(BackupDestinationSettings destination, bool complete)
    {
        if (destination is null || destination.Kind is not ("smb" or "ftp" or "ftps" or "s3") || destination.Address is null || destination.Address.Length > 2048 || destination.TimeoutSeconds is < 30 or > 3600
            || new[] { destination.Username, destination.Domain, destination.Bucket, destination.Region, destination.AccessKeyId }.Any(value => value?.Length > 256 || value?.Any(char.IsControl) == true)
            || destination.Prefix?.Length > 1024 || destination.Prefix?.Any(char.IsControl) == true || destination.Endpoint?.Length > 2048 || destination.Endpoint?.Any(char.IsControl) == true || destination.Address.Any(char.IsControl))
            throw new ArgumentException("Invalid backup destination settings.");
        if (destination.Kind == "s3" && (!string.IsNullOrEmpty(destination.Address) || !string.IsNullOrEmpty(destination.Username) || !string.IsNullOrEmpty(destination.Domain) || destination.AllowInsecureFtp)
            || destination.Kind != "s3" && (new[] { destination.Bucket, destination.Region, destination.Prefix, destination.AccessKeyId, destination.Endpoint }.Any(value => !string.IsNullOrEmpty(value)) || destination.ForcePathStyle))
            throw new ArgumentException("Use only the fields belonging to the selected backup destination type.");
        var configured = destination.Kind == "s3" ? !string.IsNullOrWhiteSpace(destination.Bucket) && !string.IsNullOrWhiteSpace(destination.Region) && !string.IsNullOrWhiteSpace(destination.AccessKeyId) : !string.IsNullOrWhiteSpace(destination.Address);
        if (complete || configured) BackupDestinations.Validate(Transport(destination));
    }
    private static BackupConfigurationSettings PublicSettings(BackupSettingsDocumentV2 value) => new(value.Destinations.Select(item => item.Destination).ToArray(), value.Schedules.Select(item => item.Schedule).ToArray());
    private static void ValidateDocument(BackupSettingsDocumentV2 value)
    {
        if (value.Version != 2 || value.OwnerId == Guid.Empty || string.IsNullOrWhiteSpace(value.Revision) || value.Revision.Length > 128 || value.Destinations is null || value.Schedules is null
            || value.Destinations.Any(item => item is null || item.Destination is null || item.ManualRetentionOwnerId == Guid.Empty) || value.Schedules.Any(item => item is null || item.Schedule is null || item.RetentionOwnerId == Guid.Empty)) throw new InvalidDataException();
        ValidateSettings(PublicSettings(value));
        if (value.Schedules.Any(item => item.Schedule.Enabled) && value.ProtectedArchivePassphrase is null) throw new InvalidDataException();
        var scopes = value.Destinations.Select(item => item.ManualRetentionOwnerId).Concat(value.Schedules.Select(item => item.RetentionOwnerId)).ToArray();
        if (scopes.Distinct().Count() != scopes.Length || value.Destinations.Any(item => new[] { item.ProtectedPassword, item.ProtectedSecretAccessKey, item.ProtectedSessionToken }.Any(secret => secret?.Length > 16384)) || value.ProtectedArchivePassphrase?.Length > 16384) throw new InvalidDataException();
    }
    private static void ValidateState(BackupRunDocumentV2 value)
    {
        if (value.Version != 2 || value.Schedules is null || value.Schedules.Length > 64 || value.Schedules.Any(item => item is null || item.ScheduleId is null || item.ScheduleId.Length is < 1 or > 64
            || item.ScheduleId.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '_' or '-'))
            || item.LastScheduledDate is not null && (!DateTime.TryParseExact(item.LastScheduledDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) || date.Year >= 9999))
            || value.Schedules.Select(item => item.ScheduleId).Distinct(StringComparer.Ordinal).Count() != value.Schedules.Length) throw new InvalidDataException();
        foreach (var run in value.Schedules.Select(item => item.LastRun).Append(value.LastRun))
            if (run is not null && (!Guid.TryParseExact(run.Id, "N", out _) || run.Status is not ("running" or "succeeded" or "failed") || run.Message is null || run.Message.Length > 4096
                || run.DestinationId?.Length > 64 || run.ScheduleId?.Length > 64 || run.Bytes < 0 || run.RemovedCount < 0 || run.ArchiveName?.Length > 200)) throw new InvalidDataException();
    }
    private static bool IsStorageError(Exception error) => error is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or CryptographicException;
    private static T Read<T>(string path)
    {
        RecoveryFileSystem.RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > MaximumDocumentBytes) throw new InvalidDataException("Backup settings are too large.");
        return JsonSerializer.Deserialize<T>(input, Json) ?? throw new InvalidDataException("Backup settings are empty.");
    }
    private static int ReadVersion(string path)
    {
        using var value = Read<JsonDocument>(path);
        if (value.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var version = value.RootElement.EnumerateObject().FirstOrDefault(item => item.Name.Equals("version", StringComparison.OrdinalIgnoreCase)).Value;
        if (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var result)) throw new InvalidDataException();
        return result;
    }
    private static string Fingerprint(string path)
    {
        if (!File.Exists(path)) return "missing";
        RecoveryFileSystem.RejectLinks(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > MaximumDocumentBytes) return "oversized";
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
        app.MapGet("/api/gateway/backups", (GatewayBackups backups) => backups.Snapshot()).Access("backups");
        app.MapPut("/api/gateway/backups", (BackupConfigurationRequest request, GatewayBackups backups) => backups.SaveConfiguration(request)).Access("backups", audit: true);
        app.MapPost("/api/gateway/backups/run", (BackupRunRequest request, GatewayBackups backups, HttpContext context)
            => Results.Json(backups.StartManual(request, GatewayAccess.Actor(context)), statusCode: 202)).Access("backups", audit: true);
        app.MapGet("/api/gateway/backups/download/{id}", (string id, GatewayBackups backups) =>
        { var file = backups.Download(id); return Results.File(file.Stream, "application/octet-stream", file.Name, enableRangeProcessing: false); }).Access("backups", audit: true);
    }
}
