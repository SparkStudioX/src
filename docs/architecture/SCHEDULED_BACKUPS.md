# Scheduled configuration backups

Open **Gateway Settings → Recovery → Configuration backups** as an engineering gateway administrator. Create an encrypted archive for download, copy it to a remote destination immediately, or enable a daily remote copy. Scheduling starts disabled. The initial settings are **02:00 in the gateway's local time zone**, retaining this gateway's remote archives for **7 days**.

## What is captured

Online backups capture the gateway's configuration: project drafts and publications, script resources, assets, accounts and grants, connections, tags, the keyring, certificates, deployment settings and backup settings. Capture briefly holds configuration writes while the gateway remains running. The resulting archive declares its scope and excluded paths.

This is a configuration snapshot, not a live database snapshot. Managed database contents, audit history and runtime files are excluded. External SQL databases also need their own database-aware backup. For the full gateway data directory, including stopped local databases and audit files, use the **Complete offline backup and restore guide** on the same page. Windows service installation, operating-system trust, firewall rules and external infrastructure are not recreated from a gateway data-directory archive.

Capture uses a private staging directory under the gateway's `backup-work` folder. Plaintext configuration files exist there briefly before encryption and are removed during normal cleanup. An abrupt process termination can leave a protected staging directory behind; a gateway administrator should inspect and remove abandoned staging material while the gateway is stopped. The entire `backup-work` folder is excluded from both online configuration archives and offline full-data archives, preventing recursive inclusion of previous working copies.

## First backup

1. Select **Set archive passphrase** and enter matching values of 12–1024 characters. Save backup settings. Keep that passphrase separately from the archive; it is required to inspect and restore it. The stored value is never returned to the browser.
2. Select **Create download**. This creates an encrypted configuration archive on the gateway without sending it to a remote destination. The result panel reports running, success or failure.
3. When complete, select **Download latest archive**. Downloads use the authenticated engineering session. The latest local archive is a convenience copy, not a history of remote backups.
4. Inspect and restore the archive into a new isolated directory using the recovery tools. Verify both the published project and any newer unpublished draft. Never test a restore over the active gateway data directory.

Backup actions use saved settings. Save or discard a draft before starting a backup. A second administrator's changes invalidate the loaded settings revision; reload before saving. Status polling preserves your form edits and replacement secrets instead of overwriting them. While a backup is running, the UI prevents duplicate starts and configuration edits. The server also enforces operation and revision boundaries.

## Remote destinations

Choose **Network share (SMB)**, **FTP**, or **FTPS (explicit TLS)**. Use a dedicated folder to make ownership and retention easy to inspect.

For SMB, enter a UNC folder such as `\\backup-server\backups\sparkstudio`, not a drive mapping from an interactive desktop session. Supply the destination username, password and optional domain if explicit credentials are needed; otherwise leave username and password unset to use the gateway service identity. That identity must be able to reach and write the share. For an installation running as LocalService, configure a dedicated remote backup account rather than assuming the desktop sign-in credentials are available. A successful test in File Explorer under a different Windows account does not establish that the gateway service has access.

For FTP/FTPS, enter the hostname, port and folder beneath the FTP account's login directory in separate fields. The leading `/` formats the URL and does not select the server root: `/sparkstudio/` means the `sparkstudio` subfolder under that account's login directory. Folder segments support ASCII letters, digits, periods, underscores and hyphens; spaces, percent encoding and dot/parent segments are rejected. A custom port is supported. Explicit FTPS normally starts on port 21 and negotiates TLS; it does not use an `ftps://` URL in saved settings. FTPS server certificate validation remains enabled, so configure trust for the gateway account/host. Plain FTP is disabled unless the administrator explicitly confirms its unencrypted transport in the destination editor (`allowInsecureFtp: true`). Existing FTP settings require that acknowledgement before their next save or run; prefer FTPS when available. Plain FTP sends destination credentials without transport encryption; archive contents remain encrypted with the archive passphrase. A username is required; use `anonymous` explicitly only if that destination permits anonymous access. The destination account needs upload, read/download, rename, directory listing and deletion permissions. Copies are read back for SHA-256 verification and atomically renamed into place before managed retention runs.

The transfer timeout is configurable from 30 to 3600 seconds, with an initial value of 300 seconds. Configuration accepts only bounded addresses and supported destination modes. A save validates configuration; it does not prove remote connectivity. Select **Back up to destination** to perform the actual backup and copy, then inspect its recorded result before enabling a schedule.

Destination passwords are retained unless explicitly replaced or cleared. Changing the destination does not implicitly erase its saved password; the form says when a stored password will be reused. Clearing the destination password is separate from leaving its replacement field empty. The archive passphrase can be replaced for future archives, but old archives still require the passphrase used when they were created.

## Daily schedule and retention

Enable **Daily backups to the saved destination**, choose an `HH:mm` daily time, and select a time zone using a Windows or IANA ID supported by the gateway. The default is the gateway's local time zone. A destination and stored archive passphrase are required before scheduling can run. Review **Next scheduled run** after saving. Absolute timestamps include this browser's displayed time-zone abbreviation; the daily schedule is evaluated in its explicitly selected gateway-supported time zone.

Retention is a whole number of days from 1 through 3650. After a new destination copy has been verified, cleanup removes only archives owned by this gateway that are older than the saved retention period. It does not claim or delete unrelated files in the destination. Failed new copies do not trigger retention. Check the last-run result for the copy outcome and the number of expired archives removed. Keep a separate retention policy for database backups and any additional archive copies managed outside SparkStudio.

These controls are available to engineering gateway administrators, not operator sessions or ordinary designers. Settings changes and backup actions use the authenticated gateway API. Recovery mode blocks backup execution and remote transfers until the restore is reviewed and the gateway restarted.

## Restore and portability

A configuration archive restores into a new directory with recovery isolation, just like an offline archive. The recovery page labels **Configuration backup** versus **Full data backup**, displays the declared scope, and provides an expandable list of excluded paths. That list is bounded; when truncated it shows the number displayed and the full exclusion count. Inspect that scope before expecting database or historical data to exist in the restored copy. Restore or reconnect databases from their separate backups as appropriate.

Review destinations, account grants, published scripts and equipment access before resuming. Protected secrets may retain their original operating-system account and machine binding; reenter credentials when moving to another identity or machine. An archive passphrase decrypts the archive itself, but does not remove the platform protection from connection or backup credentials inside it. Keep the original gateway data and backup until the isolated restore is verified.

## Workshop

`examples/scheduled-backups.json` is an independently authored, read-only project that displays a **SCHEDULE-LAB-A** checkpoint and an exercise checklist. Its screen contains no credentials, connectors, tag writes or executable actions. The backup exercise is **setup-required** because scheduling and destination credentials are gateway resources outside a `.sparkproj` package.

Use a disposable gateway with the companion backup-scheduling build and an engineering administrator. A remote-copy exercise needs a writable test SMB share or FTP/FTPS folder; keep real production destinations and credentials out of the source fixture.

From the repository root, point `SPARKSTUDIO_ADMIN_AUTH_FILE` at a protected, local-only JSON file containing `username` and `password`, or an existing test fixture's `admin` entry. The loader defaults to a disposable gateway on port 5091 and creates only a new workshop project. It refuses to overwrite an existing workshop and does not change gateway backup settings, destinations or other projects. Keep the credential file outside tracked source and remove the environment variable when finished.

```powershell
$env:SPARKSTUDIO_ADMIN_AUTH_FILE = 'C:\private\sparkstudio-test-admin.json'
node tools/load-backup-example.mjs http://127.0.0.1:5091 --publish
Remove-Item Env:SPARKSTUDIO_ADMIN_AUTH_FILE
```

Omit `--publish` to create only the draft and publish it later from Designer. Once loaded, export the project as a `.sparkproj` package through project management for distribution; the package carries the checkpoint screen but not gateway credentials, backup configuration or remote destination setup.

1. Load the workshop and publish its checkpoint screen using the command above or Designer. Keep the published operator application open.
2. Change the checkpoint label in Designer to **SCHEDULE-LAB-B**, then save without publishing. The operator screen should still show **SCHEDULE-LAB-A**.
3. In Gateway Settings → Recovery, set an archive passphrase and save with the schedule disabled. Create and download a local configuration archive.
4. Configure a dedicated test destination, save and use **Back up to destination**. Verify the successful result and remote file before enabling the schedule. Confirm an unreachable test destination produces a failure without removing prior valid archives.
5. Enable a daily run and confirm the next due time, selected time zone and seven-day retention. On an isolated test gateway you may choose a near-future daily time to observe a scheduled run, then restore the intended nightly setting.
6. Inspect and restore a produced archive into a fresh isolated directory. Confirm its configuration scope and exclusions, the published **A** checkpoint and newer **B** draft. Database contents and audit history should be restored from separate backups or an offline full-data archive, not expected in this configuration snapshot.
7. Review recovery state, protected-secret portability and external destinations before allowing the restored copy to resume. Do not run the original and restored gateways against the same equipment concurrently.

## Frontend verification

From `apps/web`, run `node check-gateway-backups.mjs`. The focused checks cover omission of retained secrets, deliberate replacement and clearing, FTP/FTPS address composition, schedule/retention/timeout bounds, disabled defaults, retained edits during polling, cross-session revision conflicts, duplicate submission prevention, authenticated downloads and recovery blocking. They also exercise React Strict Mode's repeated mount effects so initial loading cannot remain locked. Backend snapshot, copy, scheduling, authorization and retention checks are separate and must pass before release.
