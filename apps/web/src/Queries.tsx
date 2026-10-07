import { useCallback, useEffect, useRef, useState } from "react";
import { api, displayValue, id } from "./api";
import { Field } from "./App";
import Icon from "./Icon";
import { QueryConnectorNotice } from "./DatabaseConnectorFields";
import { loadDatabaseConnectors, namedQuerySeed, queryUpdatesSupported, selectQueryConnection, isNamedQueryConnection, type DatabaseConnectorDescriptor } from "./databaseConnectors";
import { prepareQueryTestParameters } from "./queryTestParameters";
import type { Connection, NamedQuery, QueryResult, RuntimeParameters } from "./types";

export default function Queries({
  queries,
  connections,
  onChange,
  parameters,
  notify,
  onDirtyChange,
  navigationRequest,
  onNavigationHandled,
  onSearchResources,
  canRunUpdates = true,
  externalRefresh,
}: {
  queries: NamedQuery[];
  connections: Connection[];
  onChange: (queries: NamedQuery[]) => void;
  parameters: RuntimeParameters;
  notify: (message: string, error?: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  navigationRequest?: { id: string; token: number };
  onNavigationHandled?: (token: number) => void;
  onSearchResources?: (resources: NamedQuery[]) => void;
  canRunUpdates?: boolean;
  externalRefresh?: NamedQuery[] | null;
}) {
  const [catalog, setCatalog] = useState<DatabaseConnectorDescriptor[]>([]);
  useEffect(() => {
    let active = true;
    loadDatabaseConnectors().then(items => { if (active) setCatalog(items); });
    return () => { active = false; };
  }, []);
  const [selectedId, setSelectedId] = useState(queries[0]?.id || "");
  const [draft, setDraft] = useState<NamedQuery | null>(null);
  const draftBase = useRef<NamedQuery | null>(null);
  const [externalNotice, setExternalNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResult | number | null>(null);
  const [error, setError] = useState("");
  const [testDeadline, setTestDeadline] = useState(15_000);
  const [runNotice, setRunNotice] = useState("");
  const activeRun = useRef<{ controller: AbortController | null } | null>(null);
  useEffect(() => () => { activeRun.current?.controller?.abort(); activeRun.current = null; }, []);
  const [parameterValues, setParameterValues] =
    useState<RuntimeParameters>(parameters);
  const selected = queries.find((query) => query.id === selectedId);
  const current = draft || selected;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftBase.current);
  const handledRefresh = useRef<NamedQuery[] | null>(null);
  useEffect(() => {
    if (!externalRefresh || handledRefresh.current === externalRefresh) return;
    handledRefresh.current = externalRefresh;
    if (dirty) {
      setExternalNotice("Ask Spark changed saved queries. Your unsaved query text is retained; discard it to load the saved version.");
      return;
    }
    setDraft(null); setResult(null); setError(""); setExternalNotice("");
    setSelectedId(previous => externalRefresh.some(query => query.id === previous) ? previous : externalRefresh[0]?.id || "");
  }, [externalRefresh, dirty]);
  const handledNavigation = useRef<number | null>(null);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!onSearchResources) return;
    onSearchResources(draft
      ? queries.some(query => query.id === draft.id)
        ? queries.map(query => query.id === draft.id ? draft : query)
        : [...queries, draft]
      : queries);
  }, [queries, draft, onSearchResources]);
  const openQuery = useCallback((queryId: string) => {
    if (current?.id === queryId) return;
    if (dirty) { notify("Save or discard the current query's changes before opening another query.", true); return; }
    if (!queries.some(query => query.id === queryId)) { notify("This named query is no longer available.", true); return; }
    setSelectedId(queryId);
    setDraft(null);
    setExternalNotice("");
    setResult(null);
    setError("");
    setRunNotice("");
  }, [current?.id, dirty, queries, notify]);
  useEffect(() => {
    if (!navigationRequest || handledNavigation.current === navigationRequest.token || busy) return;
    handledNavigation.current = navigationRequest.token;
    openQuery(navigationRequest.id);
    onNavigationHandled?.(navigationRequest.token);
  }, [navigationRequest, busy, openQuery, onNavigationHandled]);
  useEffect(() => {
    if (onDirtyChange) return;
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, onDirtyChange]);
  const sqlConnections = connections.filter(connection => isNamedQueryConnection(connection, catalog));
  const edit = (patch: Partial<NamedQuery>) => {
    if (current && !busy) {
      if (!draft) draftBase.current = selected ?? null;
      setDraft({ ...current, ...patch });
    }
  };
  const save = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const saved = await api<NamedQuery>(
        `/queries/${encodeURIComponent(current.id)}`,
        "PUT",
        current,
      );
      onChange([...queries.filter((query) => query.id !== saved.id), saved]);
      setSelectedId(saved.id);
      setDraft(null);
      setExternalNotice("");
      notify("Named query saved.");
      return saved;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!current || busy || draft || current.kind === "update" && !canRunUpdates) return;
    let typedValues: Record<string, unknown>;
    try { typedValues = prepareQueryTestParameters(current.parameters, parameterValues); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setResult(null); setRunNotice(""); return; }
    const execution = { controller: current.kind === "update" ? null : new AbortController() };
    activeRun.current = execution;
    setBusy(true);
    setError("");
    setRunNotice("");
    setResult(null);
    try {
      const response = await api<QueryResult | number>(
          `/queries/${encodeURIComponent(current.id)}/execute`,
          "POST",
          { parameters: typedValues, ...(execution.controller ? { timeoutMs: testDeadline } : {}) },
          execution.controller?.signal,
        );
      if (activeRun.current === execution && !execution.controller?.signal.aborted) setResult(response);
    } catch (reason) {
      if (activeRun.current !== execution) return;
      if (execution.controller?.signal.aborted) setRunNotice("Cancellation requested. No result was applied. The gateway was asked to stop this read query.");
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (activeRun.current === execution) { activeRun.current = null; setBusy(false); }
    }
  };
  return (
    <div className="management-page queries-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REUSABLE DATA ACCESS</div>
          <h1>Named queries</h1>
          <p>
            Write a query once. Use its results across your screens and scripts.
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            if (dirty) { notify("Save or discard the current query's changes before creating another query.", true); return; }
            draftBase.current = null;
            setDraft({ id: id("query"), name: "New query", ...namedQuerySeed(connections, catalog) });
            setSelectedId("");
            setResult(null);
            setError("");
          }}
        >
          <Icon name="plus" size={16} />
          New query
        </button>
      </div>
      <p role="status" hidden={!externalNotice}>{externalNotice}</p>
      <div className="management-columns">
        <aside className="resource-list">
          <div className="section-heading">
            <span>QUERIES</span>
            <span className="count-pill">{queries.length}</span>
          </div>
          {queries.map((query) => (
            <button
              className={`resource-item ${query.id === selectedId ? "active" : ""}`}
              key={query.id}
              disabled={busy}
              onClick={() => openQuery(query.id)}
            >
              <span className="resource-icon">
                <Icon name="database" size={18} />
              </span>
              <span>
                <strong>{query.name}</strong>
                <small>
                  {connections.find(
                    (connection) => connection.id === query.connectionId,
                  )?.name || query.connectionId}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <section className="resource-editor query-editor">
          {!current ? (
            <div className="large-empty">
              <Icon name="database" size={42} />
              <h2>Give your data a name</h2>
              <p>
                Create a parameterized query to start connecting your screens.
              </p>
            </div>
          ) : (
            <>
              <div className="resource-editor-heading">
                <div>
                  <Icon name="database" size={22} />
                  <div>
                    <h2>{current.name}</h2>
                    <span>
                      {draft ? "Unsaved changes" : "Saved named query"}
                    </span>
                  </div>
                </div>
                <div className="editor-actions">
                  {current.kind !== "update" && <label>Read deadline <select aria-label="Read-query test deadline" value={testDeadline} disabled={busy} onChange={event => setTestDeadline(Number(event.target.value))}>{[1000, 5000, 15000, 30000].map(value => <option key={value} value={value}>{value / 1000} seconds</option>)}</select></label>}
                  {busy && activeRun.current?.controller && <button className="button" onClick={() => activeRun.current?.controller?.abort()}>Cancel read query</button>}
                  {draft && <button className="button" disabled={busy} onClick={() => { setDraft(null); setResult(null); setError(""); setExternalNotice(""); }}>Discard changes</button>}
                  <button
                    className="button"
                    disabled={busy || !draft}
                    onClick={() => void save()}
                  >
                    <Icon name="save" size={15} />
                    Save query
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || Boolean(draft) || current.kind === "update" && !canRunUpdates}
                    title={current.kind === "update" && !canRunUpdates ? "Gateway administrator permission is required to execute draft updates." : undefined}
                    onClick={() => void run()}
                  >
                    <Icon name="play" size={15} />
                    {busy ? "Working…" : current.kind === "update" ? "Execute update" : "Run query"}
                  </button>
                </div>
              </div>
              <div className="query-settings form-two-col">
                <Field label="Query name">
                  <input
                    value={current.name}
                    onChange={(event) => edit({ name: event.target.value })}
                  />
                </Field>
                <Field label="Connection">
                  <select
                    value={current.connectionId}
                    onChange={event => edit(selectQueryConnection(current, event.target.value, connections, catalog))}
                  >
                    <option value="">Choose connection…</option>
                    {sqlConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <QueryConnectorNotice connectionId={current.connectionId} connections={connections} catalog={catalog} />
              <div className="code-editor-heading">
                <span>
                  <Icon name="code" size={14} />
                  QUERY
                </span>
                <label>Result type <select aria-label="Query result type" value={current.kind || "query"} onChange={event => edit({ kind: event.target.value as "query" | "update" })}><option value="query">Rows (SELECT)</option><option value="update" disabled={!queryUpdatesSupported(current.connectionId, connections, catalog)}>Affected rows (INSERT / UPDATE / DELETE)</option></select></label>
              </div>
              <div className="code-editor">
                <div className="line-numbers">
                  {current.sql.split("\n").map((_, index) => (
                    <span key={index}>{index + 1}</span>
                  ))}
                </div>
                <textarea
                  spellCheck={false}
                  aria-label="SQL query"
                  value={current.sql}
                  onChange={(event) => edit({ sql: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Tab") {
                      event.preventDefault();
                      const input = event.currentTarget;
                      const start = input.selectionStart;
                      edit({
                        sql:
                          current.sql.slice(0, start) +
                          "  " +
                          current.sql.slice(input.selectionEnd),
                      });
                      requestAnimationFrame(() => {
                        input.selectionStart = input.selectionEnd = start + 2;
                      });
                    }
                  }}
                />
              </div>
              <div className="query-parameters">
                <div className="browse-section-heading">
                  <div>
                    <h3>Parameters</h3>
                    <p>
                      Use <code>@name</code> in SQL. Values are bound separately
                      from query text.
                    </p>
                  </div>
                  <button
                    className="button small"
                    onClick={() =>
                      edit({
                        parameters: [
                          ...current.parameters,
                          {
                            name: `parameter${current.parameters.length + 1}`,
                            type: "string",
                            defaultValue: "",
                          },
                        ],
                      })
                    }
                  >
                    <Icon name="plus" size={13} />
                    Add parameter
                  </button>
                </div>
                {current.parameters.map((parameter, index) => (
                  <div className="parameter-row" key={index}>
                    <Field label="Name">
                      <input
                        value={parameter.name}
                        onChange={(event) =>
                          edit({
                            parameters: current.parameters.map(
                              (item, position) =>
                                position === index
                                  ? { ...item, name: event.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="Type">
                      <select
                        value={parameter.type}
                        onChange={(event) =>
                          edit({
                            parameters: current.parameters.map(
                              (item, position) =>
                                position === index
                                  ? { ...item, type: event.target.value }
                                  : item,
                            ),
                          })
                        }
                      >
                        <option value="string">Text</option>
                        <option value="int">Integer</option>
                        <option value="float">Decimal</option>
                      </select>
                    </Field>
                    <Field label="Default value">
                      <input
                        value={parameter.defaultValue ?? ""}
                        onChange={(event) =>
                          edit({
                            parameters: current.parameters.map(
                              (item, position) =>
                                position === index
                                  ? {
                                      ...item,
                                      defaultValue: event.target.value,
                                    }
                                  : item,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="Test value">
                      <input
                        value={
                          String(parameterValues[parameter.name] ?? parameter.defaultValue ?? "")
                        }
                        onChange={(event) =>
                          setParameterValues((previous) => ({
                            ...previous,
                            [parameter.name]: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <button
                      className="icon-button"
                      title="Remove parameter"
                      onClick={() =>
                        edit({
                          parameters: current.parameters.filter(
                            (_, position) => position !== index,
                          ),
                        })
                      }
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ))}
                {!current.parameters.length && (
                  <p className="muted">This query has no parameters.</p>
                )}
              </div>
              <div className="query-results">
                {runNotice && <div className="info-banner" role="status">{runNotice}</div>}
                <div className="code-editor-heading">
                  <span>
                    <Icon name="table" size={14} />
                    RESULTS
                  </span>
                  <span>
                    {typeof result === "number" ? `${result} ROWS AFFECTED` : result
                      ? `${result.rows.length} ROWS · ${result.durationMs} MS`
                      : "RUN QUERY TO PREVIEW"}
                  </span>
                </div>
                {error ? (
                  <div className="inline-error">{error}</div>
                ) : typeof result === "number" ? <div className="info-banner">Update completed. {result} row(s) affected.</div> : result ? (
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          {result.columns.map((column) => (
                            <th key={column}>{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, index) => (
                          <tr key={index}>
                            {result.columns.map((column) => (
                              <td key={column}>{displayValue(row[column])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!result.rows.length && (
                      <div className="widget-empty">
                        Query succeeded with no rows.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="query-results-empty">
                    <Icon name="table" size={25} />
                    <p>
                      {draft
                        ? "Save your changes, then run the query."
                        : "Run your query to inspect the results."}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
