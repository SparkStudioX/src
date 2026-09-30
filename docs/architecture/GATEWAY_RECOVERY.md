# Gateway backup and recovery

Gateway recovery supports **online configuration backups** and **offline full data backups**, separate from portable `.sparkproj` files and publication history. Both use passphrase-encrypted `.sparkbak` archives and restore into a new isolated directory. Use Gateway Settings → Recovery to create a configuration backup, manage its daily remote-copy schedule, inspect a restored gateway's isolation state, and approve resuming after review. The [scheduled configuration backup guide](SCHEDULED_BACKUPS.md) covers Backup now, authenticated downloads, SMB/FTP/FTPS destinations and retention.

## Coverage and limits

An **offline full data backup** includes ordinary files in the data directory: projects and publication history, scripts, assets, tag definitions, connections, accounts and grants, audit, managed SQLite databases and their WAL files, Data Protection keys, OPC certificates, deployment certificates and backup settings. Additional local files are listed explicitly in its encrypted manifest. The active lease and prior recovery quarantine marker are reserved; restore creates a fresh quarantine marker. The `backup-work/` directory is excluded from all backups so cached archives and temporary backup staging cannot recursively enter another archive.

An **online configuration backup** captures the saved project drafts and publications, script resources, uploaded assets, accounts and grants, tag definitions, connections, keyring, certificates, deployment settings and backup settings while the gateway stays running. It excludes managed database contents and WAL files, operational audit, backup run history, temporary files and unrecognized local files. Its encrypted manifest explicitly records excluded files or whole directory paths. Database data needs its own database-aware backup or an offline full data backup.

Configuration capture coordinates the gateway's synchronous stores with a shared lock and holds read handles while copying selected files. It has a 30-second capture budget, a 64 MiB limit per file and a 256 MiB total limit. Encryption and remote transfers happen after the configuration lock is released. The capture uses a private, quarantined staging directory beneath `backup-work/`, removed on normal success, failure or cancellation. Hard process termination can leave that private staging directory for administrator cleanup. Windows is the validated online capture platform; equivalent non-Windows acceptance remains pending. External programs must not edit configuration files during capture; a conflicting writer or changed inventory fails the attempt rather than committing a partial snapshot.

External SQL Server databases, external files accessed by scripts, the application binaries, Windows service registration, firewall rules, OS certificate trust and the operating system are outside this snapshot. Maintain separate backups for them. Browser-local preferences and unsaved form state are not gateway data.

For the **offline full backup command**, stop the service, gateway process, Python workers and all other writers first. This version holds an exclusive data-directory lease during operation; the offline command cannot acquire it while this version is running. Older gateways and third-party programs do not honor that lease. A lease does not prove that they have stopped. The online configuration action does not bypass that requirement for database files.

The v1 archive format is bounded to 10,000 files, 8 GiB total content, 2 GiB per file and an 8 MiB manifest; online capture has the smaller limits above. It rejects links, duplicate/colliding paths, traversal, unknown format versions, missing/truncated records and failed authentication or file digests. The offline backup command writes no plaintext staging archive. Restore creates private staging, verifies the entire snapshot and installs it with a same-filesystem directory rename into a **new, previously nonexistent** destination. A failed restore leaves the original data directory untouched. Keep the source directory until the restored gateway has been verified.

Archive format validation does not establish application-version compatibility. Use the same companion gateway build for backup and restoration. Gateway startup now records data format version 2 in `gateway-format.json` and supports the specific legacy version-1 tag migration below; that is not a general downgrade or arbitrary cross-version restore contract. Keep the original directory and matching binaries until verification succeeds.

At startup, while holding the data-directory lease, an unmarked directory is
treated as version 1. A legacy flat `tags.json` array becomes the version-2 tag
model. Before replacement, its original bytes and a SHA-256 receipt are saved
under `migration-backups/format-2/`. The transformation and version marker use
durable atomic file replacement and can resume after interruption between those
steps. Reopening version 2 does not repeat the transformation. A newer unknown
format is rejected before normal stores open, rather than being rewritten by an
older reader. Preserve a full pre-upgrade backup for rollback; do not lower the
version marker manually. Online configuration backups include the format marker
and alarm/history rule configuration, but not recorded process samples.

Daily scheduled configuration copies, manual configuration backups and managed remote retention are available now. Live database quiescence, automatic service switching, gateway replication/failover, and an atomic release combining project and script publication remain open G03 work.

## Commands

Use the matching gateway executable from the installation or build. Run as an account permitted to read all source files and protect the archive destination. A Windows administrator can read the stopped LocalService data directory, but that does not make its DPAPI secrets portable to an administrator-run gateway.

```text
SparkStudio.Gateway.exe --recovery backup --data-dir "DATA_DIRECTORY" --archive "BACKUP_PATH.sparkbak"
SparkStudio.Gateway.exe --recovery inspect --archive "BACKUP_PATH.sparkbak"
SparkStudio.Gateway.exe --recovery restore --archive "BACKUP_PATH.sparkbak" --data-dir "NEW_DIRECTORY"
```

Supply the archive passphrase on standard input, or name an existing environment variable with `--passphrase-env VARIABLE_NAME`. Do not pass the secret itself in arguments, commit it to a script, or store it beside the backup. A lost passphrase cannot be recovered by SparkStudio. Use a different strong passphrase for the archive than for a gateway login.

`--recovery backup` creates an offline full data archive. The online configuration actions are in Gateway Settings; their archives use the same `inspect` and `restore` commands. Inspect reports `scope` as `full` or `configuration` and the complete `excludedPaths` list. Original v1 archives without the optional scope field retain their full-data meaning. A restore receipt carries the scope, a bounded exclusion preview and the total excluded-path count; use inspection output when the Recovery page preview is truncated. A configuration restore does not recreate excluded databases or audit history.

Restore is a filesystem operation; it never starts a gateway or changes service registration. Its private destination grants access to the restoring account, administrators and SYSTEM on Windows. Before switching a LocalService installation to that location, an administrator must deliberately grant its service account access; restore does not grant that access automatically. Start the new copy explicitly with `--DataDirectory "NEW_DIRECTORY" --RecoveryPort 5091` for a local test alongside another gateway. In recovery mode, saved network listeners and external URL/Kestrel overrides are replaced by the selected localhost listener. Use the recovered engineering administrator account to sign in.

## Identity and isolation

Restored account password hashes and project grants are retained. Authentication sessions are memory-only, so users sign in again. Windows Data Protection keys retain their original **machine and Windows account** binding. Copying those files does not make protected connection passwords usable on another machine or under another account. Review and reenter connection credentials after migration. The archive passphrase protects the backup; it does not reencrypt DPAPI keys for a new identity.

The presence of `recovery-quarantine.json` forces recovery mode for the entire process. An invalid marker also stays isolated and cannot be approved through the UI. Eager gateway event schedulers do not start; Python execution and every connector operation, including managed SQLite, are blocked. Backup execution and remote transfers are also blocked, even when an enabled schedule was restored. Operator APIs return an explicit recovery response. Administrators can inspect and edit saved project and gateway configuration.

After reviewing connection destinations, published scripts, accounts, credentials, certificates and saved deployment settings, enter `RESUME RESTORED GATEWAY` and approve. Approval requires an engineering administrator, CSRF protection and the current receipt revision; it is audited. The receipt is retained as `recovery-reviewed-*.json`. **Approval does not activate work in the current process.** Restart deliberately to resume. Prevent the old and restored gateways from both controlling the same equipment.

## Workshop

`examples/gateway-recovery.json` is an independently authored synthetic lab. It requires a disposable gateway and the CLI; it contains no credentials or backup data. Its operator screen performs no gateway writes.

1. Load the lab into a disposable gateway and publish checkpoint `RECOVERY-LAB-A`. Change the draft label to `RECOVERY-LAB-B` and save without publishing. Add only synthetic memory tags, an optional managed SQLite database and disposable accounts.
2. Record the gateway build, account grants, project draft/publication and a known database row. Stop the gateway and workers. Record backup start/end time and create an encrypted archive outside its data directory.
3. Inspect the archive. Wrong passphrases and a deliberately truncated **copy** must fail without creating a usable restored destination.
4. Restore the original archive to a new local directory. Record restore elapsed time. Start it on a separate recovery port and verify it listens only on localhost. Sign in with a restored account. Connections, Python and operator applications must remain blocked.
5. Compare the restored Designer draft and saved publication, tags and grants. Review only synthetic destinations/jobs. Approve and restart this isolated copy; record time until ready. The operator screen shows checkpoint A while Designer still shows draft B. Verify the known local database row after restart.
6. Preserve the original directory throughout the exercise. A second restore into the existing destination must fail. Report recovery time as measured for this fixture, not as a production guarantee; the data-loss boundary is the offline snapshot time.
