# Scheduled configuration backups

Open **Gateway Settings → Backups** with an engineering account granted backup access. This single page contains **Schedules**, **Destinations**, and, for gateway administrators, **Restore**. Recovery is no longer a separate navigation entry; its existing bookmark opens Restore.

Destinations describe where archives go. Named schedules select a destination, weekdays, time, time zone and retention. The gateway supports up to **32 destinations and 64 schedules**, including several schedules using one target. New schedules start disabled, at **02:00 in the gateway time zone**, with **7 days** of retention. New targets default to a 300-second transfer deadline.

## What is captured

Online backups capture saved gateway configuration: project drafts and publications, script resources, assets, accounts and grants, connections, tags, keys, certificates, deployment settings and backup settings. Capture briefly holds configuration writes while the gateway remains running. The encrypted `.sparkbak` archive declares its scope and excluded paths.

This is a configuration snapshot. Managed databases, historian samples, audit history and runtime files are excluded. External SQL databases need their own database-aware backup. **Restore → Complete offline backup and restore guide** describes a stopped-gateway full-data backup. Windows service installation, operating-system trust, firewall rules and external infrastructure are not recreated from a data-directory archive.

Capture uses a private staging directory under `backup-work`. Plaintext configuration files exist there briefly before encryption and are removed during normal cleanup. Abrupt termination can leave a protected staging directory; inspect abandoned staging material while the gateway is stopped. The entire working folder is excluded from online and offline archives to prevent recursive inclusion.

## First backup

1. Set and confirm an **Archive passphrase** of 12–1024 characters, then save. Keep it separately from the archives. It is required for inspection and restoration and is never returned to the browser.
2. Select **Create download** to create a local encrypted configuration archive without transferring it to a remote target.
3. When complete, select **Download latest archive**. Downloads use the authenticated engineering session. The latest local archive is a convenience copy, not an archive history.
4. Inspect and restore it into a new isolated directory using the recovery tools. Confirm both the published project and any newer unpublished draft. Never restore over the active gateway data directory.

All runs use saved settings. Save or discard the shared draft before running a backup. Switching Schedules, Destinations and Restore preserves that draft. Polling updates run status without overwriting edits or replacement secrets. If another session changes the saved revision, your draft is retained and saving or starting a run is blocked. **Cancel changes** discards the draft and adopts the newest saved settings received by polling. A failed status load shows **Retry**. One worker starts capture and transfer jobs serially; settings cannot be changed during a run. Native UNC operations can outlive a timeout, as described below.

## Destinations

Add a named target in **Destinations**, select its type and fill in the fields shown for that type. A save validates settings; it does not prove connectivity. Save a disabled schedule that references the target and run it manually to verify delivery before enabling automatic runs. A referenced target cannot be removed until its schedules are reassigned or removed.

### Network share (SMB)

Use a UNC **Network share folder**, such as `\\backup-server\backups\sparkstudio`, rather than a mapped drive. Enter a username, password and optional domain for an explicit network account. Leave credentials unset to use the gateway service identity. That identity must be able to reach and write the share. For LocalService installations, use a dedicated remote backup account rather than assuming desktop credentials are available. File Explorer access under another account does not establish gateway access.

### FTP and FTPS

Enter **Host**, **Port**, **Folder**, **Username** and **Password**. The folder is beneath the account's login directory: `/sparkstudio/` selects its `sparkstudio` subfolder, not the server root. Folder segments support letters, digits, periods, underscores and hyphens; encoded or traversal paths are rejected. Explicit FTPS normally starts on port 21 and negotiates TLS. Its server certificate must be trusted by the gateway; certificate validation remains enabled.

Plain FTP requires an explicit acknowledgement because it sends destination credentials without transport encryption. Prefer FTPS where supported. Archive contents remain passphrase encrypted. The destination account needs upload, read/download, rename, list and delete permissions. Copies are read back for SHA-256 verification and promoted before managed retention runs.

### S3 bucket

Enter **Bucket**, **Region**, optional **Prefix**, **Access key ID** and a write-only **Secret access key**. Temporary credentials also need their **Session token**; update them before expiry. The normal endpoint is selected for the region. Use a dedicated bucket prefix for backup objects. Archives are encrypted before upload; a lost archive passphrase cannot be recovered from S3.

For S3-compatible storage, the advanced fields allow an **HTTPS endpoint** and **Path-style addressing**. The endpoint's TLS certificate must be trusted by the gateway. Production endpoints must use HTTPS; browser certificate acceptance does not configure gateway trust. Credentials belong to this target rather than to a browser or a different destination. The implementation uses the AWS SDK for request signing.

Grant the backup identity `s3:ListBucket` for the chosen bucket/prefix and `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` for that prefix. Versioned buckets also need `s3:GetObjectVersion` and `s3:DeleteObjectVersion` so verification and failed-run cleanup can address the exact created version. Temporary uploads and final archive objects both need access. Do not grant access to unrelated prefixes merely to enable retention. See the [S3 action reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) when constructing a policy.

S3 object writes are atomic; there is no filesystem rename. Delivery uploads a unique staging object, verifies its downloaded bytes, writes the final object [conditionally to prevent overwrite](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), verifies it and only then applies retention. Archives larger than 128 MiB use streamed multipart uploads; failed runs attempt to abort only their own upload ID. Listing and cleanup are bounded. Bucket versioning or Object Lock can retain earlier versions or prevent deletion; retention manages current objects, not historical versions or an Object Lock policy.

### Credentials and deadlines

Destination passwords, secret access keys, session tokens and the archive passphrase are protected on disk and omitted from settings responses. Each credential is retained unless deliberately replaced or cleared. Editing one destination must not change another destination's credentials. Stored credentials may retain their machine and service-account binding when restored; review and reenter them after a move.

Transfer deadlines range from 30 to 3600 seconds. Native UNC calls can outlast cancellation, so the gateway retains its SMB worker until Windows returns and does not start another SMB operation in parallel. FTP/FTPS or S3 jobs may proceed after that timeout while the canceled native UNC call finishes. Cancellation cannot forcibly interrupt Windows filesystem calls.

## Schedules and retention

In **Schedules**, add a named schedule, select a saved destination and choose the desired weekdays. Every day produces a daily schedule; one weekday produces a weekly schedule. Choose an `HH:mm` time and a Windows or IANA time-zone ID supported by the gateway. Retention is a whole number from 1 through 3650 days. The UI displays each schedule's next due time and its own last run.

Enabled schedules need a valid target and an archive passphrase. Due schedules execute serially, with independent last-attempt dates; one failed destination does not prevent the other schedules from being considered. A scheduled date is claimed before capture so a failure or restart does not cause uncontrolled retry of the same date. A manual run does not consume the schedule's next automatic run. Disabled schedules can be tested manually.

Each schedule owns its archive names independently. After a verified new copy, retention removes only expired archives for that schedule and target. A nightly seven-day schedule and a weekly thirty-day schedule may therefore share a folder or prefix without pruning each other's archives. Manual target-only deliveries have separate ownership. Failed transfers do not trigger cleanup. Check run results for the copy outcome, cleanup count and any retention warning. Foreign files, keys and malformed names remain outside managed cleanup.

Existing single-destination settings migrate into a named destination and schedule while retaining protected credentials, the archive passphrase and prior scheduling state. The migrated schedule retains ownership of its earlier archives. Keep a pre-upgrade backup; this migration does not establish downgrade compatibility.

## Restore

Open **Restore** for offline full-data backup commands and recovery review. Restoration uses a new isolated directory and the matching gateway build. Configuration archives exclude database and historical contents; restore or reconnect those from their separate backups as appropriate. Restore approval remains restricted to gateway administrators and still requires a restart.

Recovery mode blocks capture and remote transfers until the restored copy has been reviewed and restarted. Review destinations, account grants, published scripts and equipment access before resuming. Keep the original gateway and archive until the isolated restore is verified. The archive passphrase decrypts the archive but does not remove machine/account protection from credentials inside it.

## Workshop

`examples/scheduled-backups.json` is an independently authored read-only checkpoint project. It contains no credentials, connectors, tag writes or executable actions. This exercise is **setup-required** because destinations and schedules are gateway resources outside a `.sparkproj` package. Use the companion multi-schedule source build; the preview.10 installer contains the earlier single-target implementation.

Use a disposable gateway and dedicated writable test destinations. Keep production credentials and configuration out of source. The loader creates only a new checkpoint project and does not change gateway backup settings. Point `SPARKSTUDIO_ADMIN_AUTH_FILE` at a protected local-only credential file, then run:

```powershell
node tools/load-backup-example.mjs http://127.0.0.1:5091 --publish
```

1. Publish **SCHEDULE-LAB-A**, then save a newer unpublished **SCHEDULE-LAB-B** draft. Keep the published operator screen open.
2. In Backups, save an archive passphrase with all schedules disabled. Create a download and inspect its configuration scope.
3. Add two named targets in Destinations. Inspect how SMB, FTP/FTPS and S3 show different required properties. Use a dedicated S3 bucket/prefix for the optional cloud exercise.
4. Add **Nightly** and **Weekly** schedules with different destinations, weekdays and retention. Save and manually run each, verifying successful delivery before enabling automatic runs.
5. On a disposable gateway, test two schedules sharing a folder and verify the shorter retention leaves the other's archive names alone. Test an unavailable target and confirm its failure does not start retention or erase the other schedule's result.
6. Confirm each next due time and time zone. A near-future time can demonstrate execution on an isolated gateway; restore the intended nightly settings afterward.
7. Open Restore, restore to a fresh isolated directory and compare published A with draft B. Review exclusions, secret portability and quarantine before permitting external activity. Do not run the original and restored copies against the same equipment.

## Verification

`node apps/web/check-gateway-backups.mjs` exercises the frontend model and interactions. `node tools/test-backup-schedule.mjs` exercises persistence, migration, schedule dates and worker state. `node tools/test-backup-destinations.mjs` uses local files and owned loopback protocol fixtures for delivery and retention. Authenticated API and isolated browser checks cover saved settings and downloads separately. These checks do not establish real domain SMB, remote FTPS, AWS account-policy or all S3-compatible-server acceptance.
