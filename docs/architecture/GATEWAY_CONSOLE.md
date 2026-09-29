# Gateway console workshop

The Deployment tab also provides [staged listener configuration and recovery](DEPLOYMENT_SETTINGS.md). Its optional save/restart exercise requires a disposable gateway; the portable Gateway operations walkthrough uses validation and discards its draft. [Connection operations](CONNECTION_OPERATIONS.md) and [read query testing](QUERY_TESTING.md) have separate setup exercises and acceptance limits.

Open **Gateway Settings** in the Designer sidebar or **Settings** in the Projects header as a gateway administrator. The console has bookmarked Overview, Sessions, Diagnostics, Deployment, Security and Audit sections. Security contains Users & access and Operator settings; Audit shows recent security activity. Existing `/security` bookmarks open `/gateway#security`. The header sign-out icon retains its accessible name and tooltip. Observations are explicit snapshots, marked stale after 30 seconds or a failed refresh. A saved connection status does not imply a fresh successful connection test.

Projects and Gateway Settings share a centered header with the lowercase sparkstudio brand. Settings is a plain navigation link on Projects; the gateway header links back to Projects. Select your username on either page to open **Account settings**, where Appearance changes this browser's theme and Change password uses your current password. Closing the dialog returns focus to the username. A successful password change signs you out on all devices; the separate sign-out icon signs out the current audience.

Overview lists application entry points, connection states and tag counts. Sessions lists separate engineering/operator sign-ins, creation/last-activity/expiry times, and an opaque administration handle unrelated to cookie and CSRF secrets. The current session is labeled. Review and confirm revocation to require that session to sign in on its next request; other sessions remain valid. Permission and CSRF checks apply at the API boundary, and the action is audited.

Diagnostics reports process working set, managed memory, process CPU normalized to logical processors, available space on the data volume, active API requests and lifetime response counts. CPU needs two observations at least one second apart. Active requests include long-lived event streams. The last 128 completed API requests retain route templates, response status and elapsed time; request parameters and bodies are not retained. Counters and sessions reset on restart. This is not durable logging, equipment history, a worker profiler or a performance acceptance claim.

**Download support snapshot** creates a local JSON file with an explicit allowlist of metrics and resource counts. It excludes account identities, connection details, request values, tokens, credentials, tag values/paths, authored resources, script output, exception bodies and keys. The console never uploads this snapshot anywhere. A support snapshot is not a backup.

## Deployment observations

**Deployment** is a read-only view of the running gateway. Observed listener addresses come from the server, separately from startup configuration values and their sources. A configured URL is not proof of an active listener. Startup values remain labeled as startup observations even if a configuration file later changes. The saved public operator address is separate: environment/configuration values seed a new account store, while an existing store uses its saved operator settings. A blank public address means operator links use the browser's gateway origin.

Transport information describes the request as observed by the gateway, not the entire route through a network or reverse proxy. SparkStudio does not configure trusted proxies in this increment; a host-level forwarded-header override is reported separately and does not establish verified proxy identity. Certificate expiry is reported only when the current direct TLS connection exposes the local server certificate; plain HTTP and unsupported TLS features show it as unavailable. This does not verify the certificate chain, hostname, every HTTPS listener or a proxy's certificate.

The snapshot uses an explicit configuration allowlist. It does not dump environment variables, certificate passwords, private keys, connection credentials or arbitrary configuration. This page cannot change a listener, install a certificate or restart the service. Certificate administration, trusted-proxy configuration, Windows service install/upgrade/rollback and Docker volume recovery remain G04 acceptance work.

## Try it

Import and publish the original **Gateway operations** workshop using a compatible build. No external services, Python or gateway tags are required. The project is a named resource for the administration exercises; the operator screen contains the exercise instructions, not embedded administration privileges.

1. Open Gateway Settings, search its name and follow its Designer and operator links. Return to the Gateway overview and refresh.
2. Open Sessions. Observe distinct engineering/operator audiences. Open a disposable sign-in in another browser profile, refresh and identify its account, time and audience before selecting Revoke session. Confirm; its next request must require sign-in while your other session continues. Do not revoke a production operator as a test.
3. Open Diagnostics. Refresh twice, at least one second apart, and compare CPU/memory observations. Route paths display placeholders, not actual project IDs or request query strings.
4. Wait over 30 seconds: the page must label the observation stale. Refresh to obtain a new timestamp.
5. Open Security → Users & access and inspect an account without saving changes. Username/display name and new/confirm password fields align in two columns on wide screens and stack on narrow screens. Open Operator settings, then the separate Audit tab; navigation stays inside Gateway Settings.
6. Return to Diagnostics. Download and inspect the support JSON. Verify the exclusion list and bounded route records. Only explicitly share it after reviewing its contents.
7. Sign in as an ordinary Designer or an operator and open `/gateway`: access must be denied. Existing project access stays unchanged.
8. As an administrator, open Deployment. Compare observed listeners and startup URL sources, hosting information and the saved operator address. Inspect the current transport; a plain loopback HTTP connection must not claim certificate validity or HTTPS. Wait over 30 seconds, then refresh the stale snapshot. Do not change transport configuration as part of this workshop.

Session-to-project activity attribution, continuous connection diagnostics, durable metric retention and controlled failure/load acceptance remain later increments of G01/G02. This workshop does not claim those gates complete.
