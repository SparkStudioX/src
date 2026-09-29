# Staged listener settings workshop

The Gateway Settings → Deployment page separates the running server observations from a saved listener intent. An engineering gateway administrator can validate, save, disable and restore a previous listener intent. Saving never restarts the gateway or changes an existing listener.

This increment supports one loopback IP listener: HTTP or HTTPS at `127.0.0.1` or `[::1]`, on a port from 1024 to 65535. HTTPS uses an offline PEM certificate and matching unencrypted PEM private key. Remote bindings, certificate uploads/passwords, certificate renewal automation, proxy trust, Windows service acceptance and container lifecycle acceptance remain outside this increment. Explicit host configuration remains the route for those deployments.

## Storage and precedence

- `<data-directory>/deployment.json` contains format version 1, a revision token and listener settings. Only certificate/key filenames are stored. The file is local gateway configuration and does not belong in a project package or source repository.
- `<data-directory>/deployment.json.previous` retains the preceding usable intent. Writes use a same-directory temporary file followed by atomic replacement. Invalid, unreadable or oversized current documents cannot overwrite a usable recovery document. The first save retains the original disabled intent.
- Certificate references resolve to ordinary files directly under `<data-directory>/certificates/deployment/`. Relative traversal, nested paths, reparse points and files larger than 64 KiB are rejected. Protect the private key and data directory using the gateway operating-system account's permissions.
- Explicit Kestrel endpoints, command-line/environment/host URL overrides, and `SPARKSTUDIO_DEPLOYMENT_DISABLE=1` prevent activation of saved settings. The UI shows the override; removing it requires changing the external launch configuration. A saved value never silently displaces `--urls`.
- The standard `appsettings.json` URL is the fallback when managed settings are disabled, invalid, or cannot load their certificate at startup. The data directory itself and public operator URL are unchanged by listener settings.
- Startup intent is captured once. A saved change reports **Restart required**, while **Loaded at startup** and **Actual listening addresses** continue to describe the running instance. **External override** takes precedence in the displayed state when the launcher controls the listener.

Validation checks syntax, loopback scope, PEM key/certificate correspondence, certificate dates, server-authentication usage and the listener IP subject alternative name. It does not reserve the port, verify browser trust, prove reachability or guarantee the next process can bind. An occupied port can still prevent startup. Use the recovery override below if that happens. Windows TLS loading uses a temporary operating-system key container; it is disposed with the gateway, with no permanent certificate-store import.

## Prerequisites and compatibility

Use the companion build with the **Listener settings** editor and `/api/gateway/deployment/settings` endpoints. The earlier read-only Deployment tab and the original preview installer do not provide this feature. This is a setup-required workshop; a `.sparkproj` alone cannot configure a listener or distribute private keys.

For observation and draft validation, an existing engineering administrator account is enough. To exercise save/restart/TLS, use a disposable gateway package and fresh data directory on unused local ports, separately from your working gateway. Prepare a recovery `appsettings.json` URL in that isolated package, such as `http://127.0.0.1:5092`, before starting. Keep the filename `appsettings.json`; this is the package's fallback address. Do not use production accounts, projects, database files or equipment connections in this exercise.

For TLS, install a short-lived test certificate containing IP address `127.0.0.1` in its subject alternative names, and its matching unencrypted PEM private key. Put them in the isolated data directory's `certificates/deployment/` folder. The gateway account needs read access. Private key material stays outside the browser and source checkout. Do not weaken your browser's certificate validation globally; use an appropriate locally trusted test certificate or a client that pins only this fixture's certificate.

## Walkthrough

1. Open Gateway Settings → Deployment. Compare **Actual listening addresses**, **Startup configuration**, and **Listener settings**. An instance launched with `--urls` should show **External override**. This is expected even if you save another listener intent.
2. Change the draft URL to `http://0.0.0.0:5093` and select **Validate draft**. Validation rejects the non-loopback address. The running server and saved settings remain unchanged.
3. In the isolated gateway, enable **Use the saved listener at startup**, enter `http://127.0.0.1:5093`, and validate. Save is enabled after successful validation and an actual draft change. Select **Save for next start**. The browser remains connected to the old address. Reload saved settings to inspect the stored intent and revision.
4. Stop the isolated gateway deliberately. Start it with the same data directory and package/content root, without `--urls` or a URL environment override. Open the new address. **Actual listening addresses** should show port 5093, and managed listener state should say **Applied at startup**. This is the acceptance check; a successful save by itself is not.
5. Optionally switch the isolated intent to `https://127.0.0.1:5443` using the two offline PEM filenames. Validation reports certificate expiry. Save, stop, and start again, then verify a TLS request using the intended certificate. The deployment observation reports HTTPS; the browser's own certificate trust is a separate requirement.
6. Open the same editor in two administrative tabs. Save a changed intent in the first. Try to save the stale draft in the second. The gateway rejects it; **Reload saved settings** deliberately discards the stale draft. It never silently merges or overwrites the newer settings.
7. Expand **Restart and recovery**. **Restore previous intent** stages the preceding usable settings with a fresh revision. **Disable managed listener** stages a return to normal host configuration. Neither button restarts the process. Stop/start explicitly and check the actual listening address again.
8. On the disposable instance only, stop it and make its saved deployment JSON malformed, or remove the referenced test key file. On restart the normal package fallback listener remains available, and Deployment explains the recovery condition. Replace the settings or restore a valid previous intent. A broken current file does not replace the previous usable recovery file.

## Recovery when no listener starts

Stop the failed process or service, preserve the same data directory, and start with an explicit unused loopback URL, for example `--urls http://127.0.0.1:5092`. Alternatively set `SPARKSTUDIO_DEPLOYMENT_DISABLE=1` before launch to bypass saved settings and use the normal host configuration. The recovery address must itself be free.

Return to the Deployment editor, inspect the saved state, and disable or repair it. Remove the external recovery override only after checking the staged settings. Offline changes to `deployment.json` while a process is running cause subsequent UI saves to fail; restart to load those changes. No recovery action deletes gateway projects, accounts or connections.

## API contract and verification

All routes require the engineering administrator audience. Mutations and draft validation require the normal session CSRF token and same-origin policy. Saves/restores enter the administrative audit trail without recording request bodies or key contents.

| Route | Behavior |
| --- | --- |
| `GET /api/gateway/deployment/settings` | Saved and startup intent, revision, overrides, recovery, previous availability; `no-store`. |
| `POST /api/gateway/deployment/settings/validate` | Validates an intent without writing it or changing listeners. |
| `PUT /api/gateway/deployment/settings` | `{ revision, settings }`; rejects stale revision, validates again, saves atomically. |
| `POST /api/gateway/deployment/settings/restore` | `{ revision }`; validates the previous intent and stages it under a fresh revision. |

`node tools/test-deployment-settings.mjs --model` uses only generated fixtures under ignored `.data/test-evidence/`. It covers malformed and externally changed files, invalid binds, override precedence, previous-intent restoration, failure preservation, offline PEM validation, an actual pinned-certificate loopback TLS handshake, unchanged active listeners after saving, and HTTP fallback after a missing key. On Windows the failure-preservation case locks the invalid current file to force an atomic-replacement failure and checks that the previous valid file survives.

The default `node tools/test-deployment-settings.mjs` uses disposable accounts only on port 5091. It covers engineering/admin/audience checks, CSRF and origin rejection, validation without mutation, revision conflicts, restore, and preservation of the active listener. It restores the starting saved intent afterward. It is intentionally unsuitable for a working gateway's accounts or deployment file.
