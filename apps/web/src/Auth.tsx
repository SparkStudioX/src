import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authExpiredEvent, configureAuthSession, noPermissions, noGatewayCapabilities } from "./authSession";
import type { AuthAudience, ProjectPermissions, GatewayCapabilities } from "./authSession";
import { ThemePicker } from "./Theme";
import "./security.css";

export interface AuthUser { id: string; username: string; displayName: string; gatewayAdmin: boolean }
interface AuthSession {
  setupRequired: boolean;
  audience: AuthAudience;
  user: AuthUser | null;
  csrfToken: string | null;
  permissions: ProjectPermissions & { gatewayAdmin?: boolean };
  gatewayCapabilities?: GatewayCapabilities;
  project: { id: string; name: string } | null;
  operatorBaseUrl: string | null;
}
interface AuthContextValue {
  user: AuthUser | null;
  gatewayAdmin: boolean;
  gatewayCapabilities: GatewayCapabilities;
  gatewayAccess: boolean;
  permissions: ProjectPermissions;
  csrfToken: string | null;
  audience: AuthAudience;
  projectId: string | null;
  epoch: number;
  publicOperatorBaseUrl: string;
  signOut: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refresh: () => Promise<void>;
  phase: "checking" | "ready" | "unavailable" | "signingOut";
  setupRequired: boolean;
  notice: string;
  signIn: (username: string, password: string) => Promise<void>;
  setup: (username: string, displayName: string, password: string, setupCode: string) => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const signOutKey = (audience: AuthAudience) => `sparkstudio.auth.signout.${audience}`;
function signOutIntent(audience: AuthAudience): { active: boolean; pending: boolean } {
  try { const value = window.localStorage.getItem(signOutKey(audience)); return { active: value !== null, pending: Number(value) > Date.now() }; }
  catch { return { active: false, pending: false }; }
}
function storeSignOutIntent(audience: AuthAudience, pending: boolean | null): void {
  // This flag contains no account, credentials or token. It prevents an offline logout from
  // silently restoring the same HttpOnly cookie after a reload or in another tab.
  try { if (pending === null) window.localStorage.removeItem(signOutKey(audience)); else window.localStorage.setItem(signOutKey(audience), pending ? String(Date.now() + 20000) : "1"); }
  catch { /* In-memory locking remains available when browser storage is disabled. */ }
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Authentication context is unavailable.");
  return value;
}

export function AuthProvider({ audience, projectId, children }: { audience: AuthAudience; projectId: string | null; children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [phase, setPhase] = useState<AuthContextValue["phase"]>("checking");
  const [notice, setNotice] = useState("");
  const [epoch, setEpoch] = useState(0);
  const serial = useRef(0), fingerprint = useRef(""), signedOut = useRef(false), authenticating = useRef(false), loggingOut = useRef(false);
  const changingPassword = useRef(false);
  const active = useRef(true), lifecycle = useRef(0), channel = useRef<BroadcastChannel | null>(null);

  const apply = useCallback((next: AuthSession | null) => {
    const key = next?.user ? JSON.stringify([next.user, next.permissions, next.csrfToken]) : "anonymous";
    configureAuthSession({ audience, projectId, csrfToken: next?.csrfToken ?? null, key });
    if (fingerprint.current !== key) { fingerprint.current = key; setEpoch(value => value + 1); }
    setSession(next);
  }, [audience, projectId]);

  const request = useCallback(async <T,>(path: string, body?: unknown, csrfToken?: string | null): Promise<T> => {
    const headers = new Headers({ "X-SPARK-AUDIENCE": audience });
    if (projectId) headers.set("X-SPARK-PROJECT", projectId);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (csrfToken) headers.set("X-SPARK-CSRF", csrfToken);
    const response = await fetch(`/api/auth/${path}`, { method: body === undefined ? "GET" : "POST", headers,
      credentials: "same-origin", redirect: "error", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || data?.message || (response.status === 429 ? "Too many attempts. Wait before trying again." : `Request failed (${response.status}).`));
    if (!data || typeof data !== "object") throw new Error("The gateway returned an invalid authentication response.");
    return data as T;
  }, [audience, projectId]);

  const acceptSession = useCallback((next: AuthSession) => {
    if (next.audience !== audience || typeof next.setupRequired !== "boolean" || !next.permissions || (next.user && !next.csrfToken))
      throw new Error("The gateway returned an invalid authentication session.");
    apply(next); setPhase("ready"); setNotice("");
  }, [apply, audience]);

  const refresh = useCallback(async () => {
    if (signedOut.current || authenticating.current || loggingOut.current || changingPassword.current) return;
    const run = ++serial.current;
    const query = new URLSearchParams({ audience });
    if (projectId) query.set("projectId", projectId);
    try {
      const next = await request<AuthSession>(`session?${query}`);
      if (active.current && run === serial.current && !signedOut.current) acceptSession(next);
    } catch (error) {
      if (active.current && run === serial.current && !signedOut.current) { apply(null); setPhase("unavailable"); setNotice(message(error)); }
    }
  }, [acceptSession, apply, audience, projectId, request]);

  const expire = useCallback((text: string) => {
    serial.current++; apply(null); setPhase("ready"); setNotice(text);
  }, [apply]);

  useEffect(() => {
    active.current = true; lifecycle.current++; signedOut.current = signOutIntent(audience).active;
    configureAuthSession({ audience, projectId, csrfToken: null, key: "checking" });
    if (signedOut.current) {
      apply(null); setPhase(signOutIntent(audience).pending ? "signingOut" : "ready"); setNotice("Signed out. Enter your credentials to continue.");
      // A reset gateway may need setup, but an old cookie must not restore its previous user.
      const run = ++serial.current, query = new URLSearchParams({ audience });
      if (projectId) query.set("projectId", projectId);
      void request<AuthSession>(`session?${query}`).then(next => {
        if (active.current && run === serial.current && signedOut.current)
          apply({ ...next, user: null, csrfToken: null, permissions: noPermissions });
      }).catch(() => { /* The explicit sign-in form remains available while offline. */ });
    } else void refresh();
    const timer = window.setInterval(() => { if (signedOut.current && !loggingOut.current && !signOutIntent(audience).pending) setPhase("ready"); else void refresh(); }, 10000);
    const onFocus = () => { void refresh(); };
    const onExpired = () => { signedOut.current = true; expire("Your session has ended. Sign in to continue."); };
    const onStoredIntent = (event?: StorageEvent) => { if (event?.key && event.key !== signOutKey(audience)) return; const intent = signOutIntent(audience); if (intent.active) { signedOut.current = true; expire("You signed out in another tab."); setPhase(intent.pending ? "signingOut" : "ready"); } };
    window.addEventListener("focus", onFocus); window.addEventListener(authExpiredEvent, onExpired); window.addEventListener("storage", onStoredIntent);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel(`sparkstudio-auth-${audience}`);
      channel.current.onmessage = event => { if (event.data === "signed-out") onStoredIntent(); };
    }
    return () => { active.current = false; lifecycle.current++; serial.current++; window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener(authExpiredEvent, onExpired); window.removeEventListener("storage", onStoredIntent); channel.current?.close(); channel.current = null; };
  }, [audience, projectId, refresh, expire, apply, request]);

  const signOut = useCallback(async () => {
    if (loggingOut.current || changingPassword.current) return;
    const csrf = session?.csrfToken;
    loggingOut.current = true; storeSignOutIntent(audience, true);
    signedOut.current = true; expire(""); setPhase("signingOut"); channel.current?.postMessage("signed-out");
    try { await request("logout", { audience }, csrf); }
    catch (error) { if (active.current) setNotice(`The gateway could not confirm sign-out: ${message(error)} Close this browser session if you cannot reconnect.`); }
    finally { loggingOut.current = false; storeSignOutIntent(audience, false); channel.current?.postMessage("signed-out"); if (active.current) setPhase("ready"); }
  }, [audience, expire, request, session?.csrfToken]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (changingPassword.current) throw new Error("Your password change is still finishing. Please wait.");
    if (!session?.user || !session.csrfToken || signedOut.current || loggingOut.current || authenticating.current)
      throw new Error("Sign in before changing your password.");
    // A refresh started before this mutation must not restore a revoked session.
    changingPassword.current = true; serial.current++;
    const started = lifecycle.current;
    try {
      const result = await request<{ changed: boolean }>("password", { currentPassword, newPassword }, session.csrfToken);
      if (result.changed !== true) throw new Error("The gateway did not confirm your password change.");
      if (!active.current || lifecycle.current !== started) return;
      signedOut.current = true; storeSignOutIntent(audience, false);
      expire("Password changed. Sign in with your new password.");
      channel.current?.postMessage("signed-out");
    } finally { changingPassword.current = false; }
  }, [audience, expire, request, session]);

  const authenticate = useCallback(async (path: "login" | "setup", body: unknown) => {
    if (loggingOut.current || signOutIntent(audience).pending) throw new Error("Sign-out is still finishing. Please wait before signing in.");
    if (changingPassword.current) throw new Error("Your password change is still finishing. Please wait before signing in.");
    if (authenticating.current) return;
    authenticating.current = true;
    const run = ++serial.current;
    try {
      const next = await request<AuthSession>(path, body);
      if (!active.current || run !== serial.current) return;
      storeSignOutIntent(audience, null); signedOut.current = false; acceptSession(next);
    } finally { authenticating.current = false; }
    // Setup returns the engineering session; re-read the current project's effective permissions.
    if (path === "setup" && projectId && active.current) await refresh();
  }, [acceptSession, audience, projectId, refresh, request]);

  const value = useMemo<AuthContextValue>(() => ({
    user: session?.user ?? null, gatewayAdmin: Boolean(session?.user?.gatewayAdmin), permissions: session?.permissions ?? noPermissions,
    gatewayCapabilities: session?.gatewayCapabilities ?? noGatewayCapabilities,
    gatewayAccess: Boolean(session?.user?.gatewayAdmin || Object.values(session?.gatewayCapabilities ?? noGatewayCapabilities).some(Boolean)),
    csrfToken: session?.csrfToken ?? null, audience, projectId, epoch, publicOperatorBaseUrl: session?.operatorBaseUrl ?? "",
    signOut, changePassword, refresh, phase, setupRequired: session?.setupRequired ?? false, notice,
    signIn: (username, password) => authenticate("login", { audience, username, password, ...(projectId ? { projectId } : {}) }),
    setup: (username, displayName, password, setupCode) => authenticate("setup", { username, displayName, password, setupCode }),
  }), [session, audience, projectId, epoch, signOut, changePassword, refresh, phase, notice, authenticate]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function AuthFrame({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return <main className="auth-page"><div className="auth-theme"><ThemePicker /></div><section className="auth-card"><a href={auth.audience === "operator" ? "/?audience=operator" : "/"} className="auth-brand">SparkStudio<span>APPLICATION GATEWAY</span></a>{children}</section></main>;
}

export function AuthGate({ children, requireAdmin = false, requireGateway = false }: { children: ReactNode; requireAdmin?: boolean; requireGateway?: boolean }) {
  const auth = useAuth();
  if (auth.phase === "signingOut") return <AuthFrame><h1>Signing out</h1><p role="status">Closing your gateway session…</p></AuthFrame>;
  if (auth.phase === "checking") return <AuthFrame><h1>Connecting securely</h1><p role="status">Checking your gateway session…</p></AuthFrame>;
  if (auth.phase === "unavailable") return <AuthFrame><h1>Gateway unavailable</h1><p role="alert">{auth.notice}</p><button className="button primary" onClick={() => { void auth.refresh(); }}>Try again</button></AuthFrame>;
  if (auth.setupRequired && auth.audience === "operator") return <AuthFrame><h1>Gateway setup pending</h1><p>An administrator must finish setting up this gateway before operators can sign in.</p><button className="button" onClick={() => { void auth.refresh(); }}>Check again</button></AuthFrame>;
  if (!auth.user) return <AuthFrame><SignInForm key={String(auth.setupRequired)} setup={auth.setupRequired} /></AuthFrame>;
  const denied = requireAdmin ? !auth.gatewayAdmin : requireGateway ? !auth.gatewayAccess : auth.projectId !== null && !(auth.audience === "operator" ? auth.permissions.view : auth.permissions.design);
  if (denied) return <AuthFrame><h1>Access not granted</h1><p role="alert">{requireAdmin ? "Gateway administrator access is required." : requireGateway ? "A gateway capability is required." : `This account does not have ${auth.audience === "operator" ? "view" : "design"} permission for this project.`}</p><p>Signed in as {auth.user.displayName}.</p><div className="auth-actions"><button className="button" onClick={() => { void auth.signOut(); }}>Switch user</button>{auth.audience === "engineering" && <a className="button" href="/">Projects</a>}</div></AuthFrame>;
  return <div className="authenticated-app" key={auth.epoch}>{children}</div>;
}

function SignInForm({ setup }: { setup: boolean }) {
  const auth = useAuth();
  const [username, setUsername] = useState(""), [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit() {
    if (busy) return;
    if (setup && password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true); setError("");
    try { if (setup) await auth.setup(username, displayName, password, code); else await auth.signIn(username, password); }
    catch (reason) { setError(message(reason)); }
    finally { setPassword(""); setConfirm(""); setCode(""); setBusy(false); }
  }
  return <><div className="eyebrow">{setup ? "FIRST-TIME SETUP" : auth.audience === "operator" ? "OPERATOR ACCESS" : "ENGINEERING ACCESS"}</div><h1>{setup ? "Create your administrator" : "Sign in"}</h1>
    <p>{setup ? "Use the setup code saved on the gateway computer to create its first administrator." : auth.audience === "operator" ? "Open the operator application with your assigned project access." : "Access projects and engineering tools with your gateway account."}</p>
    {setup && <section className="auth-setup-help" aria-labelledby="setup-code-heading">
      <h2 id="setup-code-heading">Find your setup code</h2>
      <p>On the gateway computer, open <strong>PowerShell</strong> with <strong>Run as administrator</strong>. For the Windows installer, run:</p>
      <pre><code>{'Get-Content -LiteralPath "$env:ProgramData\\SparkStudio\\security\\setup-code.txt"'}</code></pre>
      <p>The default file is <code>{"C:\\ProgramData\\SparkStudio\\security\\setup-code.txt"}</code>. Paste the code it contains into <strong>Gateway setup code</strong> below.</p>
      <details><summary>Portable, development or container installation</summary><p>Read <code>security/setup-code.txt</code> inside your configured gateway data directory instead. The file is removed after you create the first administrator.</p></details>
    </section>}
    {auth.notice && <p className="security-notice" role="status">{auth.notice}</p>}
    <form className="security-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>Username<input autoFocus={!setup} autoComplete="username" required minLength={setup ? 3 : undefined} maxLength={64} pattern={setup ? "[A-Za-z0-9._\\-]{3,64}" : undefined} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /></label>
      {setup && <label>Display name<input autoComplete="name" maxLength={100} value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={busy} /></label>}
      <label>Password<input type="password" autoComplete={setup ? "new-password" : "current-password"} required minLength={setup ? 12 : undefined} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      {setup && <><label>Confirm password<input type="password" autoComplete="new-password" required maxLength={256} value={confirm} onChange={event => setConfirm(event.target.value)} disabled={busy} /></label><label>Gateway setup code<input autoComplete="off" required value={code} onChange={event => setCode(event.target.value)} disabled={busy} /><small>Paste the code from the local file shown above, not the file path.</small></label><p className="muted">Use 12–256 characters for the password. This account will manage users, gateway settings and project grants.</p></>}
      {error && <p className="security-error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? "Please wait…" : setup ? "Create administrator" : "Sign in"}</button>
    </form></>;
}
