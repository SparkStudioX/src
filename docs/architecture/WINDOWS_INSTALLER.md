# SparkStudio Windows preview installation guide

Download the installer, checksum and optional workshops from the [v0.2.0-preview.6 release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.6). The Windows x64 package includes the gateway, .NET runtime, CPython, browser Designer/operator application and dependency notices. Running it requires no separate .NET SDK, Python or Node.js installation.

This is an **unsigned preview for local evaluation**. Previous-release current-user extraction and execution on loopback are verified; consult the preview.6 release notes for this package's verification results. Preview.6 service upgrade and network-listener acceptance remain pending. On one Windows host, an elevated preview.2 installer retry started the LocalService gateway after a failed preview.1 installation, and a later elevated preview.5 upgrade over the running preview.3 service completed successfully. Rollback, uninstall, complete real-data preservation, service-account secret encryption and broader ACL acceptance remain open. Docker and macOS are not part of this release.

Preview.6 retains the preview.5 wait for the actual owned gateway process to exit before copying application files and its process-access fix during elevated upgrade preparation. It retains preview.3's Windows administrator instructions for finding the setup code and compact Designer version label with the full build in its tooltip. It also retains preview.2's fix for a startup-check error in preview.1: the installer anonymously polled the protected `/api/health` endpoint and could report a 45-second timeout even when the gateway had started. The corrected check uses `/api/ready`, described below.

## Verify the download

The installer is `SparkStudio-Setup-0.2.0-preview.6-windows-x64-unsigned.exe`. Download its adjacent `.exe.sha256` from the same release and compare it with:

```powershell
Get-FileHash .\SparkStudio-Setup-0.2.0-preview.6-windows-x64-unsigned.exe -Algorithm SHA256
```

The published checksum identifies that executable; a rebuild can differ. Do not disable Windows security or organizational policy to run an unsigned package. Release notes record the tested source revision and package verification. The extracted `package-manifest.json` records bundled file hashes and build provenance.

## Extract and start without a service

Run the downloaded installer with:

```powershell
.\SparkStudio-Setup-0.2.0-preview.6-windows-x64-unsigned.exe /PORTABLE=1 /CURRENTUSER
```

Choose an empty writable directory. This mode extracts files without creating a service, installation registration, Start-menu shortcuts or an uninstaller. From that directory, start the gateway using an unused loopback port and a separate writable data directory:

```powershell
.\SparkStudio.Gateway.exe --urls http://127.0.0.1:5092 --DataDirectory ..\SparkStudioPreviewData
```

Open [http://127.0.0.1:5092](http://127.0.0.1:5092). Stop the foreground process with Ctrl+C. Preserve the data directory when replacing application files. Port 5092 avoids a development gateway that may already occupy 5090. Keep portable evaluation on loopback unless deliberately exercising the documented HTTPS setup. A reverse-proxy deployment and general production remote access are not established by these preview checks.

## Create the first administrator

A fresh data directory presents initial administrator setup. Read `security/setup-code.txt` inside your chosen data directory. For the example above, from the extracted application directory:

```powershell
Get-Content ..\SparkStudioPreviewData\security\setup-code.txt
```

Enter that code, a username and a password of 12–256 characters in the setup form. The code is removed after successful setup. There are no shipped default credentials. Keep codes and passwords private.

Accounts, grants and gateway resources are stored on disk; authentication requires no external database. Passwords are hashed. On Windows, protected secrets use account-specific encryption. Back up the complete data directory and encryption keys, and test restoration in the intended Windows account context.

Click your username to open **Account settings** for appearance and password changes. A successful password change signs out that account's sessions on all devices.

## Designer and operator applications

1. Sign in to Projects as the administrator. Create a project or import a `.sparkproj` workshop.
2. Open Designer, edit screens, inputs, templates and bindings, and save the draft.
3. Preview the draft. Preview starts in **Live read-only**; authored action scripts require explicitly enabling **Live actions** as an administrator.
4. Publish when ready. Operators use the published snapshot; later draft edits do not immediately change their application.
5. Open **Operator application** from Designer or the project's operator link. Its URL includes the project ID, such as `/runtime/<project-id>`. Share it only with users who can reach the configured gateway.

Engineering and operator sign-in have separate sessions. The operator application defaults to showing application screens without Designer or gateway navigation. Projects can opt into the surrounding runtime interface.

On Projects, **Settings** opens Gateway Settings. Designer has a **Gateway Settings** navigation entry. Security manages accounts and project grants: **View** opens operator screens, **Operate** allows operator actions, **Design** edits resources and **Publish** deploys drafts. Design alone does not grant operator access. Gateway administrators manage all projects. Audit and Diagnostics are also within Gateway Settings.

## Workshop examples

Download `SparkStudio-Workshops-0.2.0-preview.6.zip` and verify its adjacent `.sha256`. It contains portable `.sparkproj` workshops, walkthroughs and compatibility metadata. Import a file from `projects/` through **Import .sparkproj** on Projects. Each import creates a new unpublished draft; review and explicitly publish it before opening its operator application.

Portable workshops use synthetic data and need no OPC UA server, SQL Server or internet connection. Python exercises use the bundled interpreter. Follow each guide's action permissions and unavailable-data exercises. Additional authored source examples need gateway resources or user-supplied assets; the catalog identifies them separately and they are not portable imports. See the [workshop guide](https://github.com/SparkStudioX/src/blob/main/examples/README.md).

The installer and workshop collection contain no development projects, accounts, connection credentials or databases. A `.sparkproj` carries project resources; it is not a full gateway backup.

## Network listener choices

Preview.6 adds installer **Local only**, **Network access over HTTPS**, and managed-upgrade **Keep existing listener settings** choices. A fresh install defaults to local-only HTTP on `127.0.0.1:5090`. Managed upgrades preserve the existing listener by default. Network mode keeps that loopback management listener and adds HTTPS on `0.0.0.0` at a separate chosen port, normally 5443.

Supply the DNS hostname used by operators and matching PEM certificate chain plus an unencrypted PEM private key from your organization's CA or another trusted issuer. The hostname identifies the certificate and operator URL; `0.0.0.0` is only the bind address. Setup protects the copied private key but does not create DNS records, firewall rules or client trust. No internet or automatic certificate service is required. Browser computers must resolve the hostname and trust its certificate issuer.

First-admin bootstrap and installer readiness remain direct-loopback only. Finish initial setup locally before using network clients. The installer checks local process readiness and, for HTTPS, verifies the served certificate, selected hostname and protected endpoint response over its network port. This verifies startup behavior; it does not establish actual remote-client, certificate-renewal or production-network acceptance.

Read the release's [network access guide](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.6/NETWORK_ACCESS.md) before selecting network access. Automated listener, certificate and installer-helper fixtures are covered; an elevated preview.6 installation using a real CA chain and remote browser clients still needs acceptance testing. The verified preview.5 service-upgrade history below does not establish that new network path.

## Configuration backups and recovery

Gateway Settings → **Recovery** provides encrypted configuration backup downloads, a daily schedule and remote delivery to SMB, FTP or explicit FTPS. Prefer FTPS for FTP servers: ordinary FTP transmits its login and commands without TLS even though the archive payload itself is encrypted. Windows SMB can use the service identity or separately supplied network credentials; LocalService does not automatically have access to your file server.

The default retention is seven days, evaluated from generated UTC archive names. Remote pruning begins only after a complete upload, SHA-256 readback verification and final rename. It considers only this gateway's generated archive names; it leaves unrelated files, other gateway backups and partial uploads alone. If transfer fails, remote retention does not run. A successful transfer with incomplete retention is reported with a warning.

A running-gateway configuration backup contains saved projects, gateway configuration, accounts and protected keys. It excludes live databases, history and audit data. Use the separate offline full-backup procedure for a stopped gateway's complete data directory; external databases always require their own backups. Restores go to a new directory in recovery quarantine for review before activation. Windows account-specific protected secrets still require the original machine/account or explicit reentry.

Download the release's [scheduled backup guide](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.6/SCHEDULED_BACKUPS.md) and [gateway recovery guide](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.6/GATEWAY_RECOVERY.md). Loopback FTP protocol, corruption, cancellation, retention and untrusted-FTPS rejection fixtures are verified. Actual domain SMB access as LocalService or with supplied credentials and delivery to a trusted external FTPS server remain acceptance work. Native Windows UNC calls may outlast the caller's deadline; only one such worker can remain active, and it does not start retention after cancellation.

## Connections and deployment settings

OPC UA client, Microsoft SQL Server and SQLite connectors are available. Configure your own endpoints and credentials in the target deployment. SQL Server still requires live-server acceptance; SQLite tests do not establish SQL Server acceptance.

Designer → **Connections** provides connection enable/disable, dependencies and timestamped tests. Gateway Settings also shows a connection inventory. Designer read-query tests support typed parameters, cancellation and deadlines. Cancelling a read does not establish rollback of a database write; these controls never automatically retry writes.

Deployment settings can validate and save a listener for the next start. Saving does not restart or rebind the gateway. In a manual or container deployment, explicit `--urls` and other host overrides take precedence, including the portable example above. An installer-managed service instead rejects conflicting listener overrides so its saved local/network mode cannot silently change. Offline certificate/key references must be supplied in the deployment certificate directory. Read the [deployment guide](https://github.com/SparkStudioX/src/blob/main/docs/architecture/DEPLOYMENT_SETTINGS.md) first. Actual remote HTTPS deployments, trusted proxies and certificate renewal still require acceptance work.

## Optional Windows service installation — startup and upgrade verified on one host

Normal installation requests administrator elevation and is designed to register **SparkStudio Gateway** (service name `SparkStudio`) with automatic startup as `LocalService`. It defaults to loopback port 5090, configurable in the wizard, and creates no firewall rule.

On the tested Windows host, the user completed elevated installation of preview.2 after preview.1's failed startup check, retaining `%ProgramData%\SparkStudio`. Windows reported the service running with automatic startup as `LocalService`, using the installed executable and the retained data directory on loopback port 5090. The installed version was `0.2.0-preview.2` from source revision `05cc9bf`; `/api/ready` returned HTTP 200 with caching disabled, exactly the four documented fields, a matching service process ID and `pythonAvailable: true`. This verifies that retry and startup on this host; it does not establish broad service lifecycle, secret encryption or ACL acceptance.

Persistent service data belongs in `%ProgramData%\SparkStudio`. The installer configures a protected ACL for SYSTEM, Administrators and the service SID. For a fresh service installation, open PowerShell with **Run as administrator** on the gateway computer and read the setup code:

```powershell
Get-Content -LiteralPath "$env:ProgramData\SparkStudio\security\setup-code.txt"
```

The helper rejects conflicting/unowned services, occupied ports and machine-level runtime/data overrides. It does not stop an unrelated development gateway. Choose another port or deliberately stop that gateway first. Effective service-account access and ACL propagation still need acceptance testing.

The installer checks `GET /api/ready` from the local machine and verifies the gateway process ID and bundled Python startup result. This minimal endpoint returns only `product`, `status`, `pythonAvailable` and `processId`, with caching disabled; it accepts only direct loopback requests. `/api/health` and gateway diagnostics still require authentication. A successful readiness probe confirms startup, not elevated installation, service permissions or upgrade recovery.

Credentials encrypted for a development user cannot be assumed readable by LocalService. Configure and verify connections in the target deployment context; copying development data is not a verified service migration.

## Upgrade, recovery and removal

Stop the gateway and back up its complete data directory before upgrading. Back up external databases separately and retain the previous installer. For portable use, extract into a new empty application directory and point the replacement at existing data only after backup. For rollback, restore a compatible data backup with the previous application; do not assume older software can read newer data.

For service upgrades, use the same program directory. The helper attempts to preserve configuration and resume a previously running service if preparation fails, but provides no transactional rollback of replaced application files. A preview.5 upgrade is verified on one host as described below. Preview.6 elevated service upgrade, rollback and broader recovery acceptance remain pending.

Preview.3 could reach file copying after Windows reported the service stopped but before its process exited. This caused an `Access denied` error replacing `clrjit.dll` and could require **Retry** after the old process finished exiting; a smooth preview.3 upgrade was not verified. Preview.4 added a wait for actual process exit, but elevated upgrade preparation failed with Windows error 5 while acquiring the process handle, before any files were copied. That release was held.

Preview.5 retains the process-exit wait and, when direct access is denied, briefly enables the administrator token's existing `SeDebugPrivilege` to acquire a minimal process handle. It restores the original privilege state immediately afterward. An elevated read-only check against the installed LocalService gateway verified the fallback and exact privilege restoration without stopping the service or changing data. A stopped service status alone is insufficient to establish that its files are unlocked.

On September 29, 2026, a user-approved elevated preview.5 upgrade completed over the running preview.3 service on the same Windows host. The installer built from source revision `d3b931e` exited successfully with no errors in its setup log or Windows restart. The replacement service ran as `LocalService` with automatic startup, using the same program and data paths. All **486 installed payload file hashes** matched the package manifest; readiness matched the new service process with bundled Python available, and the expected browser bundle was served. No account reset was performed. A complete audit of real data-file preservation was not performed; rollback, uninstall and broader service-account/ACL acceptance remain open.

If preview.1 reported the 45-second startup timeout, retry with the current installer in the same program directory after backing up `%ProgramData%\SparkStudio`. The failed startup check retains that data, and retrying does not require deleting it. Use the installer to start the service; launching the executable directly from Program Files without an explicit writable `--DataDirectory` is a different startup path and can fail with access denied.

Service uninstall is designed to remove the owned service after confirmation and abort file removal if the helper fails. Persistent data is retained. Portable removal consists of stopping the process and removing only the extracted application directory; retain or deliberately remove the separate data directory. Actual service uninstall is unverified.

## Reset accounts with a reversible local backup

Use this only when deliberately resetting all accounts. It resets users, password hashes, project grants and saved security settings, including the public operator base URL and project tag-prefix restrictions. Projects, connections and the audit log remain in place. Existing sessions end when the gateway stops.

1. On the gateway computer, use an administrator account to stop the SparkStudio service and wait for its actual gateway process to exit. Verify the service's process ID and executable before stopping it; do not stop an unrelated gateway. For portable use, stop its foreground process instead.
2. In the configured data directory, rename `security/identities.json` to a unique backup name such as `identities.backup-20260929-153000.json`. Keep it inside the protected `security` directory and retain its access restrictions; it contains password hashes and grants. Do not delete it or edit its users list to `[]`: an existing empty identity store is invalid and prevents startup.
3. Restart the gateway. Without `identities.json`, it returns to initial setup and creates `security/setup-code.txt`. Read that code locally as described above, create the new administrator, and deliberately recreate accounts, grants and security settings.

To undo the reset, stop the service and wait for its gateway process to exit again. Preserve any newly created identity store under another unique protected backup name, restore the original backup as `identities.json`, and restart. This restores the old accounts, grants and saved security settings; it does not restore old sessions or roll back project changes.

## Offline use and scripting

Prepared packages include dependencies for the bundled application. Optional Python packages are not included automatically; a general offline wheelhouse and signed production distribution remain planned. Scripts run with the gateway process account's access; process separation is not a security sandbox. Review imported scripts before enabling actions or publishing.

Source builds acquire pinned dependencies and toolchains online when missing; they are not fresh-machine offline builds. From a clean checkout use `tools/publish-windows.ps1`, `tools/build-installer.ps1` and `tools/test-installer.ps1`. Versioned packages and installers go under ignored `artifacts/`. See the [source README](https://github.com/SparkStudioX/src/blob/main/README.md) and [verification roadmap](https://github.com/SparkStudioX/src/blob/main/docs/architecture/PARITY.md) for build instructions and remaining acceptance gates.
