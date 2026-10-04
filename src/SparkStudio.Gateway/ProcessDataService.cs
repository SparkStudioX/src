using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

namespace SparkStudio.Gateway;

public sealed record AlarmDefinition(string Id, string Name, string TagPath, bool Enabled, string Mode, double Setpoint, double Deadband = 0, int Priority = 1, string? Message = null);
public sealed record HistoryDefinition(string TagPath, bool Enabled, double Deadband = 0, int MaxIntervalMs = 60000, int RetentionDays = 7);
public sealed record ProcessDataConfiguration(long Revision, int AlarmRetentionDays, AlarmDefinition[] Alarms, HistoryDefinition[] History, string? ConfigurationError = null, string? StorageError = null, bool ReplaceInvalidConfiguration = false);
public sealed record AlarmState(string Id, string Name, string TagPath, int Priority, bool Active, bool Acknowledged, string Quality,
    JsonElement Value, string? ActiveAt, string? ClearedAt, string? AcknowledgedAt, string? AcknowledgedBy, string EventId, string? Message = null);
public sealed record AlarmJournalEntry(string Id, string Name, string TagPath, int Priority, bool Active, bool Acknowledged, string Quality,
    JsonElement Value, string RecordedAt, string Kind, string? Actor, string EventId, string? Message = null);
public sealed record AlarmJournalResult(AlarmJournalEntry[] Events, bool Truncated);
public sealed record HistoryPoint(string Timestamp, JsonElement Value, string Quality);
public sealed record HistorySeries(string Path, HistoryPoint[] Points);
public sealed record HistoryQuery(string[] Paths, DateTimeOffset Start, DateTimeOffset End, int MaxPoints = 1000);
public sealed record AlarmAcknowledgeRequest(string EventId);

/// <summary>Single-node durable alarms and bounded raw history; no network connector or notification side effects.</summary>
public sealed class ProcessDataService : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private readonly object gate = new();
    private readonly string configurationPath;
    private readonly SqliteConnection? database;
    private SqliteConnection Database => database ?? throw new InvalidOperationException(storageError ?? "Process data storage is unavailable.");
    private string? configurationError;
    private string? storageError;
    private readonly TagEngine tags;
    private readonly RecoveryQuarantine recovery;
    private readonly ILogger<ProcessDataService> logger;
    private readonly TimeProvider clock;
    private ProcessDataConfiguration configuration;
    private readonly Dictionary<string, AlarmState> states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (JsonElement Value, string Quality, DateTimeOffset Recorded)> samples = new(StringComparer.Ordinal);
    private DateTimeOffset lastRetention;
    private string? error;
    private bool configurationPending = true;
    private long modelGeneration = -1;
    private AlarmDefinition[] modelAlarms = [];
    private AlarmDefinition[] EffectiveAlarms => [.. configuration.Alarms, .. modelAlarms];

    public ProcessDataService(string directory, TagEngine tags, RecoveryQuarantine recovery, ILogger<ProcessDataService> logger, TimeProvider? clock = null)
    {
        this.tags = tags; this.recovery = recovery; this.logger = logger; this.clock = clock ?? TimeProvider.System;
        configurationPath = Path.Combine(directory, "process-data.json");
        configuration = new(1, 30, [], []);
        try
        {
            RecoveryFileSystem.RejectLinks(configurationPath);
            if (File.Exists(configurationPath))
            {
                if (new FileInfo(configurationPath).Length > 32 * 1024 * 1024) throw new InvalidDataException("Process data configuration is too large.");
                configuration = JsonSerializer.Deserialize<ProcessDataConfiguration>(File.ReadAllText(configurationPath), Json)
                    ?? throw new InvalidDataException("Process data configuration is invalid.");
                Validate(configuration);
                if (configuration.ConfigurationError is not null || configuration.StorageError is not null || configuration.ReplaceInvalidConfiguration)
                    throw new InvalidDataException("Saved process data contains request-only recovery fields.");
            }
        }
        catch (Exception exception) when (StorageFailure(exception))
        {
            configuration = new(1, 30, [], []);
            configurationError = "Saved process data configuration is unreadable or invalid. Recording is stopped; explicitly replace it below after reviewing the recovery draft. The original file will be preserved.";
            GatewayLog.ProcessConfigurationUnavailable(logger, exception);
        }
        try
        {
            var folder = Path.Combine(directory, "process-data"); RecoveryFileSystem.RejectLinks(folder); Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "journal.sqlite"); RecoveryFileSystem.RejectLinks(path);
            database = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false, DefaultTimeout = 5 }.ToString());
            database.Open();
            Execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS alarm_state (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS alarm_definition (id TEXT PRIMARY KEY, identity TEXT NOT NULL); CREATE TABLE IF NOT EXISTS alarm_journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, recorded INTEGER NOT NULL, document TEXT NOT NULL); CREATE INDEX IF NOT EXISTS alarm_journal_time ON alarm_journal(recorded); CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, recorded INTEGER NOT NULL, value TEXT NOT NULL, quality TEXT NOT NULL); CREATE INDEX IF NOT EXISTS history_path_time ON history(path,recorded); CREATE TABLE IF NOT EXISTS history_retention(path TEXT PRIMARY KEY, days INTEGER NOT NULL);");
            using (var transaction = Database.BeginTransaction())
            {
                foreach (var policy in configuration.History) SaveRetention(policy, transaction);
                // A pre-policy database can contain orphaned paths. Bound those by a
                // documented seven-day fallback rather than retaining rows forever.
                Execute("INSERT OR IGNORE INTO history_retention(path,days) SELECT DISTINCT path,7 FROM history", transaction);
                transaction.Commit();
            }
            using (var command = Database.CreateCommand())
            {
            command.CommandText = "SELECT document FROM alarm_state";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var state = JsonSerializer.Deserialize<AlarmState>(reader.GetString(0), Json) ?? throw new InvalidDataException("Stored alarm state is invalid.");
                if (string.IsNullOrWhiteSpace(state.Id) || string.IsNullOrWhiteSpace(state.EventId) || state.Priority is < 1 or > 4 || state.Quality is null || state.Value.ValueKind == JsonValueKind.Undefined)
                    throw new InvalidDataException("Stored alarm state is invalid.");
                ValidatePath(state.TagPath);
                states[state.Id] = state;
            }
            }
            if (configurationError is null) ReconcileConfiguration();
        }
        catch (Exception exception) when (StorageFailure(exception))
        {
            database?.Dispose(); database = null; states.Clear();
            storageError = "Process data storage is unavailable. Recording and runtime reads are stopped. Preserve the database, repair or restore it, then restart the gateway.";
            GatewayLog.ProcessStorageUnavailable(logger, exception);
        }
    }

    private static bool StorageFailure(Exception error) => error is IOException or UnauthorizedAccessException or JsonException or SqliteException or ArgumentException or InvalidOperationException;
    private void EnsureAvailable()
    {
        recovery.EnsureOperationsAllowed();
        if (configurationError is not null || storageError is not null || error is not null) throw new InvalidOperationException(configurationError ?? storageError ?? error);
    }
    public ProcessDataConfiguration Configuration() { lock (gate) return configuration with { Alarms = [.. configuration.Alarms], History = [.. configuration.History], ConfigurationError = configurationError, StorageError = storageError ?? error }; }
    public object Diagnostics() { lock (gate) return new { error = configurationError ?? storageError ?? error, configurationError, storageError, configuredAlarms = configuration.Alarms.Length, modelAlarms = modelAlarms.Length, configuredHistory = configuration.History.Length, activeAlarms = states.Values.Count(state => state.Active), enabled = !recovery.Active && configurationError is null && storageError is null && error is null }; }
    public AlarmDefinition[] ModelAlarms() { lock (gate) { RefreshModelAlarms(); return [.. modelAlarms]; } }
    private void RefreshModelAlarms()
    {
        var current = tags.ModelAlarmConfiguration();
        if (current.Generation == modelGeneration) return;
        modelGeneration = current.Generation; modelAlarms = current.Alarms; configurationPending = true;
    }
    public ProcessDataConfiguration Save(ProcessDataConfiguration next)
    {
        Validate(next);
        lock (gate)
        {
            if (storageError is not null) throw new InvalidOperationException(storageError);
            if (configurationPending && configurationError is null) ReconcileConfiguration();
            if (next.Revision != configuration.Revision) throw new InvalidOperationException("Process data configuration changed. Reload before saving.");
            if (configurationError is not null)
            {
                if (!next.ReplaceInvalidConfiguration) throw new InvalidOperationException("Confirm replacement of the invalid configuration. Its original bytes will be archived before saving.");
                RecoveryFileSystem.RejectLinks(configurationPath);
                var backup = configurationPath + ".invalid-" + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N") + ".json";
                using var source = new FileStream(configurationPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var output = new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                source.CopyTo(output); output.Flush(true);
            }
            var saved = next with { Revision = checked(next.Revision + 1), Alarms = [.. next.Alarms], History = [.. next.History], ConfigurationError = null, StorageError = null, ReplaceInvalidConfiguration = false };
            DurableJsonFile.Write(configurationPath, JsonSerializer.SerializeToNode(saved, Json)!);
            configuration = saved; configurationError = null; configurationPending = true;
            try
            {
                ReconcileConfiguration();
            }
            catch (Exception exception) when (StorageFailure(exception))
            {
                error = "Configuration was saved, but recording storage could not be updated. Inspect process data diagnostics and reload before making another change.";
                GatewayLog.ProcessConfigurationWriteFailed(logger, exception);
                throw new InvalidOperationException(error, exception);
            }
            return Configuration();
        }
    }

    // The file is the desired configuration. Persisted definition identities let
    // startup and retry finish its SQLite side after a failed save or power loss.
    private void ReconcileConfiguration()
    {
        RefreshModelAlarms();
        var now = clock.GetUtcNow();
        using var transaction = Database.BeginTransaction();
        var identities = new Dictionary<string, string>(StringComparer.Ordinal);
        using (var command = Database.CreateCommand())
        {
            command.Transaction = transaction; command.CommandText = "SELECT id,identity FROM alarm_definition";
            using var reader = command.ExecuteReader();
            while (reader.Read()) identities[reader.GetString(0)] = reader.GetString(1);
        }
        var definitions = EffectiveAlarms.ToDictionary(item => item.Id, StringComparer.Ordinal);
        var removed = new List<string>();
        foreach (var previous in states.Values)
        {
            var exists = definitions.TryGetValue(previous.Id, out var definition);
            if (exists && identities.TryGetValue(previous.Id, out var identity) && identity == AlarmIdentity(definition!)) continue;
            Journal(previous with { Active = false, ClearedAt = now.ToString("O") }, exists ? "reconfigured" : "removed", "configuration", now, transaction);
            Execute("DELETE FROM alarm_state WHERE id=$id", transaction, ("$id", previous.Id));
            removed.Add(previous.Id);
        }
        foreach (var id in identities.Keys.Where(id => !definitions.ContainsKey(id)))
            Execute("DELETE FROM alarm_definition WHERE id=$id", transaction, ("$id", id));
        foreach (var definition in definitions.Values)
            Execute("INSERT INTO alarm_definition(id,identity) VALUES($id,$identity) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity", transaction,
                ("$id", definition.Id), ("$identity", AlarmIdentity(definition)));
        foreach (var policy in configuration.History) SaveRetention(policy, transaction);
        Prune(transaction, now);
        transaction.Commit();
        foreach (var id in removed) states.Remove(id);
        lastRetention = now; samples.Clear(); configurationPending = false; error = null;
    }
    private static string AlarmIdentity(AlarmDefinition value)
        => JsonSerializer.Serialize(new { value.TagPath, value.Mode, value.Setpoint, value.Deadband, value.Enabled }, Json);

    public static void Validate(ProcessDataConfiguration value)
    {
        if (value.Revision < 1 || value.AlarmRetentionDays is < 1 or > 3650 || value.Alarms is null || value.History is null || value.Alarms.Length > 2000 || value.History.Length > 5000)
            throw new ArgumentException("Choose 1–3650 retention days, at most 2,000 alarms and 5,000 historical tags.");
        var ids = new HashSet<string>(StringComparer.Ordinal); var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var alarm in value.Alarms) ValidateAlarm(alarm, ids);
        foreach (var history in value.History)
        {
            if (history is null || !paths.Add(history.TagPath) || !double.IsFinite(history.Deadband) || history.Deadband < 0 || history.MaxIntervalMs is < 250 or > 86400000 || history.RetentionDays is < 1 or > 3650)
                throw new ArgumentException("History paths must be unique, with nonnegative deadband, 250–86400000 ms maximum interval and 1–3650 retention days.");
            ValidatePath(history.TagPath);
        }
    }
    private static void ValidateAlarm(AlarmDefinition? alarm, HashSet<string> ids)
    {
        if (alarm is null || string.IsNullOrWhiteSpace(alarm.Id) || alarm.Id.Length > 64 || !alarm.Id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') || !ids.Add(alarm.Id)
            || string.IsNullOrWhiteSpace(alarm.Name) || alarm.Name.Length > 200 || alarm.Mode is not ("high" or "low" or "equal") || !double.IsFinite(alarm.Setpoint) || !double.IsFinite(alarm.Deadband) || alarm.Deadband < 0 || alarm.Priority is < 1 or > 4)
            throw new ArgumentException("Alarm definitions need unique IDs, names, high/low/equal mode, finite setpoints, nonnegative deadbands and priority 1–4.");
        ValidateAlarmMessage(alarm);
        ValidatePath(alarm.TagPath);
    }
    private static void ValidateAlarmMessage(AlarmDefinition alarm)
    {
        if (alarm.Id.StartsWith(ModelAlarmTemplates.Prefix, StringComparison.Ordinal) || alarm.Message is not null && (alarm.Message.Length > 2048 || alarm.Message.Any(char.IsControl)))
            throw new ArgumentException("Alarm IDs beginning model_ are reserved for model templates; messages require at most 2048 characters without controls.");
    }
    private static void ValidatePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1024 || !path.StartsWith('[') || !path.Contains(']') || path.Contains('{') || path.Contains('}') || path.Any(char.IsControl))
            throw new ArgumentException("Process data requires a fully resolved tag path including its provider.");
    }

    public AlarmState[] Alarms(Func<string, bool> canRead)
    { lock (gate) { EnsureAvailable(); return states.Values.Where(state => canRead(state.TagPath)).OrderByDescending(state => state.Priority).ThenBy(state => state.Name, StringComparer.Ordinal).ToArray(); } }

    public AlarmState Acknowledge(string id, string eventId, string actor, Func<string, bool> canRead)
    {
        recovery.EnsureOperationsAllowed();
        lock (gate)
        {
            EnsureAvailable();
            if (!states.TryGetValue(id, out var state) || !canRead(state.TagPath)) throw new KeyNotFoundException("Alarm is unavailable in this project.");
            if (state.EventId != eventId) throw new InvalidOperationException("This alarm occurrence changed. Refresh before acknowledging.");
            if (state.Acknowledged) return state;
            var now = clock.GetUtcNow(); var next = state with { Acknowledged = true, AcknowledgedAt = now.ToString("O"), AcknowledgedBy = actor };
            using var transaction = Database.BeginTransaction(); Persist(next, transaction); Journal(next, "acknowledged", actor, now, transaction); transaction.Commit(); states[id] = next; return next;
        }
    }

    public AlarmJournalEntry[] Journal(Func<string, bool> canRead, int limit) => JournalPage(canRead, limit).Events;
    public AlarmJournalResult JournalPage(Func<string, bool> canRead, int limit)
    {
        if (limit is < 1 or > 1000) throw new ArgumentException("Journal limit must be 1–1000.");
        lock (gate)
        {
            EnsureAvailable();
            using var command = Database.CreateCommand(); command.CommandText = "SELECT document FROM alarm_journal ORDER BY sequence DESC LIMIT 10001";
            using var reader = command.ExecuteReader(); var result = new List<AlarmJournalEntry>(); var scanned = 0; var truncated = false;
            while (reader.Read())
            {
                if (++scanned > 10000) { truncated = true; break; }
                var item = JsonSerializer.Deserialize<AlarmJournalEntry>(reader.GetString(0), Json)!;
                if (!canRead(item.TagPath)) continue;
                if (result.Count == limit) { truncated = true; break; }
                result.Add(item);
            }
            return new(result.ToArray(), truncated);
        }
    }

    public object Query(HistoryQuery request, Func<string, bool> canRead)
    {
        if (request.Paths is null || request.Paths.Length is < 1 or > 32 || request.Paths.Distinct(StringComparer.Ordinal).Count() != request.Paths.Length || request.MaxPoints is < 2 or > 10000
            || request.End <= request.Start || request.End - request.Start > TimeSpan.FromDays(31)) throw new ArgumentException("History queries require 1–32 unique tags, a range up to 31 days, and 2–10000 points per tag.");
        foreach (var path in request.Paths) { ValidatePath(path); if (!canRead(path)) throw new UnauthorizedAccessException("A history tag is outside this project's permitted scope."); }
        lock (gate)
        {
            EnsureAvailable();
            var truncated = false; var series = new List<HistorySeries>();
            foreach (var path in request.Paths)
            {
                using var command = Database.CreateCommand(); command.CommandText = "SELECT recorded,value,quality FROM history WHERE path=$path AND recorded >= $start AND recorded <= $end ORDER BY recorded DESC,sequence DESC LIMIT $limit";
                command.Parameters.AddWithValue("$path", path); command.Parameters.AddWithValue("$start", request.Start.ToUnixTimeMilliseconds()); command.Parameters.AddWithValue("$end", request.End.ToUnixTimeMilliseconds()); command.Parameters.AddWithValue("$limit", request.MaxPoints + 1);
                using var reader = command.ExecuteReader(); var points = new List<HistoryPoint>();
                while (reader.Read()) points.Add(new(DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(0)).ToString("O"), JsonSerializer.Deserialize<JsonElement>(reader.GetString(1)), reader.GetString(2)));
                if (points.Count > request.MaxPoints) { truncated = true; points.RemoveAt(points.Count - 1); }
                points.Reverse(); series.Add(new(path, points.ToArray()));
            }
            return new { series, truncated };
        }
    }

    public void Sample()
    {
        if (recovery.Active) return;
        lock (gate)
        {
            if (configurationError is not null || storageError is not null) return;
            RefreshModelAlarms();
            if (configurationPending) ReconcileConfiguration();
            var now = clock.GetUtcNow();
            var paths = EffectiveAlarms.Select(alarm => alarm.TagPath).Concat(configuration.History.Where(item => item.Enabled).Select(item => item.TagPath)).Distinct(StringComparer.Ordinal).ToArray();
            var readings = tags.Read(paths, null).ToDictionary(value => value.Path, StringComparer.Ordinal);
            using var transaction = Database.BeginTransaction();
            var updates = new List<AlarmState>(); var historyUpdates = new List<(string Path, JsonElement Value, string Quality)>();
            foreach (var alarm in EffectiveAlarms)
            {
                var reading = readings[alarm.TagPath]; var value = JsonSerializer.SerializeToElement(reading.Value);
                states.TryGetValue(alarm.Id, out var previous);
                var good = reading.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number);
                var quality = alarm.Enabled && reading.Quality.StartsWith("Good", StringComparison.OrdinalIgnoreCase) && !good ? "Bad_TypeMismatch" : reading.Quality;
                var active = previous?.Active ?? false;
                if (!alarm.Enabled) active = false;
                else if (good)
                {
                    var numeric = value.GetDouble();
                    active = alarm.Mode switch { "high" => active ? numeric >= alarm.Setpoint - alarm.Deadband : numeric >= alarm.Setpoint,
                        "low" => active ? numeric <= alarm.Setpoint + alarm.Deadband : numeric <= alarm.Setpoint,
                        _ => Math.Abs(numeric - alarm.Setpoint) <= (active ? alarm.Deadband : 0) };
                }
                var activated = active && previous?.Active != true; var cleared = !active && previous?.Active == true;
                var next = new AlarmState(alarm.Id, alarm.Name, alarm.TagPath, alarm.Priority, active, activated ? false : previous?.Acknowledged ?? true,
                    alarm.Enabled ? quality : "Disabled", value, activated ? now.ToString("O") : previous?.ActiveAt, cleared ? now.ToString("O") : activated ? null : previous?.ClearedAt,
                    activated ? null : previous?.AcknowledgedAt, activated ? null : previous?.AcknowledgedBy, activated || previous is null ? Guid.NewGuid().ToString("N") : previous.EventId, alarm.Message);
                var changed = AlarmChanged(previous, next, activated, cleared);
                if (changed) { Persist(next, transaction); Journal(next, activated ? "active" : cleared ? "cleared" : previous is null ? "initial" : "quality", null, now, transaction); }
                updates.Add(next);
            }
            foreach (var history in configuration.History.Where(item => item.Enabled))
            {
                var reading = readings[history.TagPath]; var value = JsonSerializer.SerializeToElement(reading.Value);
                if (samples.TryGetValue(history.TagPath, out var previous) && previous.Quality == reading.Quality && now - previous.Recorded < TimeSpan.FromMilliseconds(history.MaxIntervalMs)
                    && !ValueChanged(previous.Value, value, history.Deadband)) continue;
                Execute("INSERT INTO history(path,recorded,value,quality) VALUES($path,$time,$value,$quality)", transaction, ("$path", history.TagPath), ("$time", now.ToUnixTimeMilliseconds()), ("$value", value.GetRawText()), ("$quality", reading.Quality));
                SaveRetention(history, transaction);
                historyUpdates.Add((history.TagPath, value, reading.Quality));
            }
            if (now - lastRetention >= TimeSpan.FromHours(1)) Prune(transaction, now);
            transaction.Commit();
            foreach (var update in updates) states[update.Id] = update;
            foreach (var update in historyUpdates) samples[update.Path] = (update.Value, update.Quality, now);
            if (now - lastRetention >= TimeSpan.FromHours(1)) lastRetention = now;
            error = null;
        }
    }

    private static bool AlarmChanged(AlarmState? previous, AlarmState next, bool activated, bool cleared)
        => previous is null || activated || cleared || previous.Quality != next.Quality || previous.Name != next.Name
            || previous.TagPath != next.TagPath || previous.Priority != next.Priority || previous.Message != next.Message;

    private void SaveRetention(HistoryDefinition policy, SqliteTransaction transaction)
        => Execute("INSERT INTO history_retention(path,days) VALUES($path,$days) ON CONFLICT(path) DO UPDATE SET days=excluded.days", transaction, ("$path", policy.TagPath), ("$days", policy.RetentionDays));
    private void Prune(SqliteTransaction transaction, DateTimeOffset now)
    {
        Execute("DELETE FROM alarm_journal WHERE recorded < $time", transaction, ("$time", now.AddDays(-configuration.AlarmRetentionDays).ToUnixTimeMilliseconds()));
        using var policies = Database.CreateCommand(); policies.Transaction = transaction; policies.CommandText = "SELECT path,days FROM history_retention";
        var retained = new List<(string Path, int Days)>();
        using (var reader = policies.ExecuteReader()) while (reader.Read()) retained.Add((reader.GetString(0), reader.GetInt32(1)));
        foreach (var policy in retained)
        {
            if (policy.Days is < 1 or > 3650) throw new InvalidDataException("Stored history retention is invalid.");
            Execute("DELETE FROM history WHERE path=$path AND recorded < $time", transaction, ("$path", policy.Path), ("$time", now.AddDays(-policy.Days).ToUnixTimeMilliseconds()));
            if (!configuration.History.Any(item => item.TagPath == policy.Path)) Execute("DELETE FROM history_retention WHERE path=$path AND NOT EXISTS(SELECT 1 FROM history WHERE path=$path)", transaction, ("$path", policy.Path));
        }
    }

    private static bool ValueChanged(JsonElement previous, JsonElement next, double deadband)
        => previous.ValueKind == JsonValueKind.Number && next.ValueKind == JsonValueKind.Number && previous.TryGetDouble(out var left) && next.TryGetDouble(out var right)
            ? Math.Abs(right - left) > deadband : previous.GetRawText() != next.GetRawText();
    private void Persist(AlarmState state, SqliteTransaction transaction) => Execute("INSERT INTO alarm_state(id,document) VALUES($id,$document) ON CONFLICT(id) DO UPDATE SET document=excluded.document", transaction, ("$id", state.Id), ("$document", JsonSerializer.Serialize(state, Json)));
    private void Journal(AlarmState state, string kind, string? actor, DateTimeOffset now, SqliteTransaction transaction)
    {
        var entry = new AlarmJournalEntry(state.Id, state.Name, state.TagPath, state.Priority, state.Active, state.Acknowledged, state.Quality, state.Value, now.ToString("O"), kind, actor, state.EventId, state.Message);
        Execute("INSERT INTO alarm_journal(recorded,document) VALUES($time,$document)", transaction, ("$time", now.ToUnixTimeMilliseconds()), ("$document", JsonSerializer.Serialize(entry, Json)));
    }
    private void Execute(string sql, SqliteTransaction? transaction = null, params (string Name, object Value)[] parameters)
    {
        using var command = Database.CreateCommand(); command.CommandText = sql; command.Transaction = transaction;
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Name, parameter.Value);
        command.ExecuteNonQuery();
    }
    private static void RejectLink(string path) { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Process data files cannot be symbolic links."); }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { Sample(); }
            catch (Exception exception) when (exception is SqliteException or IOException or InvalidOperationException)
            { lock (gate) error = "Process data storage is unavailable. Check gateway logs and free disk space."; GatewayLog.ProcessSampleWriteFailed(logger, exception); }
            await Task.Delay(250, stoppingToken);
        }
    }
    public override void Dispose() { base.Dispose(); lock (gate) database?.Dispose(); }
}
