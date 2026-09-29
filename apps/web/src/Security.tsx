import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAuth } from "./Auth";
import { noPermissions } from "./authSession";
import type { ProjectPermissions } from "./authSession";
import type { ProjectCatalog, ProjectSummary } from "./projectManagement";
import "./security.css";

interface ManagedUser {
  id: string; username: string; displayName: string; gatewayAdmin: boolean; disabled: boolean; revision: number;
  projectGrants: Record<string, ProjectPermissions>; createdAt: string; updatedAt: string;
}
interface GatewaySettings { revision: number; publicBaseUrl: string | null; projectTagPrefixes: Record<string, string[]> }
interface AuditEntry { id: string; recordedAt: string; actor: string; action: string; resource?: string | null; projectId: string | null; outcome: string; targetUserId: string | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const permissionKeys = ["view", "operate", "design", "publish"] as const;
const permissionLabels: Record<keyof ProjectPermissions, string> = { view: "View", operate: "Operate", design: "Design", publish: "Publish" };

export default function Security({ section }: { section: "security" | "audit" }) {
  const auth = useAuth();
  const [tab, setTab] = useState<"users" | "gateway">("users");
  const [users, setUsers] = useState<ManagedUser[]>([]), [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<GatewaySettings | null>(null), [audit, setAudit] = useState<AuditEntry[]>([]);
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const serial = useRef(0);
  const load = useCallback(async () => {
    const run = ++serial.current; setLoading(true); setError("");
    try {
      if (section === "audit") {
        const history = await api<{ entries: AuditEntry[] }>("/security/audit?limit=100");
        if (run === serial.current) setAudit(history.entries);
      } else if (tab === "users") {
        const [userResult, catalog] = await Promise.all([
          api<{ users: ManagedUser[] }>("/security/users"), api<ProjectCatalog>("/projects"),
        ]);
        if (run !== serial.current) return;
        setUsers(userResult.users); setProjects(catalog.projects);
      } else {
        const [gateway, catalog] = await Promise.all([
          api<GatewaySettings>("/security/settings"), api<ProjectCatalog>("/projects"),
        ]);
        if (run !== serial.current) return;
        setSettings(gateway); setProjects(catalog.projects);
      }
    } catch (reason) { if (run === serial.current) setError(message(reason)); }
    finally { if (run === serial.current) setLoading(false); }
  }, [section, tab]);
  useEffect(() => { void load(); return () => { serial.current++; }; }, [load]);
  useEffect(() => { setNotice(""); setEditing(null); }, [section, tab]);
  async function saved(text: string) { setNotice(text); await load(); await auth.refresh(); }
  const refresh = <button type="button" className="button" aria-label={section === "audit" ? "Refresh audit history" : tab === "users" ? "Refresh accounts" : "Refresh operator settings"} disabled={loading} onClick={() => { void load(); }}>{loading ? "Refreshing…" : "Refresh"}</button>;
  return <div className="security-embedded">
    {section === "security" && <nav className="security-tabs" aria-label="Security sections">{(["users", "gateway"] as const).map(name => <button key={name} type="button" className={tab === name ? "is-active" : ""} aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)}>{name === "users" ? "Users & access" : "Operator settings"}</button>)}{refresh}</nav>}
    {error && <p className="security-error" role="alert">{error}</p>}{notice && <p className="security-notice" role="status">{notice}</p>}
    {section === "security" && tab === "users" && <section className="security-panel"><div className="security-section-heading"><div><h2>Gateway accounts</h2><p>Accounts can sign in separately to engineering and operator applications.</p></div><button className="button primary" disabled={loading || Boolean(error)} onClick={() => setEditing("new")}>New user</button></div>
      <div className="security-table-scroll"><table className="security-table"><thead><tr><th>User</th><th>Status</th><th>Access</th><th>Updated</th><th><span className="security-sr-only">Manage user</span></th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.username}</small></td><td><span className={`security-badge ${user.disabled ? "is-disabled" : ""}`}>{user.disabled ? "Disabled" : "Active"}</span></td><td>{user.gatewayAdmin ? "Gateway administrator" : `${Object.values(user.projectGrants).filter(grant => permissionKeys.some(key => grant[key])).length} project grants`}</td><td>{new Date(user.updatedAt).toLocaleString()}</td><td><button className="button small" aria-label={`Edit ${user.username}`} disabled={loading || Boolean(error)} onClick={() => setEditing(user)}>Edit</button></td></tr>)}</tbody></table></div>
      {!users.length && <p className="muted" role="status">{loading ? "Loading accounts…" : "No accounts returned."}</p>}
    </section>}
    {section === "security" && tab === "gateway" && !loading && !error && settings && <GatewaySettingsEditor key={settings.revision} settings={settings} projects={projects} onSaved={() => saved("Operator settings saved.")} />}
    {section === "audit" && <section className="security-panel"><div className="security-section-heading"><div><h2>Recent security activity</h2><p>The latest 100 recorded events. Passwords and session tokens are not displayed.</p></div>{refresh}</div><div className="security-table-scroll"><table className="security-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Project / user</th><th>Outcome</th></tr></thead><tbody>{audit.map(entry => <tr key={entry.id}><td>{new Date(entry.recordedAt).toLocaleString()}</td><td>{entry.actor}</td><td>{entry.action}{entry.resource && <small>{entry.resource}</small>}</td><td>{entry.projectId || entry.targetUserId || "—"}</td><td>{entry.outcome}</td></tr>)}</tbody></table></div>{!audit.length && <p className="muted">{loading ? "Loading audit history…" : "No recorded events."}</p>}</section>}
    {editing && <UserEditor user={editing === "new" ? null : editing} projects={projects} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await saved("Account saved. Changed access applies to new requests and existing sessions are rechecked."); }} />}
  </div>;
}

function UserEditor({ user, projects, onClose, onSaved }: { user: ManagedUser | null; projects: ProjectSummary[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState(user?.username ?? ""), [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [gatewayAdmin, setGatewayAdmin] = useState(user?.gatewayAdmin ?? false), [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [grants, setGrants] = useState<Record<string, ProjectPermissions>>(() => structuredClone(user?.projectGrants ?? {}));
  const [resetPassword, setResetPassword] = useState(!user), [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  function grant(projectId: string, key: keyof ProjectPermissions, checked: boolean) {
    setGrants(current => {
      const next = { ...(current[projectId] ?? noPermissions), [key]: checked };
      if (key === "operate" && checked) next.view = true;
      if (key === "view" && !checked) next.operate = false;
      if (key === "publish" && checked) next.design = true;
      if (key === "design" && !checked) next.publish = false;
      return { ...current, [projectId]: next };
    });
  }
  async function submit() {
    if (busy) return;
    if (resetPassword && password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      const projectGrants = Object.fromEntries(Object.entries(grants).filter(([, value]) => permissionKeys.some(key => value[key])));
      const common = { displayName, gatewayAdmin, disabled, projectGrants };
      if (user) await api(`/security/users/${encodeURIComponent(user.id)}`, "PUT", { ...common, revision: user.revision, ...(resetPassword ? { password } : {}) });
      else await api("/security/users", "POST", { ...common, username, password });
      await onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setPassword(""); setConfirm(""); setBusy(false); }
  }
  return <dialog ref={dialog} className="security-dialog" aria-labelledby="security-user-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault(); }}><form className="security-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header><div className="eyebrow">GATEWAY ACCOUNT</div><h2 id="security-user-title">{user ? `Edit ${user.username}` : "Create user"}</h2></header>
    <div className="security-dialog-body"><div className="security-form-grid"><label>Username<input autoFocus required pattern={"[A-Za-z0-9._\\-]{3,64}"} minLength={3} maxLength={64} autoComplete="off" value={username} disabled={busy || Boolean(user)} onChange={event => setUsername(event.target.value)} /><small>{user ? "The username cannot be changed." : "3–64 letters, numbers, dots, underscores or hyphens."}</small></label><label>Display name<input maxLength={100} value={displayName} disabled={busy} onChange={event => setDisplayName(event.target.value)} /></label></div>
      <div className="security-check-row"><label><input type="checkbox" checked={disabled} disabled={busy} onChange={event => setDisabled(event.target.checked)} /> Account disabled</label><label><input type="checkbox" checked={gatewayAdmin} disabled={busy} onChange={event => setGatewayAdmin(event.target.checked)} /> Gateway administrator</label></div>
      <p className="muted">Gateway administrators manage accounts and gateway settings and have access to all projects. Disabling an account blocks sign-in and revokes its access.</p>
      <fieldset disabled={busy}><legend>Project permissions</legend><p className="muted">View opens operator screens. Operate includes View and allows operator actions. Design edits project resources. Publish includes Design and deploys changes. Design does not automatically grant operator access.</p><div className="security-table-scroll"><table className="security-table security-grants"><thead><tr><th>Project</th>{permissionKeys.map(key => <th key={key}>{permissionLabels[key]}</th>)}</tr></thead><tbody>{projects.map(project => <tr key={project.id}><td>{project.name}{project.archived ? " (archived)" : ""}</td>{permissionKeys.map(key => <td key={key}><input type="checkbox" aria-label={`${permissionLabels[key]} ${project.name}`} checked={grants[project.id]?.[key] ?? false} onChange={event => grant(project.id, key, event.target.checked)} /></td>)}</tr>)}</tbody></table></div>{!projects.length && <p>No projects are available.</p>}</fieldset>
      {user && <label className="security-checkbox"><input type="checkbox" checked={resetPassword} disabled={busy} onChange={event => { setResetPassword(event.target.checked); setPassword(""); setConfirm(""); }} /> Set a new password</label>}
      {resetPassword && <div className="security-form-grid"><label>{user ? "New password" : "Password"}<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><small>12–256 characters. Enter a password explicitly.</small></label><label>Confirm password<input type="password" autoComplete="new-password" required maxLength={256} value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} /></label></div>}
      {error && <p className="security-error" role="alert">{error}</p>}
    </div><footer><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : user ? "Save account" : "Create user"}</button></footer>
  </form></dialog>;
}

function GatewaySettingsEditor({ settings, projects, onSaved }: { settings: GatewaySettings; projects: ProjectSummary[]; onSaved: () => Promise<void> }) {
  const [url, setUrl] = useState(settings.publicBaseUrl ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [prefixes, setPrefixes] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(settings.projectTagPrefixes).map(([key, value]) => [key, value.join("\n")])));
  async function submit() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const projectTagPrefixes = Object.fromEntries(Object.entries(prefixes).map(([key, value]) => [key, value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)]));
      await api("/security/settings", "PUT", { revision: settings.revision, publicBaseUrl: url.trim() || null, projectTagPrefixes }); await onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  return <section className="security-panel"><h2>Operator access settings</h2><form className="security-form" onSubmit={event => { event.preventDefault(); void submit(); }}><label>Public operator base URL<input type="url" placeholder="https://operations.example.com" maxLength={2048} value={url} disabled={busy} onChange={event => setUrl(event.target.value)} /><small>Used for operator links. Leave blank to use the gateway address in this browser. This setting does not configure DNS, TLS or network listeners.</small></label>
    <fieldset disabled={busy}><legend>Project tag access</legend><p className="muted">Configure the tag-path prefixes visible to each operator project, one per line. A blank list grants no tag reads; * explicitly grants all tags. These grants apply to shared gateway tag data.</p>{projects.map(project => <label key={project.id}>{project.name}{project.archived ? " (archived)" : ""}<textarea rows={2} placeholder="[default]Area1/" value={prefixes[project.id] ?? ""} onChange={event => setPrefixes(current => ({ ...current, [project.id]: event.target.value }))} /></label>)}</fieldset>
    {error && <p className="security-error" role="alert">{error}</p>}<div className="security-form-actions"><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save operator settings"}</button></div></form></section>;
}
