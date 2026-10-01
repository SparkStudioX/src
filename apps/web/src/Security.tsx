import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "./api";
import { useAuth } from "./Auth";
import { noPermissions, noGatewayCapabilities } from "./authSession";
import type { ProjectPermissions, GatewayCapabilities } from "./authSession";
import type { ProjectCatalog, ProjectSummary } from "./projectManagement";
import "./security.css";

interface ManagedUser {
  id: string; username: string; displayName: string; gatewayAdmin: boolean; disabled: boolean; revision: number;
  projectGrants: Record<string, ProjectPermissions>; createdAt: string; updatedAt: string;
  gatewayCapabilities?: GatewayCapabilities;
}
interface GatewaySettings { revision: number; publicBaseUrl: string | null; projectTagPrefixes: Record<string, string[]> }
interface AuditEntry { id: string; recordedAt: string; actor: string; action: string; resource?: string | null; projectId: string | null; outcome: string; targetUserId: string | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const permissionKeys = ["view", "operate", "commands", "design", "publish"] as const;
const permissionLabels: Record<keyof ProjectPermissions, string> = { view: "View", operate: "Operate", commands: "Equipment commands", design: "Design", publish: "Publish" };
const capabilityLabels: Record<keyof GatewayCapabilities, string> = { diagnostics: "Diagnostics and support snapshots", configuration: "Tags, connections and deployment configuration", backups: "Backup configuration, creation and download", audit: "Audit history", sessions: "Session inventory and revocation" };

type SecurityTab = "users" | "gateway";
type SecurityView = SecurityTab | "audit";
const securityTabs = [{ id: "users", name: "Users & access" }, { id: "gateway", name: "Operator settings" }] as const;

export default function Security({ section }: { section: "security" | "audit" }) {
  const auth = useAuth();
  const [tab, setTab] = useState<SecurityTab>("users");
  const [users, setUsers] = useState<ManagedUser[]>([]), [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<GatewaySettings | null>(null), [audit, setAudit] = useState<AuditEntry[]>([]);
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const [loadingViews, setLoadingViews] = useState<Record<SecurityView, boolean>>({ users: true, gateway: true, audit: true });
  const [errors, setErrors] = useState<Record<SecurityView, string>>({ users: "", gateway: "", audit: "" }), [notice, setNotice] = useState("");
  const [operatorState, setOperatorState] = useState({ dirty: false, busy: false });
  const serial = useRef({ users: 0, gateway: 0, audit: 0 }), loaded = useRef({ users: false, gateway: false, audit: false });
  const inFlight = useRef({ users: 0, gateway: 0, audit: 0 });
  const mounted = useRef(true), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const load = useCallback(async (view: SecurityView, background = false) => {
    if (background && inFlight.current[view]) return false;
    const run = ++serial.current[view]; inFlight.current[view] = run;
    if (!background) { setLoadingViews(current => ({ ...current, [view]: true })); setErrors(current => ({ ...current, [view]: "" })); }
    try {
      if (view === "audit") {
        const history = await api<{ entries: AuditEntry[] }>("/security/audit?limit=100");
        if (!mounted.current || run !== serial.current[view]) return false;
        setAudit(history.entries);
      } else if (view === "users") {
        const [userResult, catalog] = await Promise.all([api<{ users: ManagedUser[] }>("/security/users"), api<ProjectCatalog>("/projects")]);
        if (!mounted.current || run !== serial.current[view]) return false;
        setUsers(userResult.users); setProjects(catalog.projects);
      } else {
        const [gateway, catalog] = await Promise.all([api<GatewaySettings>("/security/settings"), api<ProjectCatalog>("/projects")]);
        if (!mounted.current || run !== serial.current[view]) return false;
        setSettings(gateway); setProjects(catalog.projects);
      }
      loaded.current[view] = true;
      setErrors(current => ({ ...current, [view]: "" })); return true;
    } catch (reason) { if (mounted.current && run === serial.current[view]) setErrors(current => ({ ...current, [view]: message(reason) })); return false; }
    finally { if (inFlight.current[view] === run) inFlight.current[view] = 0; if (mounted.current && run === serial.current[view] && !background) setLoadingViews(current => ({ ...current, [view]: false })); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current.users++; serial.current.gateway++; serial.current.audit++; }; }, []);
  useEffect(() => { const view = section === "audit" ? "audit" : tab; if (!loaded.current[view]) void load(view); }, [section, tab, load]);
  useEffect(() => { setNotice(""); setEditing(null); }, [section, tab]);
  useEffect(() => {
    const view = section === "audit" ? "audit" : tab;
    if (editing) { serial.current.users++; return; }
    if (view === "gateway") return;
    const observe = () => { if (document.visibilityState !== "hidden") void load(view, true); };
    if (loaded.current[view]) observe();
    const timer = window.setInterval(observe, 15_000); return () => window.clearInterval(timer);
  }, [section, tab, editing, load]);
  async function accountSaved() { setNotice("Account saved. Changed access applies to new requests and existing sessions are rechecked."); await load("users"); await auth.refresh(); }
  async function operatorSaved(next: GatewaySettings) { if (!mounted.current) return; setSettings(next); setNotice("Operator settings saved."); await auth.refresh(); }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? securityTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + securityTabs.length) % securityTabs.length;
    setTab(securityTabs[next].id); tabs.current[next]?.focus();
  }
  const view = section === "audit" ? "audit" : tab, loading = loadingViews[view], error = errors[view];
  const feedback = <>{error && <p className="security-error" role="alert">{error}<button type="button" className="button small" disabled={loading || view === "gateway" && (operatorState.dirty || operatorState.busy)} onClick={() => void load(view)}>{view === "gateway" ? "Retry operator settings" : view === "users" ? "Retry accounts" : "Retry audit history"}</button></p>}{notice && <p className="security-notice" role="status">{notice}</p>}</>;
  return <div className={section === "audit" ? "security-embedded management-page" : "security-embedded"}>
    {section === "security" && <div className="security-tab-header"><div className="security-tabs" role="tablist" aria-label="Security sections">{securityTabs.map((item, index) => <button key={item.id} ref={element => { tabs.current[index] = element; }} type="button" role="tab" id={`security-tab-${item.id}`} aria-controls={`security-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => moveTab(event, index)}>{item.name}</button>)}</div></div>}
    {section === "audit" && feedback}
    {section === "security" && <>
      <div className="management-page" role="tabpanel" id="security-panel-users" aria-labelledby="security-tab-users" hidden={tab !== "users"} tabIndex={0}>
        {feedback}
        <div className="security-page-heading"><div><h2>Users &amp; access</h2><p>Manage accounts and their permissions. Engineering and operator applications use separate sign-ins.</p></div><div className="security-form-actions"><button className="button primary" disabled={loadingViews.users || Boolean(errors.users)} onClick={() => setEditing("new")}>New user</button></div></div>
        <section className="security-panel security-accounts-panel"><div className="security-panel-heading"><div><h3>Gateway accounts</h3><p>Select Edit to manage an account's access and password.</p></div><span>{users.length} {users.length === 1 ? "account" : "accounts"}</span></div>
        <div className="security-table-scroll"><table className="security-table"><thead><tr><th>User</th><th>Status</th><th>Access</th><th>Updated</th><th><span className="security-sr-only">Manage user</span></th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.username}</small></td><td><span className={`security-badge ${user.disabled ? "is-disabled" : ""}`}>{user.disabled ? "Disabled" : "Active"}</span></td><td>{user.gatewayAdmin ? "Gateway administrator" : `${Object.values(user.projectGrants).filter(grant => permissionKeys.some(key => grant[key])).length} project grants`}</td><td>{new Date(user.updatedAt).toLocaleString()}</td><td><button className="button small" aria-label={`Edit ${user.username}`} disabled={loadingViews.users || Boolean(errors.users)} onClick={() => setEditing(user)}>Edit</button></td></tr>)}</tbody></table></div>
        {!users.length && <p className="muted" role="status">{loadingViews.users ? "Loading accounts…" : "No accounts returned."}</p>}
      </section></div>
      <div className="management-page" role="tabpanel" id="security-panel-gateway" aria-labelledby="security-tab-gateway" hidden={tab !== "gateway"} tabIndex={0}>
        {feedback}
        {settings ? <GatewaySettingsEditor settings={settings} projects={projects} reloading={loadingViews.gateway} onReload={() => load("gateway")} onStateChange={setOperatorState} onSaved={operatorSaved} /> : <p className="security-empty" role="status">{loadingViews.gateway ? "Loading operator settings…" : "Operator settings are unavailable. Retry to load the saved configuration."}</p>}
      </div>
    </>}
    {section === "audit" && <><div className="security-page-heading"><div><h2>Audit</h2><p>Review recent security activity. Passwords and session tokens are not displayed.</p></div></div><section className="security-panel security-audit-panel"><div className="security-panel-heading"><div><h3>Recent security activity</h3><p>The latest 100 recorded events.</p></div><span>{audit.length} {audit.length === 1 ? "event" : "events"}</span></div><div className="security-table-scroll"><table className="security-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Project / user</th><th>Outcome</th></tr></thead><tbody>{audit.map(entry => <tr key={entry.id}><td>{new Date(entry.recordedAt).toLocaleString()}</td><td>{entry.actor}</td><td>{entry.action}{entry.resource && <small>{entry.resource}</small>}</td><td>{entry.projectId || entry.targetUserId || "—"}</td><td>{entry.outcome}</td></tr>)}</tbody></table></div>{!audit.length && <p className="muted" role="status">{loading ? "Loading audit history…" : "No recorded events."}</p>}</section></>}
    {editing && <UserEditor user={editing === "new" ? null : editing} projects={projects} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await accountSaved(); }} />}
  </div>;
}
function UserEditor({ user, projects, onClose, onSaved }: { user: ManagedUser | null; projects: ProjectSummary[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState(user?.username ?? ""), [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [gatewayAdmin, setGatewayAdmin] = useState(user?.gatewayAdmin ?? false), [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [grants, setGrants] = useState<Record<string, ProjectPermissions>>(() => structuredClone(user?.projectGrants ?? {}));
  const [capabilities, setCapabilities] = useState<GatewayCapabilities>(() => ({ ...noGatewayCapabilities, ...user?.gatewayCapabilities }));
  const [resetPassword, setResetPassword] = useState(!user), [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  function grant(projectId: string, key: keyof ProjectPermissions, checked: boolean) {
    setGrants(current => {
      const next = { ...(current[projectId] ?? noPermissions), [key]: checked };
      if (key === "operate" && checked) next.view = true;
      if (key === "commands" && checked) { next.operate = true; next.view = true; }
      if (key === "operate" && !checked) next.commands = false;
      if (key === "view" && !checked) { next.operate = false; next.commands = false; }
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
      const common = { displayName, gatewayAdmin, disabled, projectGrants, gatewayCapabilities: capabilities };
      if (user) await api(`/security/users/${encodeURIComponent(user.id)}`, "PUT", { ...common, revision: user.revision, ...(resetPassword ? { password } : {}) });
      else await api("/security/users", "POST", { ...common, username, password });
      await onSaved();
    } catch (reason) { setError(message(reason)); }
    finally { setPassword(""); setConfirm(""); setBusy(false); }
  }
  return <dialog ref={dialog} className="security-dialog" aria-labelledby="security-user-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault(); }}><form className="security-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header><h2 id="security-user-title">{user ? `Edit ${user.username}` : "Create user"}</h2></header>
    <div className="security-dialog-body"><div className="security-form-grid"><label>Username<input autoFocus required pattern={"[A-Za-z0-9._\\-]{3,64}"} minLength={3} maxLength={64} autoComplete="off" value={username} disabled={busy || Boolean(user)} onChange={event => setUsername(event.target.value)} /><small>{user ? "The username cannot be changed." : "3–64 letters, numbers, dots, underscores or hyphens."}</small></label><label>Display name<input maxLength={100} value={displayName} disabled={busy} onChange={event => setDisplayName(event.target.value)} /></label></div>
      <div className="security-check-row"><label><input type="checkbox" checked={disabled} disabled={busy} onChange={event => setDisabled(event.target.checked)} /><span>Account disabled</span></label><label><input type="checkbox" checked={gatewayAdmin} disabled={busy} onChange={event => setGatewayAdmin(event.target.checked)} /><span>Gateway administrator</span></label></div>
      <p className="muted">Gateway administrators manage accounts and gateway settings and have access to all projects. Disabling an account blocks sign-in and revokes its access.</p>
      <fieldset disabled={busy || gatewayAdmin}><legend>Gateway capabilities</legend><p className="muted">Grant individual gateway tasks without account administration. Administrators have every capability. These grants do not add project design or operator access.</p>{(Object.keys(capabilityLabels) as (keyof GatewayCapabilities)[]).map(key => <label className="security-checkbox" key={key}><input type="checkbox" checked={gatewayAdmin || capabilities[key]} onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.checked }))} /><span>{capabilityLabels[key]}</span></label>)}</fieldset>
      <fieldset disabled={busy}><legend>Project permissions</legend><p className="muted">View opens operator screens. Operate includes View and allows ordinary operator actions. Equipment commands separately grants controlled device commands and includes Operate. Design edits project resources. Publish includes Design and deploys layout changes. Creating or changing executable JavaScript or Python during publication or rollback requires a gateway administrator: browser scripts have the operator application’s privileges and Python runs as the gateway service account.</p><div className="security-table-scroll"><table className="security-table security-grants"><thead><tr><th>Project</th>{permissionKeys.map(key => <th key={key}>{permissionLabels[key]}</th>)}</tr></thead><tbody>{projects.map(project => <tr key={project.id}><td>{project.name}{project.archived ? " (archived)" : ""}</td>{permissionKeys.map(key => <td key={key}><input type="checkbox" aria-label={`${permissionLabels[key]} ${project.name}`} checked={grants[project.id]?.[key] ?? false} onChange={event => grant(project.id, key, event.target.checked)} /></td>)}</tr>)}</tbody></table></div>{!projects.length && <p>No projects are available.</p>}</fieldset>
      {user && <label className="security-checkbox"><input type="checkbox" checked={resetPassword} disabled={busy} onChange={event => { setResetPassword(event.target.checked); setPassword(""); setConfirm(""); }} /><span>Set a new password</span></label>}
      {resetPassword && <div className="security-form-grid"><label>{user ? "New password" : "Password"}<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><small>12–256 characters. Enter a password explicitly.</small></label><label>Confirm password<input type="password" autoComplete="new-password" required maxLength={256} value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} /></label></div>}
      {error && <p className="security-error" role="alert">{error}</p>}
    </div><footer><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : user ? "Save account" : "Create user"}</button></footer>
  </form></dialog>;
}

const prefixText = (settings: GatewaySettings): Record<string, string> => Object.fromEntries(Object.entries(settings.projectTagPrefixes).map(([key, value]) => [key, value.join("\n")]));
const prefixLines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const projectPageSize = 50;
function GatewaySettingsEditor({ settings, projects, reloading, onReload, onSaved, onStateChange }: { settings: GatewaySettings; projects: ProjectSummary[]; reloading: boolean; onReload: () => Promise<boolean>; onSaved: (settings: GatewaySettings) => Promise<void>; onStateChange: (state: { dirty: boolean; busy: boolean }) => void }) {
  const [url, setUrl] = useState(settings.publicBaseUrl ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [prefixes, setPrefixes] = useState<Record<string, string>>(() => prefixText(settings));
  const [selected, setSelected] = useState(projects[0]?.id || ""), [search, setSearch] = useState(""), [page, setPage] = useState(0);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setUrl(settings.publicBaseUrl ?? ""); setPrefixes(prefixText(settings)); setError(""); }, [settings]);
  const projectTagPrefixes = Object.fromEntries(Object.entries(prefixes).map(([key, value]) => [key, prefixLines(value)]));
  const dirty = url !== (settings.publicBaseUrl ?? "") || JSON.stringify(prefixes) !== JSON.stringify(prefixText(settings));
  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  const chosen = projects.find(project => project.id === selected) || projects[0];
  const matching = projects.filter(project => `${project.name} ${project.id} ${project.archived ? "archived" : "active"}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(matching.length / projectPageSize)), currentPage = Math.min(page, pageCount - 1);
  const visible = matching.slice(currentPage * projectPageSize, (currentPage + 1) * projectPageSize);
  const currentPrefixes = chosen ? projectTagPrefixes[chosen.id] || [] : [];
  let validation = "";
  for (const [projectId, values] of Object.entries(projectTagPrefixes)) {
    if (values.length > 100 || new Set(values).size !== values.length || values.some(value => value.length > 512 || /[\x00-\x1f\x7f]/.test(value))) { validation = `${projects.find(project => project.id === projectId)?.name || projectId}: use at most 100 unique prefixes, each no longer than 512 characters and without control characters.`; break; }
  }
  const locked = busy || reloading;
  async function cancel() {
    if (pending.current || reloading) return;
    pending.current = true; setBusy(true); setUrl(settings.publicBaseUrl ?? ""); setPrefixes(prefixText(settings)); setError(""); setNotice("");
    try { const received = await onReload(); if (mounted.current && received) setNotice("Unsaved operator settings discarded. The latest saved settings are loaded."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit() {
    if (pending.current || reloading || !dirty || validation) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api<GatewaySettings>("/security/settings", "PUT", { revision: settings.revision, publicBaseUrl: url.trim() || null, projectTagPrefixes });
      if (mounted.current) { await onSaved(saved); }
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const scopeSummary = (projectId: string) => { const values = projectTagPrefixes[projectId] || []; return !values.length ? "No tag reads" : values.includes("*") ? "All gateway tags" : `${values.length} tag-path ${values.length === 1 ? "prefix" : "prefixes"}`; };
  return <section className="security-operator-settings"><form className="security-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="security-section-heading security-page-heading"><div><h2>Operator settings</h2><p>Manage operator links and the gateway tags each project can read.</p></div><div className="security-form-actions"><button type="button" className="button" disabled={locked || !dirty} onClick={() => void cancel()}>Cancel changes</button><button type="submit" className="button primary" disabled={locked || !dirty || Boolean(validation)}>{busy && dirty ? "Saving…" : "Save operator settings"}</button></div></div>
    <p className="security-draft-status" role="status">{dirty ? "Unsaved changes. Save applies the operator URL and all project tag access together." : "All changes saved"} · Revision {settings.revision}</p>
    {error && <p className="security-error" role="alert">{error}<span className="security-save-help">Your draft is retained. Cancel changes discards it and loads the latest saved settings.</span></p>}{notice && <p className="security-notice" role="status">{notice}</p>}{dirty && validation && <p className="security-error" role="alert">{validation}</p>}
    <section className="security-panel security-operator-url"><div className="security-panel-heading"><div><h3>Operator links</h3><p>Choose the public address used in published operator links.</p></div></div><div className="security-panel-body"><label>Public operator base URL<input type="url" placeholder="https://operations.example.com" maxLength={2048} value={url} disabled={locked} onChange={event => { setUrl(event.target.value); setNotice(""); }} /><small>Leave blank to use this browser's gateway address. Use an HTTPS origin, or HTTP for localhost. This setting does not configure DNS, TLS or network listeners.</small></label></div></section>
    <div className="security-project-access-workspace">
      <section className="security-panel security-project-list-panel" aria-labelledby="security-project-access-title"><div className="security-project-panel-heading security-panel-heading"><div><h3 id="security-project-access-title">Project tag access</h3><p>Select a project to edit its allowed tags.</p></div><span>{projects.length} projects</span></div>
        <div className="security-project-search-panel"><label className="security-project-search">Search projects<input type="search" value={search} disabled={locked} placeholder="Project name, ID or status" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label></div>
        {visible.length ? <ul className="security-project-list">{visible.map(project => <li key={project.id}><button type="button" disabled={locked} aria-label={`Edit tag access ${project.name}`} aria-pressed={chosen?.id === project.id} onClick={() => setSelected(project.id)}><strong>{project.name}</strong><span>{project.archived ? "Archived" : "Active"} · {project.id}</span><small>{scopeSummary(project.id)}</small></button></li>)}</ul> : <p className="security-empty" role="status">{projects.length ? "No projects match this search." : "No projects are available. Create a project to configure its tag access."}</p>}
        <div className="security-project-pagination"><span>{matching.length ? `${currentPage * projectPageSize + 1}–${Math.min((currentPage + 1) * projectPageSize, matching.length)} of ${matching.length}` : "0 results"}</span><div><button type="button" className="button small" disabled={locked || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous projects</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" className="button small" disabled={locked || currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next projects</button></div></div>
      </section>
      <section className="security-panel security-project-editor-panel" aria-labelledby="security-project-properties-title"><div className="security-project-panel-heading security-panel-heading"><div><h3 id="security-project-properties-title">{chosen ? chosen.name : "Project properties"}</h3>{chosen && <p>{chosen.archived ? "Archived project" : "Active project"} · {chosen.id}</p>}</div></div>
        <div className="security-panel-body">{chosen ? <><label>Tag-path prefixes<textarea rows={10} spellCheck={false} disabled={locked} placeholder="[default]Area1/" value={prefixes[chosen.id] ?? ""} aria-describedby="security-prefix-help security-prefix-summary" onChange={event => { setPrefixes(current => ({ ...current, [chosen.id]: event.target.value })); setNotice(""); }} /></label><p id="security-prefix-help" className="security-prefix-help">Enter one tag path or prefix per line. A blank list grants no tag reads. * grants all gateway tags. A trailing / includes tags below that path; entries without it match an exact tag path. Matching is case-sensitive.</p><p id="security-prefix-summary" className="security-prefix-summary">{!currentPrefixes.length ? "This project has no tag read access." : currentPrefixes.includes("*") ? "This project can read all gateway tags." : `${currentPrefixes.length} tag-path ${currentPrefixes.length === 1 ? "entry" : "entries"} in this draft.`}</p></> : <p className="security-empty">Select a project to edit its tag access.</p>}</div>
      </section>
    </div>
  </form></section>;
}
