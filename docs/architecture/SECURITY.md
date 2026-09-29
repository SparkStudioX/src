# Local accounts and project access

SparkStudio has separate engineering and operator sessions backed by one gateway account store. Engineering opens Projects, Designer and, for administrators, Security. Operator URLs remain `/runtime/<project-id>` and load only the published application. Signing in to one audience does not sign in to the other. Project URLs contain no credentials or access tokens.

## First administrator

On a new or upgraded data directory without accounts, the gateway requires setup. Open its local engineering page on the gateway computer, then enter the one-time code from `<data-directory>/security/setup-code.txt` and choose an administrator username and password. There is no default username/password and no HTTP endpoint exposing the setup code. Setup requires a loopback connection even when HTTPS is configured. Successful setup removes the code; it cannot be used to create another administrator. Existing project, connection and database files are preserved.

Passwords contain 12–256 characters and are stored using the framework's salted, versioned PBKDF2 password hasher. The `security/` directory is restricted to the gateway Windows identity, local Administrators and SYSTEM; Unix directories/files use owner-only permissions. Back up the whole gateway data directory with its identity and data-protection files. A missing or invalid identity store requires administrator recovery; removing security files is not an ordinary password-reset workflow.

## Permissions

| Permission | Scope |
| --- | --- |
| Gateway administrator | Accounts, project lifecycle/import, shared connections/tag configuration, security settings, audit and manual Python execution; all project permissions |
| Design | Read/edit/export a named project's drafts, resources and queries; preview read queries |
| Publish | Publish a named project's saved project or script resources; requires Design |
| View | Read a named project's published application and captured read queries |
| Operate | Submit published Python actions in that project; requires View |

Design does not imply View or Operate, and operator access does not imply Design. Only administrators create, rename, duplicate, archive or restore projects. A designer can save a draft without publishing it. Draft update-query execution and manual Python execution require administrator access. Approved published actions run with the gateway account; publisher permission is trusted code-deployment authority, not a script sandbox.

The application API declares permission metadata for both project-specific and legacy default-project routes. Legacy `/api/project`, `/api/runtime`, query, script and asset aliases always authorize the actual default project; a project header cannot retarget them. Unknown APIs fail closed. The catalog includes only projects accessible to the selected audience. Runtime image reads are limited to assets referenced in the current publication.

Viewer pages retain navigation, popups, filtering and table paging while disabling editable inputs, input events and Python action buttons. The server independently rejects viewer action calls. Input values, passwords and browser-supplied role claims cannot identify the audit actor.

## Operator data and links

Security settings declare readable tag paths separately for each project. An exact path grants that tag; a prefix ending in `/` grants descendants. `*` explicitly grants every gateway tag. Empty scopes grant no tag data to non-administrator operators. HTTP reads and event streams enforce the same scope; denied explicit reads return 403. Administrators and engineering designers retain engineering tag browsing. Published query/action code is trusted and can access its authored data sources; tag-read scopes are not an operating-system or Python sandbox.

Designer **Operator access** shows the published revision/time and a copyable stable link. Set the public operator base URL in Security to the gateway's HTTPS origin. Without a configured origin, the link uses the current browser address. A localhost link only works on the computer opening it. Publishing updates the application at the existing link; it does not create an anonymous access grant.

The **Operator link → Presentation** choice defaults to **Application only**. Bare `/runtime/<project-id>` links show the authored screen and popups without the SparkStudio header, screen menu, parameter selectors, theme/account controls or footer. The screen fits the available browser viewport while preserving its aspect ratio. Use authored navigation buttons to move between screens in this view. Connection-loss, action-result and publication notices remain available as overlays when needed.

Choose **Show runtime controls** to generate `/runtime/<project-id>?view=controls`. This restores the surrounding interface, including the configured screen menu, context selectors, theme, Switch user and Sign out. The setting belongs to the link; it does not edit or republish the project. Only one exact `view=controls` parameter opts in; absent, unknown or duplicated values use Application only. Legacy `/runtime` redirects preserve this query choice. Sign-in and all View/Operate permissions apply identically in both presentations.

## Sessions and request protection

Sessions use separate HttpOnly, SameSite=Strict cookies for engineering and operators. HTTPS cookies are Secure. Plain HTTP account/API access is allowed only when the actual peer is loopback. Remote clients require HTTPS; forwarded headers are not trusted automatically. A proxy terminating TLS needs an explicitly reviewed deployment configuration. This increment does not provision certificates or claim network-deployment acceptance.

Sessions expire after eight hours without sliding renewal and require sign-in after a gateway restart. Each session has a random CSRF token held only in browser memory and sent on API mutations, including POST query reads. Origin checks and JSON requirements also protect account endpoints. Login failures are throttled per account and source address. Account edits, permission changes, disabling and password resets revoke that account's sessions. Logout revokes the selected audience's server session. Active tag streams check revocation, expiry, project availability and current scopes while running; the browser also polls its session and clears protected content on loss of access.

The frontend discards form and query state when its identity or effective permissions change. Multiple tabs share their audience cookie and receive sign-out notifications. Shared-station operators should use Switch user or Sign out. Project JavaScript and Python remain trusted authored code. Hosting engineering and operator applications on distinct origins, external identity providers, MFA, fine-grained per-action permissions and hardened multi-tenant isolation remain future work.

## Audit and limits

Security records account administration, sign-in/out, permission denials, project changes/publication and operator action outcomes using the authenticated account identity. Records omit request bodies, passwords, CSRF values and form contents. Audit files remain local in `security/`; the UI shows recent entries. Rotation keeps a current file and one previous file, each approximately 5 MiB. This is a bounded local audit trail, not tamper-evident archival or an external compliance log. Gateway timer/startup scripts have no interactive operator identity and continue to use their existing script-event logs.

The public installer, container lifecycle, real SQL Server and factory-network acceptance remain separate release gates. Project archives and `.sparkproj` packages do not contain users, password hashes, session cookies, security settings or the gateway audit log.

## Verification commands

Use a fresh disposable data directory on loopback port 5091. `node tools/test-security.mjs` exercises actual account setup and authenticated requests; its generated test credentials stay in ignored `.data/test-evidence/security-test-accounts.json`. Existing integration suites can use the real-session preload:

```powershell
$env:SPARKSTUDIO_TEST_AUTH_FILE = Join-Path $PWD '.data/test-evidence/security-test-accounts.json'
node --import ./tools/test-auth-session.mjs tools/test-input-controls.mjs http://127.0.0.1:5091
```

The preload is restricted to isolated port 5091, authenticates normally and sends the matching audience cookie and CSRF token. It adds no authentication bypass to the gateway. Never use fixture credentials for a deployed gateway. Example-loader and legacy unauthenticated CLI calls now need authenticated requests; opening Designer and importing a package remains the interactive path.
