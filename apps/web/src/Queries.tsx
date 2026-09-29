import { useCallback, useEffect, useRef, useState } from "react";
import { api, displayValue, id } from "./api";
import { Field } from "./App";
import Icon from "./Icon";
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
}) {
  const [selectedId, setSelectedId] = useState(queries[0]?.id || "");
  const [draft, setDraft] = useState<NamedQuery | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResult | number | null>(null);
  const [error, setError] = useState("");
  const [parameterValues, setParameterValues] =
    useState<RuntimeParameters>(parameters);
  const selected = queries.find((query) => query.id === selectedId);
  const current = draft || selected;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(selected);
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
    setResult(null);
    setError("");
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
  const sqlConnections = connections.filter(
    (connection) =>
      connection.type === "sqlserver" || connection.type === "sqlite" || connection.id === "sample",
  );
  const edit = (patch: Partial<NamedQuery>) => {
    if (current) setDraft({ ...current, ...patch });
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
    if (!current || draft || current.kind === "update" && !canRunUpdates) return;
    setBusy(true);
    setError("");
    const typedValues: Record<string, unknown> = {};
    for (const parameter of current.parameters) {
      const raw = parameterValues[parameter.name] ?? parameter.defaultValue;
      typedValues[parameter.name] =
        parameter.type.toLowerCase().includes("int") ||
        parameter.type.toLowerCase().includes("float") ||
        parameter.type.toLowerCase().includes("double") ||
        parameter.type.toLowerCase().includes("number")
          ? Number(raw)
          : raw;
    }
    try {
      setResult(
        await api<QueryResult | number>(
          `/queries/${encodeURIComponent(current.id)}/execute`,
          "POST",
          { parameters: typedValues },
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setResult(null);
    } finally {
      setBusy(false);
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
            setDraft({
              id: id("query"),
              name: "New query",
              connectionId: sqlConnections[0]?.id || "",
              sql: sqlConnections[0]?.type === "sqlite" ? "SELECT * FROM production_records LIMIT 100" : "SELECT TOP (100) *\nFROM dbo.YourTable\nWHERE Line = @line",
              parameters: sqlConnections[0]?.type === "sqlite" ? [] : [
                { name: "line", type: "string", defaultValue: "Line1" },
              ],
            });
            setSelectedId("");
            setResult(null);
            setError("");
          }}
        >
          <Icon name="plus" size={16} />
          New query
        </button>
      </div>
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
                  {draft && <button className="button" disabled={busy} onClick={() => { setDraft(null); setResult(null); setError(""); }}>Discard changes</button>}
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
                    onChange={(event) =>
                      edit({ connectionId: event.target.value })
                    }
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
              <div className="code-editor-heading">
                <span>
                  <Icon name="code" size={14} />
                  QUERY
                </span>
                <label>Result type <select aria-label="Query result type" value={current.kind || "query"} onChange={event => edit({ kind: event.target.value as "query" | "update" })}><option value="query">Rows (SELECT)</option><option value="update">Affected rows (INSERT / UPDATE / DELETE)</option></select></label>
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
