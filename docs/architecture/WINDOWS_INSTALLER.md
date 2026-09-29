# SparkStudio Windows preview installation guide

Download the installer, checksum and optional workshops from the [v0.2.0-preview.2 release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.2). The Windows x64 package includes the gateway, .NET runtime, CPython, browser Designer/operator application and dependency notices. Running it requires no separate .NET SDK, Python or Node.js installation.

This is an **unsigned preview for local evaluation**. Current-user extraction and execution on loopback are verified. An elevated preview.2 installer retry after a failed preview.1 installation also started the LocalService gateway successfully on one Windows host with retained ProgramData. Broader installation, upgrade recovery, uninstall, service-account secret encryption and ACL acceptance remain open. Docker and macOS are not part of this release.

Preview.2 fixes a startup-check error in preview.1: the installer anonymously polled the protected `/api/health` endpoint and could report a 45-second timeout even when the gateway had started. The corrected check uses `/api/ready`, described below.

## Verify the download

The installer is `SparkStudio-Setup-0.2.0-preview.2-windows-x64-unsigned.exe`. Download its adjacent `.exe.sha256` from the same release and compare it with:

```powershell
Get-FileHash .\SparkStudio-Setup-0.2.0-preview.2-windows-x64-unsigned.exe -Algorithm SHA256
```

The published checksum identifies that executable; a rebuild can differ. Do not disable Windows security or organizational policy to run an unsigned package. Release notes record the tested source revision and package verification. The extracted `package-manifest.json` records bundled file hashes and build provenance.

## Extract and start without a service

Run the downloaded installer with:

```powershell
.\SparkStudio-Setup-0.2.0-preview.2-windows-x64-unsigned.exe /PORTABLE=1 /CURRENTUSER
```

Choose an empty writable directory. This mode extracts files without creating a service, installation registration, Start-menu shortcuts or an uninstaller. From that directory, start the gateway using an unused loopback port and a separate writable data directory:

```powershell
.\SparkStudio.Gateway.exe --urls http://127.0.0.1:5092 --DataDirectory ..\SparkStudioPreviewData
```

Open [http://127.0.0.1:5092](http://127.0.0.1:5092). Stop the foreground process with Ctrl+C. Preserve the data directory when replacing application files. Port 5092 avoids a development gateway that may already occupy 5090. Do not expose this preview through a public interface or reverse proxy; remote transport acceptance remains open.

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

Download `SparkStudio-Workshops-0.2.0-preview.2.zip` and verify its adjacent `.sha256`. It contains **24 portable `.sparkproj` workshops**, walkthroughs and compatibility metadata. Import a file from `projects/` through **Import .sparkproj** on Projects. Each import creates a new unpublished draft; review and explicitly publish it before opening its operator application.

Portable workshops use synthetic data and need no OPC UA server, SQL Server or internet connection. Python exercises use the bundled interpreter. Follow each guide's action permissions and unavailable-data exercises. Eight additional authored source examples need gateway resources or user-supplied assets; the catalog identifies them separately and they are not portable imports. See the [workshop guide](https://github.com/SparkStudioX/src/blob/main/examples/README.md).

The installer and workshop collection contain no development projects, accounts, connection credentials or databases. A `.sparkproj` carries project resources; it is not a full gateway backup.

## Connections and deployment settings

OPC UA client, Microsoft SQL Server and SQLite connectors are available. Configure your own endpoints and credentials in the target deployment. SQL Server still requires live-server acceptance; SQLite tests do not establish SQL Server acceptance.

Designer → **Connections** provides connection enable/disable, dependencies and timestamped tests. Gateway Settings also shows a connection inventory. Designer read-query tests support typed parameters, cancellation and deadlines. Cancelling a read does not establish rollback of a database write; these controls never automatically retry writes.

Deployment settings can validate and save a loopback HTTP/HTTPS listener for the next start. Saving does not restart or rebind the gateway. Explicit `--urls` and other host overrides take precedence, including the example command above. Offline certificate/key references must be supplied in the deployment certificate directory. Read the [deployment guide](https://github.com/SparkStudioX/src/blob/main/docs/architecture/DEPLOYMENT_SETTINGS.md) first. Remote HTTPS, trusted proxies and certificate renewal remain future acceptance work.

## Optional Windows service installation — startup verified on one host

Normal installation requests administrator elevation and is designed to register **SparkStudio Gateway** (service name `SparkStudio`) with automatic startup as `LocalService`. It defaults to loopback port 5090, configurable in the wizard, and creates no firewall rule.

On the tested Windows host, the user completed elevated installation of preview.2 after preview.1's failed startup check, retaining `%ProgramData%\SparkStudio`. Windows reported the service running with automatic startup as `LocalService`, using the installed executable and the retained data directory on loopback port 5090. The installed version was `0.2.0-preview.2` from source revision `05cc9bf`; `/api/ready` returned HTTP 200 with caching disabled, exactly the four documented fields, a matching service process ID and `pythonAvailable: true`. This verifies that retry and startup on this host; it does not establish broad service lifecycle, secret encryption or ACL acceptance.

Persistent service data belongs in `%ProgramData%\SparkStudio`. The installer configures a protected ACL for SYSTEM, Administrators and the service SID. For a fresh service installation, read the setup code from an elevated PowerShell terminal:

```powershell
Get-Content "$env:ProgramData\SparkStudio\security\setup-code.txt"
```

The helper rejects conflicting/unowned services, occupied ports and machine-level runtime/data overrides. It does not stop an unrelated development gateway. Choose another port or deliberately stop that gateway first. Effective service-account access and ACL propagation still need acceptance testing.

The installer checks `GET /api/ready` from the local machine and verifies the gateway process ID and bundled Python startup result. This minimal endpoint returns only `product`, `status`, `pythonAvailable` and `processId`, with caching disabled; it accepts only direct loopback requests. `/api/health` and gateway diagnostics still require authentication. A successful readiness probe confirms startup, not elevated installation, service permissions or upgrade recovery.

Credentials encrypted for a development user cannot be assumed readable by LocalService. Configure and verify connections in the target deployment context; copying development data is not a verified service migration.

## Upgrade, recovery and removal

Stop the gateway and back up its complete data directory before upgrading. Back up external databases separately and retain the previous installer. For portable use, extract into a new empty application directory and point the replacement at existing data only after backup. For rollback, restore a compatible data backup with the previous application; do not assume older software can read newer data.

For service upgrades, use the same program directory. The helper attempts to preserve configuration and resume a previously running service if preparation fails, but provides no transactional rollback of replaced application files. Actual upgrade/recovery acceptance is pending.

If preview.1 reported the 45-second startup timeout, retry with the preview.2 installer in the same program directory after backing up `%ProgramData%\SparkStudio`. The failed startup check retains that data, and retrying does not require deleting it. Use the installer to start the service; launching the executable directly from Program Files without an explicit writable `--DataDirectory` is a different startup path and can fail with access denied.

Service uninstall is designed to remove the owned service after confirmation and abort file removal if the helper fails. Persistent data is retained. Portable removal consists of stopping the process and removing only the extracted application directory; retain or deliberately remove the separate data directory. Actual service uninstall is unverified.

## Offline use and scripting

Prepared packages include dependencies for the bundled application. Optional Python packages are not included automatically; a general offline wheelhouse and signed production distribution remain planned. Scripts run with the gateway process account's access; process separation is not a security sandbox. Review imported scripts before enabling actions or publishing.

Source builds acquire pinned dependencies and toolchains online when missing; they are not fresh-machine offline builds. From a clean checkout use `tools/publish-windows.ps1`, `tools/build-installer.ps1` and `tools/test-installer.ps1`. Versioned packages and installers go under ignored `artifacts/`. See the [source README](https://github.com/SparkStudioX/src/blob/main/README.md) and [verification roadmap](https://github.com/SparkStudioX/src/blob/main/docs/architecture/PARITY.md) for build instructions and remaining acceptance gates.
