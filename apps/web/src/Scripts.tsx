import ApplicationPublishDialog from "./ApplicationPublishDialog";
import type { GatewayScriptEvent, RuntimeParameters, ScriptResource, ScriptType } from "./types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, id, projectPage, projectStorageKey } from "./api";
import Icon from "./Icon";
import { useAuth } from "./Auth";
import ScriptEditor from "./ScriptEditor";
import { pythonSystemCompletions } from "./eventScriptAuthoring";
import type { ScriptResult } from "./types";
import type { Completion } from "@codemirror/autocomplete";

type Scalar = string | number | boolean | null;
interface ScriptDraft { revision: number; resources: ScriptResource[] }
export type ScriptSearchResource = ScriptResource;
interface ScriptPublication { published: boolean; revision?: number; publishedAt?: string; draftRevision?: number }
interface EventStatus {
  activeRevision: number | null;
  publishedAt: string | null;
  pythonAvailable: boolean;
  journalError?: string | null;
  resources: { id: string; name: string; event: string; enabled: boolean; running: boolean; currentRunId?: string | null; queued?: number; missedEvents?: number; executionCount?: number; nextRunAt?: string | null; lastRunAt?: string | null; lastSuccess?: boolean | null }[];
}
interface RunLog {
  runId: string; resourceId: string; name: string; type: string; event: string; source: string;
  revision: number; startedAt: string; finishedAt?: string; status: string; success: boolean;
  stdout: string; stderr: string; durationMs: number; result?: unknown; resultTruncated?: boolean;
}
const scopes: { type: ScriptType; name: string; icon: string }[] = [
  { type: "library", name: "Project library", icon: "layers" },
  { type: "gateway", name: "Gateway events", icon: "activity" },
  { type: "client", name: "Browser events", icon: "monitor" },
];
const gatewayEvents: { event: GatewayScriptEvent; title: string; description: string }[] = [
  { event: "startup", title: "Startup", description: "Runs when an application publication activates, including gateway restart and rollback. Each publication starts a new event generation." },
  { event: "update", title: "Update", description: "The published handler observes saved script or project resources, including the actor and changed resources. Saving does not execute draft code." },
  { event: "shutdown", title: "Shutdown", description: "Best-effort cleanup during an orderly stop, project archive or script-publication replacement. All shutdown work shares a bounded budget; forced termination cannot run cleanup." },
  { event: "timer", title: "Timer", description: "Runs repeatedly without overlapping itself. Fixed rate skips missed intervals instead of building a backlog." },
  { event: "tagChange", title: "Tag change", description: "Watches configured tag paths. The event includes the previous/new qualified values, initialChange and missedEvents." },
  { event: "message", title: "Message handler", description: "Receives an explicit named request. The resource name is the handler name; payload is a JSON object." },
  { event: "scheduled", title: "Scheduled", description: "Runs on a five-field cron schedule in the selected time zone. Missed time during downtime is skipped; a repeated daylight-saving minute runs once." },
];
const initialCode = `# Python 3 executes on the gateway.\nvalues = system.tag.readBlocking(["[default]Line/{line}/Speed"])\nprint("Speed:", values[0].value)\nresult = {"speed": values[0].value}\n`;
const pythonCompletions: Completion[] = [
  ...pythonSystemCompletions,
  { label: "parameters", type: "variable", detail: "Declared execution parameters" },
  { label: "event", type: "variable", detail: "Gateway event context: type, reason, timestamp, actor, resources, executionCount" },
  { label: "payload", type: "variable", detail: "Message handler JSON payload" },
  { label: "initialChange", type: "variable", detail: "Tag-change initial sample flag" },
  { label: "previousValue", type: "variable", detail: "Previous qualified tag value" },
  { label: "newValue", type: "variable", detail: "New qualified tag value" },
  { label: "missedEvents", type: "variable", detail: "Coalesced tag changes while a handler was busy" },
  { label: "result", type: "variable", detail: "Execution result" },
  { label: "print", type: "function" },
  ...["import", "from", "def", "return", "if", "for"].map(label => ({ label, type: "keyword" })),
];
function readConsole() { try { return localStorage.getItem(projectStorageKey("sparkstudio.script")) || initialCode; } catch { return initialCode; } }
function message(error: unknown) {
  return error instanceof ApiError && error.status === 409
    ? "Another save or publication changed this revision. Your edits are still here. Copy any work you need, then reload the saved resources."
    : error instanceof Error ? error.message : String(error);
}
function parseParameters(text: string): Record<string, Scalar> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Parameters must be a JSON object.");
  const entries = Object.entries(parsed);
  if (entries.length > 64) throw new Error("Use at most 64 parameters.");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid parameter name: ${key}`);
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Parameter ${key} must be a scalar value.`);
    if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(`Parameter ${key} must be a safe finite number.`);
    if (typeof value === "string" && value.length > 4096) throw new Error(`Parameter ${key} exceeds 4,096 characters.`);
  }
  return parsed as Record<string, Scalar>;
}
function time(value?: string | null) { return value ? new Date(value).toLocaleTimeString() : "—"; }

export default function Scripts({ parameters, pythonAvailable, notify, onDirtyChange, navigationRequest, onNavigationHandled, onSearchResources, onSearchError, onSearchLoading, externalRefresh }: {
  parameters: RuntimeParameters;
  pythonAvailable: boolean;
  notify: (message: string, error?: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  navigationRequest?: { id: string; token: number };
  onNavigationHandled?: (token: number) => void;
  onSearchResources?: (resources: ScriptSearchResource[]) => void;
  onSearchError?: (message: string) => void;
  onSearchLoading?: (loading: boolean) => void;
  externalRefresh?: ScriptDraft | null;
}) {
  const { gatewayAdmin, permissions } = useAuth();
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [saved, setSaved] = useState("");
  const [publishReview, setPublishReview] = useState(false);
  const [publication, setPublication] = useState<ScriptPublication | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [consoleCode, setConsoleCode] = useState(readConsole);
  const [runParameterText, setRunParameterText] = useState(JSON.stringify(parameters, null, 2));
  const [defaultText, setDefaultText] = useState("{}");
  const [defaultError, setDefaultError] = useState("");
  const [source, setSource] = useState<"draft" | "published">("draft");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "save" | "publish" | "run">("");
  const [error, setError] = useState("");
  const [searchLoadError, setSearchLoadError] = useState("");
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [outputTab, setOutputTab] = useState<"output" | "result" | "events">("output");
  const [status, setStatus] = useState<EventStatus | null>(null);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [monitorError, setMonitorError] = useState("");
  const [messagePayload, setMessagePayload] = useState('{\n  "message": "Workshop request"\n}');
  const [cancellingRun, setCancellingRun] = useState("");
  const [confirm, setConfirm] = useState<"" | "reload" | "delete">("");
  const mounted = useRef(true);
  const loadEpoch = useRef(0);
  const handledNavigation = useRef<number | null>(null);
  const selected = draft?.resources.find(resource => resource.id === selectedId);
  const dirty = draft !== null && JSON.stringify(draft) !== saved;
  const handledRefresh = useRef<ScriptDraft | null>(null);
  useEffect(() => {
    if (!externalRefresh || handledRefresh.current === externalRefresh || busy) return;
    handledRefresh.current = externalRefresh;
    if (dirty || defaultError) {
      setError("Ask Spark changed saved scripts. Your unsaved script text is retained. Use Reload when you are ready to replace it with the saved resources.");
      return;
    }
    loadEpoch.current++;
    setDraft(externalRefresh); setSaved(JSON.stringify(externalRefresh)); setLoading(false); setSearchLoadError(""); setError(""); setResult(null);
    setSelectedId(previous => externalRefresh.resources.some(resource => resource.id === previous) ? previous : null);
    setOpenIds(previous => previous.filter(id => externalRefresh.resources.some(resource => resource.id === id)));
    setDefaultText(JSON.stringify(externalRefresh.resources.find(resource => resource.id === selectedId)?.parameters ?? {}));
  }, [externalRefresh, busy, dirty, defaultError, selectedId]);
  useEffect(() => { onDirtyChange?.(dirty || Boolean(defaultError)); }, [dirty, defaultError, onDirtyChange]);
  useEffect(() => {
    if (draft) onSearchResources?.(draft.resources);
  }, [draft, onSearchResources, externalRefresh]);
  useEffect(() => { onSearchError?.(searchLoadError); }, [searchLoadError, onSearchError]);
  useEffect(() => { onSearchLoading?.(loading); }, [loading, onSearchLoading]);
  const browserScript = selected?.type === "client";
  const language = browserScript ? "javascript" : "python";
  const currentCode = selected?.code ?? consoleCode;
  const canRun = gatewayAdmin && !busy && !loading && pythonAvailable && !browserScript && !defaultError && (!selected || !dirty && (source === "draft" || Boolean(publication?.published)));
  const canTestMessage = gatewayAdmin && !busy && !loading && pythonAvailable && !dirty && !defaultError && selected?.type === "gateway" && selected.event === "message" && selected.enabled && publication?.published && publication.revision === draft?.revision;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true); setError(""); setSearchLoadError(""); setConfirm("");
    try {
      const [next, published] = await Promise.all([api<ScriptDraft>("/scripts/resources"), api<ScriptPublication>("/scripts/publication")]);
      if (!mounted.current || epoch !== loadEpoch.current) return;
      setDraft(next); setSaved(JSON.stringify(next)); setPublication(published);
      setSelectedId(null); setOpenIds([]); setDefaultError(""); setDefaultText("{}");
    } catch (reason) { if (mounted.current && epoch === loadEpoch.current) { setError(message(reason)); setSearchLoadError(message(reason)); } }
    finally { if (mounted.current && epoch === loadEpoch.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (onDirtyChange) return;
    const warn = (event: BeforeUnloadEvent) => { if (dirty || defaultError) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, defaultError, onDirtyChange]);
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const values = await Promise.allSettled([api<EventStatus>("/scripts/events/status"), api<RunLog[]>("/scripts/events/logs")]);
      refreshing = false;
      if (!active) return;
      if (values[0].status === "fulfilled") setStatus(values[0].value);
      if (values[1].status === "fulfilled") setLogs(values[1].value);
      const failure = values.find(value => value.status === "rejected");
      setMonitorError(failure?.status === "rejected" ? message(failure.reason) : "");
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const open = useCallback((resource: ScriptResource | null, discardInvalid = false) => {
    if (busy) return;
    if ((resource?.id ?? null) === selectedId && !discardInvalid) return;
    if (defaultError && !discardInvalid) { setError("Finish correcting parameter JSON before switching scripts. Your unfinished text is retained in the editor."); return; }
    setSelectedId(resource?.id ?? null);
    if (resource) setOpenIds(previous => previous.includes(resource.id) ? previous : [...previous, resource.id]);
    setDefaultText(JSON.stringify(resource?.parameters ?? {}, null, 2));
    setDefaultError(""); setConfirm(""); setError(""); setResult(null);
    setRunParameterText(JSON.stringify(resource?.parameters ?? parameters, null, 2));
  }, [busy, selectedId, defaultError, parameters]);
  useEffect(() => {
    if (!navigationRequest || handledNavigation.current === navigationRequest.token || loading || busy) return;
    handledNavigation.current = navigationRequest.token;
    const resource = draft?.resources.find(item => item.id === navigationRequest.id);
    if (!resource) notify("This script resource is no longer available. Reload resources and try again.", true);
    else if (resource.id !== selectedId && defaultError) {
      const explanation = "Finish correcting parameter JSON before switching scripts. Your unfinished text is retained in the editor.";
      setError(explanation); notify(explanation, true);
    } else open(resource);
    onNavigationHandled?.(navigationRequest.token);
  }, [navigationRequest, loading, busy, draft, selectedId, defaultError, open, notify, onNavigationHandled]);
  const edit = (patch: Partial<ScriptResource>) => {
    if (!selected || busy) return;
    setDraft(previous => previous && ({ ...previous, resources: previous.resources.map(resource => resource.id === selected.id ? { ...resource, ...patch } : resource) }));
  };
  const changeEvent = (event: ScriptResource["event"]) => {
    if (!selected || busy) return;
    const next = { ...selected, event };
    for (const key of ["intervalMs", "delayType", "tagPaths", "changeTriggers", "cron", "timeZone", "requiredPermission"] as const) delete next[key];
    if (selected.type === "gateway") {
      if (event === "timer") Object.assign(next, { intervalMs: 1000, delayType: "fixedDelay" });
      if (event === "tagChange") Object.assign(next, { tagPaths: ["[default]Workshop/GatewayEvents/Counter"], changeTriggers: ["value"] });
      if (event === "scheduled") Object.assign(next, { cron: "*/5 * * * *", timeZone: "UTC" });
      if (event === "message") next.requiredPermission = "operate";
    }
    setDraft(previous => previous && ({ ...previous, resources: previous.resources.map(resource => resource.id === selected.id ? next : resource) }));
  };
  const add = (type: ScriptType) => {
    if (!draft || busy || draft.resources.length >= 100) return;
    if (defaultError) { setError("Finish correcting parameter JSON before adding a resource. Your unfinished text is retained in the editor."); return; }
    let number = 1;
    const base = type === "library" ? "helpers" : type === "gateway" ? "Gateway event" : "Browser event";
    let name = base;
    while (draft.resources.some(resource => resource.name === name)) name = `${base}${type === "library" ? "_" : " "}${++number}`;
    const resource: ScriptResource = {
      id: id(type), name, type, enabled: type === "library", parameters: {},
      ...(type === "library" ? {} : { event: "startup" as const }),
      ...(type === "gateway" ? { timeoutMs: 10000, threading: "dedicated" as const } : {}),
      code: type === "library" ? "def describe(value):\n    return str(value)\n" : type === "gateway" ? "logger = system.util.getLogger(\"gateway\")\nlogger.info(\"Gateway event executed\")\n" : "// JavaScript executes in this operator browser.\napp.notify(\"Operator session ready\");\n",
    };
    setDraft({ ...draft, resources: [...draft.resources, resource] }); open(resource);
  };
  const saveResources = async () => {
    if (!draft || busy || defaultError) return;
    setBusy("save"); setError("");
    try {
      const next = await api<ScriptDraft>("/scripts/resources", "PUT", draft);
      if (!mounted.current) return;
      setDraft(next); setSaved(JSON.stringify(next)); notify(`Script resources saved at revision ${next.revision}.`);
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { if (mounted.current) setBusy(""); }
  };
  const save = async () => {
    if (busy || defaultError) return;
    if (selectedId) { await saveResources(); return; }
    if (!gatewayAdmin) return;
    try { localStorage.setItem(projectStorageKey("sparkstudio.script"), consoleCode); notify("Console saved in this browser for this project."); }
    catch { setError("Browser storage is unavailable. Copy your console code before leaving."); }
  };
  const publish = async () => {
    if (!permissions.publish || !draft || busy || dirty || defaultError) return;
    setPublishReview(true);
  };
  const run = async () => {
    if (!canRun) return;
    let runParameters: Record<string, Scalar>;
    try { runParameters = parseParameters(runParameterText); }
    catch (reason) { setError(message(reason)); return; }
    setBusy("run"); setError(""); setOutputTab("output");
    try {
      const next = selected
        ? await api<ScriptResult>(`/scripts/resources/${encodeURIComponent(selected.id)}/run`, "POST", { revision: source === "draft" ? draft!.revision : publication!.revision, source, parameters: runParameters })
        : await api<ScriptResult>("/scripts/run", "POST", { code: consoleCode, parameters: runParameters });
      if (mounted.current) setResult(next);
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { if (mounted.current) setBusy(""); }
  };
  const testMessage = async () => {
    if (!canTestMessage || !selected) return;
    let payload: unknown;
    try {
      payload = JSON.parse(messagePayload);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Message payload must be a JSON object.");
    } catch (reason) { setError(message(reason)); return; }
    setBusy("run"); setError(""); setOutputTab("output");
    try {
      const next = await api<ScriptResult>(`/scripts/messages/${encodeURIComponent(selected.name)}/request`, "POST", { payload, revision: publication!.revision });
      if (mounted.current) setResult(next);
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { if (mounted.current) setBusy(""); }
  };
  const cancelRun = async (runId: string) => {
    if (!gatewayAdmin || cancellingRun) return;
    setCancellingRun(runId); setError("");
    try {
      await api(`/scripts/events/runs/${encodeURIComponent(runId)}/cancel`, "POST", {});
      if (mounted.current) notify("Cancellation requested. Review the run result; completed side effects are not undone.");
    } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { if (mounted.current) setCancellingRun(""); }
  };
  const remove = () => {
    if (!selected || !draft || busy) return;
    setDraft({ ...draft, resources: draft.resources.filter(resource => resource.id !== selected.id) });
    setOpenIds(previous => previous.filter(value => value !== selected.id)); open(null, true);
  };
  const completions = useMemo<Completion[]>(() => browserScript ? [
    { label: "parameters", type: "variable", detail: "Declared browser event parameters" },
    { label: "event", type: "variable", detail: "type, screenId, screenName, revision" },
    { label: "session", type: "variable", detail: "Legacy script memory; separate from reactive app.state" },
    { label: "app.notify", type: "function", detail: "Show a message" },
    { label: "app.navigate", type: "function", detail: "Open a published screen by ID" },
    { label: "app.refresh", type: "function", detail: "Refresh runtime data" },
    { label: "app.sendMessage", type: "function", detail: "Send locally: (messageType, payload = {}, {scope: 'screen'}); session events use session scope" },
    { label: "app.state.get", type: "function", detail: "Read a declared session or screen state property" },
    { label: "app.state.set", type: "function", detail: "Update typed local state and its bindings" },
    { label: "app.state.reset", type: "function", detail: "Restore one property or a scope to declared defaults" },
    { label: "console.log", type: "function" },
    ...["const", "let", "if", "await"].map(label => ({ label, type: "keyword" })),
  ] : [...pythonCompletions, ...(draft?.resources.filter(resource => resource.type === "library").map(resource => ({ label: `project.${resource.name}`, type: "namespace", detail: "Published project library" })) ?? [])], [browserScript, draft?.resources]);
  const publishedLabel = publication?.published ? `Published r${publication.revision}` : "No script publication";

  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderScriptEditor() {
    return (<section className="script-editor-pane" aria-label="Script editor workspace">
      <div className="script-open-tabs" aria-label="Open scripts">{gatewayAdmin && <button className={selectedId === null ? "active" : ""} disabled={Boolean(busy)} onClick={() => open(null)}>Console</button>}{openIds.map(resourceId => {
        const resource = draft?.resources.find(item => item.id === resourceId);
        return resource && <button key={resourceId} className={selectedId === resourceId ? "active" : ""} disabled={Boolean(busy)} onClick={() => open(resource)}>{resource.name}{resource.type === "client" ? ".js" : ".py"}</button>;
      })}</div>
      {!gatewayAdmin && !selected ? <div className="projects-empty"><h2>Select a script resource</h2><p>Create or select a saved resource to edit its code. An administrator can execute draft Python code.</p></div> : <>
        <div className="script-document-heading"><span><strong>{selected?.name || "scratchpad"}{browserScript ? ".js" : ".py"}</strong><small>{selected?.type === "library" ? `Import as project.${selected.name}` : browserScript ? "Executes in each operator browser" : "Executes on the gateway"}</small></span><div>{!selected && <button className="button" disabled={Boolean(busy)} onClick={() => void save()}><Icon name="save" size={14} />Save console</button>}{gatewayAdmin && selected && !browserScript && <select aria-label="Script run source" disabled={Boolean(busy)} value={source} onChange={event => setSource(event.target.value as "draft" | "published")}><option value="draft">Saved draft</option><option value="published" disabled={!publication?.published}>Published</option></select>}{browserScript ? <a className="button" href={projectPage("runtime")} target="_blank" rel="noreferrer"><Icon name="monitor" size={14} />Test published runtime</a> : gatewayAdmin ? <button className="button primary" disabled={!canRun} onClick={() => void run()} title={selected && dirty ? "Save resources before running" : "Ctrl+Enter"}><Icon name="play" size={14} />{busy === "run" ? "Running…" : "Run"}</button> : <span className="project-note">Administrator required to run</span>}</div></div>
        <ScriptEditor key={selected?.id ?? "console"} value={currentCode} language={language} completions={completions} readOnly={Boolean(busy) || loading} onChange={value => selected ? edit({ code: value }) : setConsoleCode(value)} onRun={() => { void run(); }} onSave={() => { void save(); }} />
        <div className="script-output scripting-output"><div className="output-tabs"><button className={outputTab === "output" ? "active" : ""} onClick={() => setOutputTab("output")}>Output</button><button className={outputTab === "result" ? "active" : ""} onClick={() => setOutputTab("result")}>Result</button><button className={outputTab === "events" ? "active" : ""} onClick={() => setOutputTab("events")}>Gateway events</button><span>{busy === "run" ? "Running with the gateway timeout…" : result ? `${result.success ? "Completed" : "Failed"} · ${result.durationMs} ms` : ""}</span><button className="icon-button" aria-label="Clear script output" onClick={() => { setResult(null); setError(""); }}><Icon name="trash" size={14} /></button></div>
          {outputTab === "events" ? <div className="script-event-output">
            {monitorError && <p className="error-text">{monitorError}</p>}
            {status?.journalError && <p className="scripting-alert" role="alert">Run history could not be saved: {status.journalError}</p>}
            <h3>Gateway scheduler {status?.activeRevision == null ? "· Not active" : `· Revision ${status.activeRevision}`}</h3>
            {status?.resources.length ? <table className="script-event-table"><thead><tr><th>Event</th><th>Status</th><th>Last run</th><th>Next run</th><th>Runs</th></tr></thead><tbody>{status.resources.map(resource => <tr key={resource.id}><td>{resource.name}<br /><span className="muted">{resource.event}</span></td><td>{resource.running ? "Running" : resource.queued ? "Queued" : !resource.enabled ? "Disabled" : resource.lastSuccess === false ? "Last run failed" : "Ready"}{gatewayAdmin && resource.running && resource.currentRunId && <button className="button script-cancel-run" disabled={Boolean(cancellingRun)} onClick={() => void cancelRun(resource.currentRunId!)}>{cancellingRun === resource.currentRunId ? "Cancelling…" : "Cancel run"}</button>}</td><td>{time(resource.lastRunAt)}</td><td>{time(resource.nextRunAt)}</td><td>{resource.executionCount ?? "—"}{Boolean(resource.missedEvents) && <small>{resource.missedEvents} missed events</small>}</td></tr>)}</tbody></table> : <p>No published gateway events.</p>}
            <h3>Recent runs · Latest 100 retained across gateway restarts</h3>
            {!logs.length && <p>No resource runs recorded yet.</p>}
            {logs.map(log => <details className="script-event-run" key={log.runId}><summary><span>{log.name} · {log.event}</span><span className={log.status === "failed" ? "error-text" : ""}>{log.status} · {time(log.startedAt)}</span></summary><p>{log.source} r{log.revision} · {log.durationMs} ms</p>{gatewayAdmin && log.status === "running" && <button className="button script-cancel-run" disabled={Boolean(cancellingRun)} onClick={() => void cancelRun(log.runId)}>{cancellingRun === log.runId ? "Cancelling…" : "Cancel run"}</button>}<pre>{log.stdout}{log.stderr}</pre>{log.result !== undefined && <pre>{JSON.stringify(log.result, null, 2)}</pre>}{log.resultTruncated && <p>Result truncated by the gateway log limit.</p>}</details>)}
          </div> : <pre className={`console ${result && !result.success ? "error-text" : ""}`}>{busy === "run" ? "Executing saved code on the gateway…" : outputTab === "result" ? result ? JSON.stringify(result.result ?? null, null, 2) : "Return a value through result to inspect it here." : result ? `${result.stdout || ""}${result.stderr || ""}` || "Completed without console output." : browserScript ? "Browser events run in the published operator runtime. Their output is separate from gateway Python runs." : "Ctrl+Enter runs the saved resource or console. Python workers have a bounded execution time."}</pre>}
        </div>
      </>}
    </section>);
  }

  function renderScriptProperties() {
    return (<aside className="script-properties" aria-label="Script properties"><fieldset disabled={Boolean(busy) || loading}>
      {selected ? <><h2>Resource settings</h2>
        <label>Name<input aria-label="Script resource name" value={selected.name} maxLength={selected.type === "library" ? 64 : 100} onChange={event => edit({ name: event.target.value })} /></label>
        <p className="script-property-note">{selected.type === "library" ? "Use one Python identifier. Module names form the published project namespace." : selected.event === "message" ? "This unique resource name is the published message handler name." : "Names identify events in the resource tree and diagnostics."}</p>
        <label className="script-enabled-setting"><input type="checkbox" checked={selected.enabled} onChange={event => edit({ enabled: event.target.checked })} />Enabled after publication</label>
        {selected.type !== "library" && <label>Event<select aria-label="Script event" value={selected.event || "startup"} onChange={event => changeEvent(event.target.value as ScriptResource["event"])}>{selected.type === "gateway" ? gatewayEvents.map(item => <option key={item.event} value={item.event}>{item.title}</option>) : <><option value="startup">Startup</option><option value="screenOpen">Screen open</option></>}</select></label>}
        {selected.type === "gateway" && <div className="script-gateway-settings">
          <p className="script-property-note">{gatewayEvents.find(item => item.event === (selected.event ?? "startup"))?.description}</p>
          <label>Execution timeout (milliseconds)<input aria-label="Gateway event timeout" type="number" min={100} max={300000} step={1} value={selected.timeoutMs ?? 10000} onChange={event => edit({ timeoutMs: Number(event.target.value) })} /></label>
          <label>Execution lane<select aria-label="Gateway event threading" value={selected.threading ?? "dedicated"} onChange={event => edit({ threading: event.target.value as ScriptResource["threading"] })}><option value="dedicated">Dedicated to this resource</option><option value="shared">Shared within this project</option></select></label>
          <p className="script-property-note">Dedicated resources can run independently. Shared resources wait for the project's shared lane. Execution never overlaps the same resource.</p>
          {selected.event === "timer" && <>
            <label>Interval (milliseconds)<input aria-label="Gateway timer interval" type="number" min={100} max={86400000} step={1} value={selected.intervalMs ?? 1000} onChange={event => edit({ intervalMs: Number(event.target.value) })} /></label>
            <label>Timing<select aria-label="Gateway timer delay type" value={selected.delayType ?? "fixedDelay"} onChange={event => edit({ delayType: event.target.value as ScriptResource["delayType"] })}><option value="fixedDelay">Fixed delay after completion</option><option value="fixedRate">Fixed rate, skip missed intervals</option></select></label>
          </>}
          {selected.event === "tagChange" && <>
            <label>Tag paths, one per line<textarea aria-label="Gateway event tag paths" rows={5} spellCheck={false} value={(selected.tagPaths ?? []).join("\n")} onChange={event => edit({ tagPaths: event.target.value.split(/\r?\n/) })} /></label>
            <p className="script-property-note">Use 1–64 unique paths such as [default]Line/Speed. A terminal folder/* watches that folder. Configure the tags separately.</p>
            <div className="script-trigger-options" role="group" aria-label="Tag change triggers"><span>Trigger on</span>{(["value", "quality", "timestamp"] as const).map(trigger => <label key={trigger} className="script-enabled-setting"><input type="checkbox" checked={(selected.changeTriggers ?? ["value"]).includes(trigger)} onChange={event => {
              const existing = selected.changeTriggers ?? ["value"];
              edit({ changeTriggers: event.target.checked ? [...existing, trigger] : existing.filter(item => item !== trigger) });
            }} />{trigger.charAt(0).toUpperCase() + trigger.slice(1)}</label>)}</div>
          </>}
          {selected.event === "scheduled" && <>
            <label>Cron schedule<input aria-label="Gateway event cron schedule" value={selected.cron ?? ""} spellCheck={false} placeholder="*/5 * * * *" onChange={event => edit({ cron: event.target.value })} /></label>
            <p className="script-property-note">Minute · hour · day of month · month · day of week. Example: 0 2 * * * runs daily at 02:00.</p>
            <label>Time zone<input aria-label="Gateway event time zone" value={selected.timeZone ?? ""} spellCheck={false} placeholder="Gateway local time zone" onChange={event => edit({ timeZone: event.target.value || undefined })} /></label>
            <p className="script-property-note">Use UTC or a gateway-supported time zone ID. An omitted zone uses the gateway's local zone; new schedules start with UTC.</p>
          </>}
          {selected.event === "message" && <>
            <label>Required permission<select aria-label="Message handler permission" value={selected.requiredPermission ?? "operate"} onChange={event => edit({ requiredPermission: event.target.value as ScriptResource["requiredPermission"] })}><option value="operate">Project Operate</option><option value="admin">Gateway administrator</option></select></label>
            {gatewayAdmin && <div className="script-message-test"><h2>Test published handler</h2><label>JSON payload<textarea aria-label="Message test payload" rows={6} spellCheck={false} value={messagePayload} onChange={event => setMessagePayload(event.target.value)} /></label><button className="button" disabled={!canTestMessage} onClick={() => void testMessage()}><Icon name="play" size={14} />Send test request</button><p className="script-property-note">Save and publish this enabled handler first. This request executes the published code, with the payload above. Unsaved edits are never sent.</p></div>}
          </>}
        </div>}
        <label>Declared parameter defaults<textarea aria-label="Script parameter defaults" spellCheck={false} rows={7} value={defaultText} onChange={event => {
          const text = event.target.value; setDefaultText(text);
          try { edit({ parameters: parseParameters(text) }); setDefaultError(""); }
          catch (reason) { setDefaultError(message(reason)); }
        }} /></label>{defaultError && <p className="error-text" role="alert">{defaultError}</p>}<p className="script-property-note">JSON scalar values only. Run overrides must match these declared names and types.</p><button className="button script-remove" onClick={() => setConfirm("delete")}><Icon name="trash" size={14} />Remove resource</button></> : gatewayAdmin ? <><h2>Console</h2><p>The console is a Python experiment. Save console stores it in this browser; it is separate from published script resources.</p></> : <p>Select a script resource to edit its settings.</p>}
      {gatewayAdmin && !browserScript && <><h2>Run parameters</h2><textarea aria-label="Script run parameters" spellCheck={false} rows={7} value={runParameterText} onChange={event => setRunParameterText(event.target.value)} /><p className="script-property-note">Passed to Python as <code>parameters</code>. Resource runs use saved code; save your edits first.</p></>}
      <h2>{browserScript ? "Browser scope" : "Gateway scope"}</h2><p>{browserScript ? "JavaScript receives event, parameters, session and app. app.notify(message), app.navigate(screenId) and app.refresh() act in this runtime tab. Gateway Python APIs are not available." : "Python executes with the gateway account’s OS access. Only trusted local authors should use this workspace; worker processes are not a security sandbox."}</p>
      {browserScript && <><p className="script-property-note"><code>app.state.get("session", "name")</code> reads a declared property. <code>app.state.set(scope, name, value)</code> updates bindings. <code>app.state.reset(scope, name)</code> restores its default; omit the name to reset the scope. Use <code>"session"</code> for this tab or <code>"screen"</code> for the active screen. Values must match their declared types.</p><p className="script-property-note">The existing <code>session</code> object remains separate script memory; assignments to it do not update bindings. Browser scripts are trusted same-origin JavaScript, not sandboxed code. Application state is local to this browser and is not an authorization source.</p></>}
      {selected?.type === "gateway" && <p className="script-property-note">Python receives <code>event</code> as a dictionary with attribute access: type, reason, timestamp, actor, resources and executionCount. Tag events add tagPath, initialChange, previousValue, newValue, changes and missedEvents. Message requests add <code>payload</code>.</p>}
      <p className="script-property-note">Nested library packages, a debugger and durable job delivery remain planned. Completion hints are not a full language server.</p>
    </fieldset></aside>);
  }

  return <div className="management-page scripting-workspace" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); }
  }}>
    {publishReview && draft && <ApplicationPublishDialog scriptsRevision={draft.revision} onClose={() => setPublishReview(false)} onPublished={published => { setPublication({ published: true, revision: published.scriptsRevision, publishedAt: published.publishedAt, draftRevision: draft.revision }); setPublishReview(false); notify(`Application revision ${published.revision} published with scripts revision ${published.scriptsRevision}.`); }} />}
    <div className="page-heading">
      <div><div className="eyebrow">APPLICATION LOGIC</div><h1>Scripting</h1><p>Reusable Python libraries, gateway automation and browser JavaScript events.</p></div>
      <div className="page-heading-actions">
        <button className="button" disabled={Boolean(busy) || loading} onClick={() => dirty || defaultError ? setConfirm("reload") : void load()}><Icon name="refresh" size={15} /> Reload</button>
        <button className="button" disabled={!draft || Boolean(busy) || !dirty || Boolean(defaultError)} onClick={() => void saveResources()}><Icon name="save" size={15} />{busy === "save" ? "Saving…" : "Save resources"}</button>
        <button className="button primary" title={!permissions.publish ? "Your account needs publish permission for this project" : undefined} disabled={!permissions.publish || !draft || dirty || Boolean(defaultError) || Boolean(busy)} onClick={() => void publish()}><Icon name="play" size={15} />{busy === "publish" ? "Publishing…" : "Publish application"}</button>
      </div>
    </div>
    <div className="scripting-statebar"><span>{draft ? `Saved draft r${draft.revision}${dirty ? " · Unsaved changes" : ""}` : "Loading resources…"}</span><span>{publishedLabel}</span><span className={pythonAvailable ? "" : "error-text"}>{pythonAvailable ? "CPython available" : "CPython unavailable"}</span></div>
    {error && <div className="scripting-alert" role="alert">{error}</div>}
    {confirm && <div className="scripting-confirm" role="alert"><span>{confirm === "reload" ? "Reload replaces unsaved script edits with the saved gateway resources." : `Remove “${selected?.name}” from this draft? Save and publish to change active resources.`}</span><button className="button" onClick={() => setConfirm("")}>Cancel</button><button className="button" onClick={() => confirm === "reload" ? void load() : remove()}>{confirm === "reload" ? "Reload saved resources" : "Remove resource"}</button></div>}
    <div className="scripting-grid">
      <nav className="script-resource-tree" aria-label="Script resources">
        {scopes.map(scope => <section key={scope.type}>
          <div className="script-tree-heading"><span><Icon name={scope.icon} size={14} />{scope.name}</span><button className="icon-button" aria-label={`Add ${scope.type === "library" ? "library" : scope.type === "gateway" ? "gateway event" : "browser event"}`} disabled={!draft || Boolean(busy) || draft.resources.length >= 100} onClick={() => add(scope.type)}><Icon name="plus" size={14} /></button></div>
          {draft?.resources.filter(resource => resource.type === scope.type).map(resource => <button key={resource.id} className={`script-resource-item ${selectedId === resource.id ? "active" : ""}`} aria-current={selectedId === resource.id ? "page" : undefined} disabled={Boolean(busy)} onClick={() => open(resource)}><Icon name="code" size={14} /><span>{resource.name}<small>{resource.type === "library" ? "Python module" : `${resource.event} · ${resource.type === "client" ? "JavaScript" : "Python"}`}</small></span><i className={resource.enabled ? "script-enabled-dot" : "script-disabled-dot"} title={resource.enabled ? "Enabled after publication" : "Disabled"} /></button>)}
          {!draft?.resources.some(resource => resource.type === scope.type) && <p className="script-tree-empty">No resources yet</p>}
        </section>)}
        {gatewayAdmin && <button className={`script-resource-item console-resource ${selectedId === null ? "active" : ""}`} disabled={Boolean(busy)} onClick={() => open(null)}><Icon name="code" size={15} /><span>Console<small>Local Python scratchpad</small></span></button>}
        <p className="script-tree-note">Save updates script drafts. Publish application reviews and activates saved screens, queries, libraries and events together.</p>
      </nav>
      {renderScriptEditor()}
      {renderScriptProperties()}
    </div>
  </div>;
}
