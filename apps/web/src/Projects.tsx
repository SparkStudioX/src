import { useCallback, useEffect, useRef, useState } from "react";
import { api, projectPage } from "./api";
import Icon from "./Icon";
import { useAuth } from "./Auth";
import { SessionIdentity } from "./OperatorAccess";
import { exportProjectPackage, importProjectPackage } from "./projectManagement";
import type { ProjectCatalog, ProjectSummary } from "./projectManagement";
import "./projects.css";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type ProjectAction = { kind: "create" } | { kind: "rename" | "duplicate" | "archive" | "restore"; project: ProjectSummary };

export function ProjectImportDialog({ onClose, onImported }: { onClose: () => void; onImported?: (project: ProjectSummary) => void }) {
  const { gatewayAdmin } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ProjectSummary | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="project-import-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="eyebrow">PORTABLE APPLICATION</div><h2 id="project-import-title">{created ? "Project imported" : "Import a project"}</h2></header>
    {created ? <><div className="project-dialog-body"><p><strong>{created.name}</strong> is an independent, unpublished project.</p><p>Review its screens, scripts and named-query connection references before publishing. Imported script resources are inactive until you publish them.</p><a className="button primary" href={projectPage("designer", created.id)}><Icon name="design" size={16} /> Open designer</a></div><footer><button className="button" onClick={onClose}>Done</button></footer></> : <form onSubmit={event => { event.preventDefault(); if (!gatewayAdmin || !file || busy) return; setBusy(true); setError(""); void importProjectPackage(file, name).then(project => { setCreated(project); onImported?.(project); }).catch(error => setError(message(error))).finally(() => setBusy(false)); }}>
      <div className="project-dialog-body"><p>A .sparkproj package creates a new project. Existing projects stay separate.</p><label>Package<input autoFocus type="file" accept=".sparkproj" disabled={busy} required onChange={event => { setFile(event.target.files?.[0] || null); setError(""); }} /></label><label>Project name <span>(optional)</span><input value={name} maxLength={120} disabled={busy} placeholder="Use the package's project name" onChange={event => setName(event.target.value)} /></label><p className="project-note">Up to 32 MiB. Packages contain saved project resources and local assets. Gateway connections, credentials, tags and database contents are excluded. Named queries retain their connection IDs.</p>{error && <p className="project-error" role="alert">{error}</p>}</div>
      <footer><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={!gatewayAdmin || !file || busy}>{busy ? "Importing…" : "Import as new project"}</button></footer>
    </form>}
  </dialog>;
}

function ProjectActionDialog({ action, onClose, onComplete }: { action: ProjectAction; onClose: () => void; onComplete: (project: ProjectSummary, action: ProjectAction["kind"]) => void }) {
  const { gatewayAdmin, audience } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(action.kind === "create" ? "" : action.kind === "duplicate" ? `${action.project.name} copy`.slice(0, 120) : action.project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const heading = action.kind === "create" ? "Create project" : action.kind === "rename" ? "Rename project" : action.kind === "duplicate" ? "Duplicate project" : action.kind === "archive" ? "Archive project" : "Restore project";
  async function submit() {
    if (!gatewayAdmin || audience !== "engineering" || busy) return;
    setBusy(true); setError("");
    try {
      const result = action.kind === "create"
        ? await api<ProjectSummary>("/projects", "POST", { name: name.trim() })
        : action.kind === "rename"
          ? await api<ProjectSummary>(`/projects/${encodeURIComponent(action.project.id)}`, "PATCH", { name: name.trim(), revision: action.project.revision })
          : action.kind === "duplicate"
            ? await api<ProjectSummary>(`/projects/${encodeURIComponent(action.project.id)}/duplicate`, "POST", { name: name.trim() })
            : await api<ProjectSummary>(`/projects/${encodeURIComponent(action.project.id)}/archive`, "POST", { archived: action.kind === "archive" });
      onComplete(result, action.kind); onClose();
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="project-action-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); void submit(); }}>
    <header><div className="eyebrow">PROJECT MANAGEMENT</div><h2 id="project-action-title">{heading}</h2></header><div className="project-dialog-body">
      {action.kind === "archive" ? <p>Archive <strong>{action.project.name}</strong>? Its saved resources remain available for restoration. The operator application and project scripts will be unavailable while archived.</p> : action.kind === "restore" ? <p>Restore <strong>{action.project.name}</strong> to the active project list? Its saved operator publication becomes available, and previously published gateway events resume immediately.</p> : <><label>Project name<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label><p className="project-note">{action.kind === "duplicate" ? "Copies saved application resources into an independent, unpublished project. Save changes in the source designer first. Gateway connections and live tag/database data are shared, not copied." : action.kind === "rename" ? "Changes the draft project's name. Existing operator publications retain their saved name until you publish again." : "Start with a separate project workspace for screens, queries, scripts and assets. Tags and connections belong to the shared gateway."}</p></>}
      {error && <p className="project-error" role="alert">{error}</p>}
    </div><footer><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className={`button ${action.kind === "archive" ? "project-archive-button" : "primary"}`} disabled={busy || ((action.kind === "create" || action.kind === "rename" || action.kind === "duplicate") && !name.trim())}>{busy ? "Working…" : heading}</button></footer>
  </form></dialog>;
}

export default function Projects() {
  const { gatewayAdmin, audience } = useAuth();
  const engineering = audience === "engineering";
  const manage = engineering && gatewayAdmin;
  const canDesign = (project: ProjectSummary) => engineering && (gatewayAdmin || project.permissions?.design === true);
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ message: string; project?: ProjectSummary } | null>(null);
  const [action, setAction] = useState<ProjectAction | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState("");
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(""); try { setCatalog(await api<ProjectCatalog>("/projects")); } catch (error) { setError(message(error)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const projects = (catalog?.projects || []).filter(project => (manage && showArchived || !project.archived) && (engineering || project.published) && `${project.name} ${project.id}`.toLowerCase().includes(filter.toLowerCase()));
  const complete = (project: ProjectSummary, kind: ProjectAction["kind"] | "import") => {
    setNotice({ message: kind === "create" ? `Created ${project.name}. Open the designer to build your application.` : kind === "duplicate" || kind === "import" ? `${project.name} is ready for review. Publish the project and script resources separately when ready.` : kind === "archive" ? `${project.name} archived. Use Show archived to restore it.` : kind === "restore" ? `${project.name} restored.` : `${project.name} renamed.`, project: ["create", "duplicate", "restore"].includes(kind) ? project : undefined });
    void load();
  };
  async function download(project: ProjectSummary) {
    if (!canDesign(project) || exporting) return;
    setExporting(project.id); setError("");
    try { await exportProjectPackage(project); setNotice({ message: `Downloaded ${project.name}. The package contains saved drafts; browser edits and gateway data are excluded.` }); }
    catch (error) { setError(message(error)); }
    finally { setExporting(""); }
  }
  return <div className="projects-shell">
    <header className="projects-header"><a className="projects-brand" href={engineering ? "/" : "/?audience=operator"}><span className="brand-mark"><Icon name="spark" size={24} /></span><strong>spark<span>studio</span></strong></a><div>{manage && <a className="button" href="/gateway"><Icon name="settings" size={15} />Settings</a>}<SessionIdentity operator={!engineering} iconOnlySignOut /></div></header>
    <main className="projects-main"><div className="projects-heading"><div><div className="eyebrow">{engineering ? "APPLICATION WORKSPACE" : "OPERATIONS"}</div><h1>Your projects</h1><p>{engineering ? "Design and publish the applications assigned to your account." : "Open an operator application available to your account."}</p></div>{manage && <div className="projects-heading-actions"><button className="button" onClick={() => setImporting(true)}><Icon name="upload" size={16} />Import .sparkproj</button><button className="button primary" onClick={() => setAction({ kind: "create" })}><Icon name="plus" size={16} />New project</button></div>}</div>
      {engineering && <div className="projects-gateway-note"><Icon name="plug" size={19} /><div><strong>Separate applications. Shared gateway.</strong><span>Each project has its own screens, queries, scripts, assets and publication. Gateway administrators manage connections and tags.</span></div></div>}
      <div className="projects-tools"><label className="project-search"><Icon name="search" size={16} /><input aria-label="Find projects" placeholder="Find a project…" value={filter} onChange={event => setFilter(event.target.value)} /></label>{manage && <label className="project-archived-toggle"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label>}<button className="button" disabled={loading} onClick={() => void load()}><Icon name="refresh" size={15} />Refresh</button></div>
      {error && <div className="project-error" role="alert">{error}</div>}{notice && <div className="project-notice" role="status"><span>{notice.message}</span>{notice.project && canDesign(notice.project) && <a className="button" href={projectPage("designer", notice.project.id)}>Open designer <Icon name="arrow" size={14} /></a>}<button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}
      {loading && !catalog ? <div className="projects-empty"><span className="loading-ring" /><h2>Loading projects</h2></div> : <div className="project-cards">{projects.map(project => <article className={`project-card${project.archived ? " is-archived" : ""}`} key={project.id}>
        <div className="project-card-top"><span className="project-card-icon"><Icon name="layers" size={25} /></span><div className="project-card-badges">{(project.isDefault || project.id === catalog?.defaultProjectId) && <span>DEFAULT</span>}<span className={project.archived ? "archived" : project.published ? "published" : "draft"}>{project.archived ? "ARCHIVED" : project.published ? "PUBLISHED" : "DRAFT ONLY"}</span></div></div>
        <h2>{project.name}</h2><div className="project-id">{project.id}</div>
        <dl>{canDesign(project) && <div><dt>Saved draft</dt><dd>Revision {project.revision}</dd></div>}<div><dt>Operator publication</dt><dd>{project.published ? project.publishedRevision !== undefined ? `Revision ${project.publishedRevision}` : "Available" : "Not published"}</dd></div></dl>
        <div className="project-card-launch">{project.archived ? manage && <button className="button primary" onClick={() => setAction({ kind: "restore", project })}>Restore project</button> : <>{canDesign(project) && <a className="button primary" href={projectPage("designer", project.id)}><Icon name="design" size={15} />Open designer</a>}{project.published ? <a className={`button${canDesign(project) ? "" : " primary"}`} href={projectPage("runtime", project.id)} target={engineering ? "_blank" : undefined} rel={engineering ? "noopener noreferrer" : undefined}><Icon name="monitor" size={15} />{engineering ? "Runtime" : "Open application"}</a> : <span className="project-runtime-unpublished">Awaiting publication</span>}</>}</div>
        {(manage || canDesign(project)) && <div className="project-card-actions">{manage && !project.archived && <><button onClick={() => setAction({ kind: "rename", project })}>Rename</button><button onClick={() => setAction({ kind: "duplicate", project })}>Duplicate</button></>}{canDesign(project) && <button disabled={Boolean(exporting)} onClick={() => void download(project)}>{exporting === project.id ? "Exporting…" : "Export .sparkproj"}</button>}{manage && !project.archived && !(project.isDefault || project.id === catalog?.defaultProjectId) && <button onClick={() => setAction({ kind: "archive", project })}>Archive</button>}</div>}
      </article>)}</div>}
      {!loading && !projects.length && <div className="projects-empty"><Icon name="layers" size={34} /><h2>{filter ? "No matching projects" : "No projects available"}</h2><p>{filter ? "Try another project name." : manage ? "Create a project or import a .sparkproj package to get started." : "Ask a gateway administrator to grant access to a project."}</p></div>}
      {engineering && <p className="projects-footer-note">Export uses saved application resources. Save open screen, query and script edits before exporting. Runtime links require a separate operator sign-in.</p>}
    </main>{manage && action && <ProjectActionDialog key={action.kind === "create" ? "create" : `${action.kind}-${action.project.id}`} action={action} onClose={() => setAction(null)} onComplete={complete} />}{manage && importing && <ProjectImportDialog onClose={() => setImporting(false)} onImported={project => complete(project, "import")} />}
  </div>;
}

export function DefaultProjectRedirect({ kind }: { kind: "designer" | "runtime" }) {
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<ProjectCatalog>("/projects").then(catalog => {
      if (!active) return;
      if (!catalog.defaultProjectId) {
        setError(catalog.projects.length
          ? "The default project is unavailable to this account. Open Projects to choose an application you can access."
          : "No projects are available to this account. Ask a gateway administrator to grant project access.");
        return;
      }
      window.location.replace(projectPage(kind, catalog.defaultProjectId) + window.location.search + window.location.hash);
    }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [kind]);
  return <main className="projects-empty"><h1>{error ? "Unable to open the default project" : "Opening the default project…"}</h1>{error && <p role="alert">{error}</p>}<a className="button" href={kind === "runtime" ? "/?audience=operator" : "/"}>Projects</a></main>;
}
