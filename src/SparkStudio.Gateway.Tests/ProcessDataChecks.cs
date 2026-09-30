using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

internal static class ProcessDataChecks
{
    private sealed class Clock : TimeProvider { public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now; }
    public static int Run()
    {
        var count = 0;
        void Check(bool value, string label) { if (!value) throw new Exception("FAILED: " + label); count++; }
        void Reject(Action action, string label) { try { action(); } catch (Exception error) when (error is ArgumentException or UnauthorizedAccessException or InvalidOperationException or KeyNotFoundException or SqliteException) { count++; return; } throw new Exception("FAILED to reject: " + label); }
        var directory = Path.Combine(Path.GetTempPath(), "SparkStudio.ProcessData." + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ProjectStore(directory, new EphemeralDataProtectionProvider());
            using var connectors = new ConnectorService(directory);
            using var tags = new TagEngine(store, connectors, NullLogger<TagEngine>.Instance);
            var clock = new Clock(); var recovery = new RecoveryQuarantine(directory);
            const string path = "[default]ProcessFixture/Temperature";
            tags.SaveDefinition(new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 10, ["enabled"] = true });
            void Write(double value) { tags.WriteMemory([path], [JsonSerializer.SerializeToElement(value)]); clock.Now = clock.Now.AddSeconds(1); }
            string occurrence;
            using (var service = new ProcessDataService(directory, tags, recovery, NullLogger<ProcessDataService>.Instance, clock))
            {
                var config = service.Save(new(1, 1, [new("hot", "Temperature high", path, true, "high", 50, 5, 3)], [new(path, true, 2, 10000, 1)]));
                Check(config.Revision == 2, "configuration uses optimistic revision");
                Reject(() => service.Save(config with { Revision = 1 }), "stale config write");
                Reject(() => service.Save(config with { Alarms = [config.Alarms[0] with { Deadband = -1 }] }), "negative deadband");
                service.Sample(); Check(!service.Alarms(_ => true).Single().Active, "initial normal state");
                Check(service.Alarms(_ => false).Length == 0, "alarm tag scope hides definitions");
                Write(51); service.Sample(); var alarm = service.Alarms(_ => true).Single(); occurrence = alarm.EventId;
                Check(alarm.Active && !alarm.Acknowledged && alarm.ActiveAt is not null, "high transition creates unacknowledged occurrence");
                Write(48); service.Sample(); Check(service.Alarms(_ => true).Single().Active, "deadband prevents chattering");
                Reject(() => service.Acknowledge("hot", occurrence, "fixture", _ => false), "out-of-scope acknowledgement");
                Reject(() => service.Acknowledge("hot", "stale", "fixture", _ => true), "stale occurrence acknowledgement");
                Check(service.Acknowledge("hot", occurrence, "fixture-operator", _ => true).AcknowledgedBy == "fixture-operator", "acknowledgement stores actor");
                var journalCount = service.Journal(_ => true, 100).Length;
                service.Acknowledge("hot", occurrence, "fixture-operator", _ => true);
                Check(service.Journal(_ => true, 100).Length == journalCount, "acknowledgement retry is idempotent");
                tags.SaveDefinition(new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 48, ["enabled"] = false });
                service.Sample(); Check(service.Alarms(_ => true).Single().Active, "bad quality does not clear an active alarm");
                tags.SaveDefinition(new JsonObject { ["path"] = path, ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 44, ["enabled"] = true });
                service.Sample(); alarm = service.Alarms(_ => true).Single();
                Check(!alarm.Active && alarm.Acknowledged && alarm.ClearedAt is not null, "clear retains acknowledgement");
                Write(55); service.Sample(); alarm = service.Alarms(_ => true).Single();
                Check(alarm.Active && !alarm.Acknowledged && alarm.EventId != occurrence, "reactivation has new occurrence"); occurrence = alarm.EventId;
                Reject(() => service.Query(new([path], clock.Now.AddMinutes(-10), clock.Now), _ => false), "history respects tag scope");
                var result = JsonSerializer.SerializeToNode(service.Query(new([path], clock.Now.AddMinutes(-10), clock.Now, 2), _ => true), ProjectStore.Json)!;
                Check(result["truncated"]!.GetValue<bool>() && result["series"]![0]!["points"]!.AsArray().Count == 2, "raw query has explicit bounded truncation");
                Check(service.Journal(_ => false, 100).Length == 0, "journal scope hides events");
            }
            using (var restart = new ProcessDataService(directory, tags, recovery, NullLogger<ProcessDataService>.Instance, clock))
            {
                Check(restart.Alarms(_ => true).Single().EventId == occurrence && !restart.Alarms(_ => true).Single().Acknowledged, "alarm occurrence persists across restart");
                restart.Acknowledge("hot", occurrence, "after-restart", _ => true);
                Check(restart.Journal(_ => true, 100).Any(item => item.Kind == "acknowledged" && item.Actor == "after-restart"), "journal persists acknowledgement");
                clock.Now = clock.Now.AddDays(2); restart.Sample();
                var result = JsonSerializer.SerializeToNode(restart.Query(new([path], clock.Now.AddDays(-3), clock.Now.AddDays(-1)), _ => true), ProjectStore.Json)!;
                Check(result["series"]![0]!["points"]!.AsArray().Count == 0, "retention removes expired samples");
                Check(restart.Journal(_ => true, 100).All(item => DateTimeOffset.Parse(item.RecordedAt) >= clock.Now.AddDays(-1)), "journal retention removes old events");
            }
            var reconciliationDirectory = Path.Combine(directory, "reconciliation");
            Directory.CreateDirectory(reconciliationDirectory);
            var databasePath = Path.Combine(reconciliationDirectory, "process-data", "journal.sqlite");
            void DatabaseSql(string sql)
            {
                using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = databasePath, Pooling = false }.ToString()); connection.Open();
                using var command = connection.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery();
            }
            string staleEvent;
            using (var changed = new ProcessDataService(reconciliationDirectory, tags, new RecoveryQuarantine(reconciliationDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                var config = changed.Save(new(1, 7, [new("reuse", "Reusable alarm", path, true, "high", 50, 5, 3)], []));
                Write(80); changed.Sample(); var old = changed.Alarms(_ => true).Single();
                changed.Acknowledge(old.Id, old.EventId, "old-source-operator", _ => true);
                const string otherPath = "[default]ProcessFixture/Other";
                tags.SaveDefinition(new JsonObject { ["path"] = otherPath, ["kind"] = "memory", ["dataType"] = "Double", ["value"] = 90, ["enabled"] = true });
                config = changed.Save(config with { Alarms = [config.Alarms[0] with { TagPath = otherPath }] }); changed.Sample();
                var replaced = changed.Alarms(_ => true).Single();
                Check(replaced.Active && !replaced.Acknowledged && replaced.EventId != old.EventId && replaced.AcknowledgedBy is null, "changing alarm source never inherits another source's acknowledgement or occurrence");
                Check(changed.Journal(_ => true, 100).Any(item => item.Kind == "reconfigured" && item.EventId == old.EventId && !item.Active), "definition replacement closes and journals prior occurrence");
                changed.Acknowledge(replaced.Id, replaced.EventId, "old-condition-operator", _ => true);
                config = changed.Save(config with { Alarms = [config.Alarms[0] with { Setpoint = 85 }] }); changed.Sample();
                var changedCondition = changed.Alarms(_ => true).Single();
                Check(changedCondition.EventId != replaced.EventId && !changedCondition.Acknowledged, "condition changes create independent alarm occurrences");
                tags.SaveDefinition(new JsonObject { ["path"] = otherPath, ["kind"] = "memory", ["dataType"] = "String", ["value"] = "invalid-number", ["enabled"] = true });
                changed.Sample();
                Check(changed.Alarms(_ => true).Single() is { Active: true, Quality: "Bad_TypeMismatch" }, "good source quality with a nonnumeric value preserves active condition but reports a type fault");
                Check(changed.Journal(_ => true, 100).Any(item => item.Quality == "Bad_TypeMismatch"), "alarm type fault is journaled");
                staleEvent = changedCondition.EventId;
                DatabaseSql("CREATE TRIGGER fixture_deny_delete BEFORE DELETE ON alarm_state BEGIN SELECT RAISE(ABORT, 'synthetic reconciliation failure'); END;");
                Reject(() => changed.Save(config with { Alarms = [] }), "configuration-save SQL failure is explicit");
                Check(changed.Configuration().Alarms.Length == 0 && changed.Configuration().Revision == config.Revision + 1, "desired saved configuration is visible after SQL reconciliation failure");
                Reject(() => changed.Alarms(_ => true), "incomplete reconciliation cannot expose stale healthy alarm state");
                Reject(changed.Sample, "sampling must retry failed reconciliation before clearing diagnostic error");
                DatabaseSql("DROP TRIGGER fixture_deny_delete;"); changed.Sample();
                Check(changed.Alarms(_ => true).Length == 0 && JsonSerializer.SerializeToNode(changed.Diagnostics(), ProjectStore.Json)!["enabled"]!.GetValue<bool>(), "successful retry removes old state before returning to healthy sampling");
                config = changed.Save(changed.Configuration() with { Alarms = [new("reuse", "New use", path, true, "high", 50)] }); changed.Sample();
                var reused = changed.Alarms(_ => true).Single();
                Check(reused.EventId != staleEvent && !reused.Acknowledged, "removed alarm IDs cannot resurrect acknowledged occurrences");
                DatabaseSql("CREATE TRIGGER fixture_deny_delete BEFORE DELETE ON alarm_state BEGIN SELECT RAISE(ABORT, 'synthetic reconciliation failure'); END;");
                Reject(() => changed.Save(config with { Alarms = [] }), "restart fixture preserves desired config despite SQL failure");
            }
            DatabaseSql("DROP TRIGGER fixture_deny_delete;");
            using (var restarted = new ProcessDataService(reconciliationDirectory, tags, new RecoveryQuarantine(reconciliationDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                Check(restarted.Alarms(_ => true).Length == 0, "startup reconciles orphaned database rows before exposing alarm state");
                using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = databasePath, Pooling = false }.ToString()); connection.Open();
                using var query = connection.CreateCommand(); query.CommandText = "SELECT COUNT(*) FROM alarm_state";
                Check(Convert.ToInt32(query.ExecuteScalar()) == 0, "startup deletes persisted orphans rather than only filtering them in memory");
            }
            var scopedJournalDirectory = Path.Combine(directory, "scoped-journal");
            using (var journalService = new ProcessDataService(scopedJournalDirectory, tags, new RecoveryQuarantine(scopedJournalDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                var journalDb = Path.Combine(scopedJournalDirectory, "process-data", "journal.sqlite");
                using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = journalDb, Pooling = false }.ToString()); connection.Open();
                using var query = connection.CreateCommand();
                query.CommandText = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO alarm_journal(recorded,document) SELECT $time,$document FROM n";
                query.Parameters.AddWithValue("$time", clock.Now.ToUnixTimeMilliseconds());
                query.Parameters.AddWithValue("$document", JsonSerializer.Serialize(new AlarmJournalEntry("other", "Other", "[default]Other", 1, true, false, "Good", JsonSerializer.SerializeToElement(10), clock.Now.ToString("O"), "active", null, "event-other"), ProjectStore.Json));
                query.ExecuteNonQuery();
                var page = journalService.JournalPage(candidate => candidate == path, 100);
                Check(page.Events.Length == 0 && page.Truncated, "unrelated high-volume alarms cannot appear as a complete empty scoped journal");
                page = journalService.JournalPage(_ => true, 2);
                Check(page.Events.Length == 2 && page.Truncated, "journal visible-row limit discloses additional matching records");
                query.CommandText = "DELETE FROM alarm_journal WHERE sequence>2"; query.Parameters.Clear(); query.ExecuteNonQuery();
                page = journalService.JournalPage(_ => true, 2);
                Check(page.Events.Length == 2 && !page.Truncated, "exactly complete journal limits do not claim extra rows");
                page = journalService.JournalPage(_ => false, 100);
                Check(page.Events.Length == 0 && !page.Truncated, "fully scanned unrelated history remains an honestly complete empty scope");
            }
            var corruptConfigDirectory = Path.Combine(directory, "corrupt-config"); Directory.CreateDirectory(corruptConfigDirectory);
            var corruptConfigPath = Path.Combine(corruptConfigDirectory, "process-data.json");
            File.WriteAllText(corruptConfigPath, "{invalid configuration bytes");
            using (var corrupt = new ProcessDataService(corruptConfigDirectory, tags, new RecoveryQuarantine(corruptConfigDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                Check(corrupt.Configuration().ConfigurationError is not null, "corrupt configuration is isolated and reported instead of preventing gateway startup");
                Check(JsonSerializer.SerializeToNode(corrupt.Diagnostics(), ProjectStore.Json)!["enabled"]!.GetValue<bool>() == false, "invalid configuration never reports recording healthy");
                Reject(() => corrupt.Alarms(_ => true), "corrupt configuration cannot return a misleading empty alarm list");
                Reject(() => corrupt.Query(new([path], clock.Now.AddHours(-1), clock.Now), _ => true), "corrupt configuration cannot return empty history as success");
                Reject(() => corrupt.Save(new(1, 7, [], [])), "invalid configuration requires explicit replacement confirmation");
                Check(File.ReadAllText(corruptConfigPath) == "{invalid configuration bytes", "unconfirmed recovery preserves original bytes");
                var replaced = corrupt.Save(new(1, 7, [], [], ReplaceInvalidConfiguration: true));
                Check(replaced.ConfigurationError is null && replaced.Revision == 2, "explicit replacement recovers usable configuration");
                var backup = Directory.GetFiles(corruptConfigDirectory, "process-data.json.invalid-*.json").Single();
                Check(File.ReadAllText(backup) == "{invalid configuration bytes", "recovery archives the original invalid file before replacement");
                corrupt.Sample(); Check(corrupt.Alarms(_ => true).Length == 0, "confirmed empty recovery draft is explicit and usable");
            }
            var corruptDatabaseDirectory = Path.Combine(directory, "corrupt-database"); Directory.CreateDirectory(Path.Combine(corruptDatabaseDirectory, "process-data"));
            var corruptDatabasePath = Path.Combine(corruptDatabaseDirectory, "process-data", "journal.sqlite");
            File.WriteAllText(corruptDatabasePath, "not a SQLite database");
            using (var corrupt = new ProcessDataService(corruptDatabaseDirectory, tags, new RecoveryQuarantine(corruptDatabaseDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                Check(corrupt.Configuration().StorageError is not null, "unreadable database is fault isolated with an explicit repair error");
                Reject(() => corrupt.Alarms(_ => true), "unreadable database cannot present an empty healthy alarm status");
                Reject(() => corrupt.Save(new(1, 7, [], [])), "configuration cannot conceal database unavailability");
                corrupt.Sample(); Check(File.ReadAllText(corruptDatabasePath) == "not a SQLite database", "sampling never deletes or recreates unreadable stored data");
            }
            var retentionDirectory = Path.Combine(directory, "retention"); Directory.CreateDirectory(retentionDirectory);
            using (var retention = new ProcessDataService(retentionDirectory, tags, new RecoveryQuarantine(retentionDirectory), NullLogger<ProcessDataService>.Instance, clock))
            {
                var config = retention.Save(new(1, 7, [], [new(path, true, 0, 1000, 7)])); retention.Sample();
                var recordedAt = clock.Now; clock.Now = clock.Now.AddDays(2);
                config = retention.Save(config with { History = [new(path, false, 0, 1000, 1)] });
                var result = JsonSerializer.SerializeToNode(retention.Query(new([path], recordedAt.AddMinutes(-1), recordedAt.AddMinutes(1)), _ => true), ProjectStore.Json)!;
                Check(result["series"]![0]!["points"]!.AsArray().Count == 0, "shorter retention takes effect on Save even for a disabled rule");
                config = retention.Save(config with { History = [new(path, true, 0, 1000, 1)] }); retention.Sample(); var removedAt = clock.Now;
                retention.Save(config with { History = [] }); clock.Now = clock.Now.AddDays(2); retention.Sample();
                result = JsonSerializer.SerializeToNode(retention.Query(new([path], removedAt.AddMinutes(-1), removedAt.AddMinutes(1)), _ => true), ProjectStore.Json)!;
                Check(result["series"]![0]!["points"]!.AsArray().Count == 0, "removed sampling rules retain their prior bounded cleanup policy");
                using var inspection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(retentionDirectory, "process-data", "journal.sqlite"), Pooling = false }.ToString()); inspection.Open();
                using var statement = inspection.CreateCommand(); statement.CommandText = "SELECT COUNT(*) FROM history_retention";
                Check(Convert.ToInt32(statement.ExecuteScalar()) == 0, "empty orphan retention metadata is reclaimed after all its samples expire");
            }
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return count;
    }
}
