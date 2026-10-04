import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAuth } from "./Auth";
import { useAskSpark } from "./askSparkContext";
import { AskSparkLauncher } from "./AskSpark";
import { SessionIdentity } from "./OperatorAccess";
import { AccountSettingsDialog } from "./AccountSettings";
import Icon from "./Icon";
import Tags from "./Tags";
import ModelsWorkspace from "./ModelsWorkspace";
import { recordModelNavigationLocation, requestModelNavigation, workspaceNavigationEvent } from "./modelNavigation";
import type { Connection, Tag } from "./types";

const currentSection = () => new URLSearchParams(window.location.search).get("workspace") === "tags" ? "tags" : "models";
/** Shared gateway data editing does not depend on a project being open. */
export default function DataWorkspace() {
  const { user, gatewayAccess, gatewayCapabilities } = useAuth(), ask = useAskSpark();
  const [section, setSection] = useState(currentSection), [accountOpen, setAccountOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]), [tags, setTags] = useState<Tag[]>([]);
  const [notice, setNotice] = useState({ message: "", error: false });
  const current = useRef({ mounted: false, generation: 0, values: 0, pending: false });
  const refresh = useCallback(async () => {
    const state = current.current, generation = ++state.generation, values = ++state.values; state.pending = true;
    try {
      const [nextConnections, nextTags] = await Promise.all([api<Connection[]>("/connections"), api<Tag[]>("/tag-engineering/values")]);
      if (!state.mounted || generation !== state.generation) return;
      setConnections(nextConnections); if (values === state.values) setTags(nextTags);
    } catch (reason) { if (state.mounted && generation === state.generation) setNotice({ message: reason instanceof Error ? reason.message : String(reason), error: true }); }
    finally { if (generation === state.generation) state.pending = false; }
  }, []);
  useEffect(() => {
    const state = current.current; state.mounted = true;
    if (!gatewayCapabilities.configuration) return () => { state.mounted = false; state.generation++; state.values++; };
    void refresh();
    let polling = false;
    const poll = async () => {
      if (polling || state.pending || document.visibilityState === "hidden") return;
      polling = true; const values = ++state.values;
      try { const next = await api<Tag[]>("/tag-engineering/values"); if (state.mounted && values === state.values) setTags(next); }
      catch { /* The next bounded poll retries; no overlapping requests or stale updates. */ }
      finally { polling = false; }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { state.mounted = false; state.generation++; state.values++; state.pending = false; window.clearInterval(timer); };
  }, [gatewayCapabilities.configuration, refresh]);
  useEffect(() => {
    const update = () => setSection(currentSection());
    window.addEventListener("popstate", update); window.addEventListener(workspaceNavigationEvent, update);
    return () => { window.removeEventListener("popstate", update); window.removeEventListener(workspaceNavigationEvent, update); };
  }, []);
  useEffect(() => ask.registerContext("data-workspace", () => ({ surface: "workspace", section, editorAvailable: false }), 10), [ask.registerContext, section]);
  const navigate = (next: string) => {
    if (next === section) return;
    requestModelNavigation(() => { const url = new URL(window.location.href); url.search = ""; url.searchParams.set("workspace", next); window.history.pushState(window.history.state, "", url); recordModelNavigationLocation(); setSection(next); });
  };
  return <div className="app-shell">
    <aside className="navigation"><div className="navigation-scroll"><a className="brand" href="/" aria-label="SparkStudio projects" title="SparkStudio projects"><span className="brand-mark"><Icon name="spark" size={24} /></span><span>spark<span className="brand-light">studio</span><small>DATA WORKSPACE</small></span></a>
      <a className="designer-project-link" href="/" aria-label="Projects" title="Projects"><Icon name="layers" size={17} /><span>Projects</span><Icon name="arrow" size={13} /></a>
      <div className="nav-section-label">WORKSPACE</div><nav aria-label="Workspace">{([["tags", "tag", "Tags"], ["models", "layers", "Models"]] as const).map(([key, icon, label]) => <button key={key} className={`nav-link ${section === key ? "active" : ""}`} aria-label={label} title={label} aria-current={section === key ? "page" : undefined} onClick={() => navigate(key)}><Icon name={icon} /><span>{label}</span></button>)}</nav>
      {gatewayAccess && <a className="designer-project-link" href="/gateway" aria-label="Gateway Settings" title="Gateway Settings"><Icon name="settings" size={17} /><span>Gateway Settings</span></a>}
    </div><div className="nav-bottom"><SessionIdentity placement="sidebar" onAccountSettings={() => setAccountOpen(true)} /></div></aside>
    <main className="app-main" data-ask-spark-open={ask.open}><header className="topbar"><div className="breadcrumb"><span>Workspace</span><Icon name="arrow" size={13} /><strong>{section === "models" ? "Models" : "Tags"}</strong></div><div className="topbar-actions"><AskSparkLauncher /></div></header>
      {notice.message && <p className={notice.error ? "gateway-error" : "gateway-observation"} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
      {!gatewayCapabilities.configuration ? <section className="management-page"><h1>Configuration access required</h1><p>Ask your gateway administrator for Configuration permission to manage tags and models.</p></section> : user && (section === "models" ? <ModelsWorkspace key={user.id} ownerId={user.id} connections={connections} tags={tags} onApplied={() => void refresh()} /> : <Tags connections={connections} tags={tags} onTagsChanged={() => void refresh()} notify={(message, error = false) => setNotice({ message, error })} />)}
    </main>{accountOpen && <AccountSettingsDialog onClose={() => setAccountOpen(false)} />}
  </div>;
}
