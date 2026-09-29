# Windows preview installer

Download the unsigned x64 installer and checksum from the [v0.1.0-preview.1 release](https://github.com/SparkStudioX/releases/releases/tag/v0.1.0-preview.1). The installer bundles the gateway, .NET runtime, CPython runtime, browser application and dependency notices. A separate .NET SDK, Python installation or Node installation is not required to run that package.

The application is an early preview for trusted local development. The gateway is unauthenticated and must remain on loopback. The installer is unsigned. Its extraction mode and extracted application have been tested; actual elevated Windows service installation, service-account execution, upgrade and uninstall have **not** been verified.

## Package identity

| Release artifact | Value |
| --- | --- |
| Filename | `SparkStudio-Setup-0.1.0-windows-x64-unsigned.exe` |
| Size | 98,714,955 bytes |
| SHA-256 | `80457ae0a8546448e64e905ea2b9d48d1c5b9277c52f0607f0573bd775703807` |

These values identify the published preview release, not every future local rebuild. Verify the downloaded executable with `Get-FileHash -Algorithm SHA256` and the release checksum before running it.

## Current-user extraction

To extract the application without creating a Windows service, installation registration, Start-menu shortcuts or an uninstaller, run the downloaded executable with:

```powershell
.\SparkStudio-Setup-0.1.0-windows-x64-unsigned.exe /PORTABLE=1 /CURRENTUSER
```

Choose an empty writable destination. This mode provides files rather than a registered installation. From the extracted directory, start the gateway in the foreground using an unused loopback port and a separate writable data directory:

```powershell
.\SparkStudio.Gateway.exe --urls http://127.0.0.1:5092 --DataDirectory ..\SparkStudioPreviewData
```

Open that local address in a browser and stop the foreground process with Ctrl+C. Keep the data directory when replacing application files. Python scripts run with the current user's access; process isolation is not a security sandbox.

## Service-installation design

Normal installation requires administrator elevation and is designed to create the `SparkStudio` service, displayed as **SparkStudio Gateway**, with automatic startup under `LocalService`. The default port is 5090 and can be selected in the installer. The service binds to loopback; the installer does not create a firewall rule.

Program files and persistent application data are separate. The intended data location is `%ProgramData%\SparkStudio`. The lifecycle helper configures a protected data-directory ACL granting full access to SYSTEM and Administrators, and Modify access to the SparkStudio service SID. Effective service-account access and ACL propagation still require elevated installation testing.

The helper rejects a conflicting or unowned existing service rather than adopting it. It validates installation paths, service configuration and ports, and only stops a service it recognizes as owned by this installer. An occupied port fails validation without stopping an unrelated process. Machine-level runtime/data overrides are rejected by the installer path. Manually registered services need a separate migration plan.

Credentials encrypted for a development user's account cannot be assumed readable by a service account. Configure and verify connector credentials in the target deployment context; do not copy live development data into a service installation and assume it is ready.

## Upgrade and removal

Back up the complete data directory and retain the previous installer before upgrading. Use the same program directory for an upgrade. The helper attempts to preserve service configuration and resume a previously running service if preparation fails, but the installer does **not** provide transactional rollback of replaced application files. Recovery can require reinstalling the prior package and restoring a compatible data backup.

Uninstall is designed to remove the owned service only after confirmation and to abort file removal if the service helper fails. Application data is retained for deliberate backup or later removal. This behavior is implemented but the actual elevated service lifecycle remains unverified.

## Building and offline scope

From the source repository root:

```powershell
.\tools\publish-windows.ps1
.\tools\build-installer.ps1
```

Build output is written under `artifacts/windows-x64` and `artifacts/installer`. The build acquires pinned toolchains and dependencies when missing, including the installer compiler; it is not a fresh-machine offline build. Prepared packages include the runtime dependencies needed for the current application. Optional Python package distribution, a general offline wheelhouse and signed production releases remain future work.

The recorded installer checks verified 556 extracted file hashes, 20 lifecycle-helper guard cases, and execution of the extracted self-contained application with system .NET locations deliberately unavailable. The extracted gateway passed 19 gateway checks and 12 asset/popup checks. Extraction created no service, installation registration, shortcuts or uninstaller. These results do not establish successful SCM installation, LocalService execution, upgrade recovery or uninstall. See [PARITY.md](PARITY.md) for the wider verification ledger.
