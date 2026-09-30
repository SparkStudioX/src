import { useCallback, useEffect, useMemo, useState } from "react";
import { api, displayValue } from "./api";
import { Field } from "./App";
import Icon from "./Icon";
import TagTransfer from "./TagTransfer";
import TagModels from "./TagModels";
import type { Connection, Tag, TagDefinition } from "./types";

const dataTypes = [
  "Boolean",
  "Int16",
  "Int32",
  "Int64",
  "UInt16",
  "UInt32",
  "Float",
  "Double",
  "String",
];
const cleanPath = (path: string) => path.replace(/^\[[^\]]+\]/, "");
const folderOf = (path: string) =>
  cleanPath(path).split("/").slice(0, -1).join("/");

export default function Tags({
  connections,
  tags,
  onTagsChanged,
  notify,
}: {
  connections: Connection[];
  tags: Tag[];
  onTagsChanged: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [definitions, setDefinitions] = useState<TagDefinition[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [draft, setDraft] = useState<TagDefinition | null>(null);
  const [valueText, setValueText] = useState("0");
  const [folder, setFolder] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [models, setModels] = useState(false);
  const [scanGroups, setScanGroups] = useState<{ name: string; publishingIntervalMs: number; enabled?: boolean }[]>([]);
  const [inputsText, setInputsText] = useState("{}");
  const selected = definitions.find(
    (definition) => definition.path === selectedPath,
  );
  const current = draft || selected;
  const opcConnections = connections.filter(
    (connection) => connection.type === "opcua",
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [configured, model] = await Promise.all([api<TagDefinition[]>("/tag-definitions"), api<{ scanGroups: { name: string; publishingIntervalMs: number; enabled?: boolean }[] }>("/tag-engineering/export")]);
      setDefinitions(configured); setScanGroups(model.scanGroups);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const folders = useMemo(() => {
    const found = new Set<string>();
    for (const definition of definitions) {
      const parts = folderOf(definition.path).split("/").filter(Boolean);
      for (let depth = 1; depth <= parts.length; depth++)
        found.add(parts.slice(0, depth).join("/"));
    }
    return [...found].sort((left, right) => left.localeCompare(right));
  }, [definitions]);
  const visible = useMemo(() => definitions.filter(
    (definition) =>
      (!folder ||
        folderOf(definition.path) === folder ||
        folderOf(definition.path).startsWith(folder + "/")) &&
      definition.path.toLowerCase().includes(filter.toLowerCase()),
  ), [definitions, folder, filter]);
  const liveByPath = useMemo(() => new Map(tags.map(tag => [tag.path, tag])), [tags]);
  const pageSize = 100, pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => setPage(0), [folder, filter]);
  const edit = (patch: Partial<TagDefinition>) => {
    if (current) setDraft({ ...current, ...patch });
  };
  const select = (definition: TagDefinition) => {
    setSelectedPath(definition.path);
    setDraft(null);
    setValueText(
      JSON.stringify(
        definition.value ??
          (definition.dataType === "String"
            ? ""
            : definition.dataType === "Boolean"
              ? false
              : 0),
      ),
    );
    setDeleteConfirm(false);
    setInputsText(JSON.stringify(definition.inputs ?? {}, null, 2));
  };
  const add = (kind: "memory" | "opcua" | "expression") => {
    setSelectedPath("");
    setDeleteConfirm(false);
    setValueText("0");
    setInputsText('{"speed": "[default]Line/Line1/Speed"}');
    setDraft({
      path: `[default]${folder ? folder + "/" : ""}NewTag`,
      kind,
      dataType: "Double",
      enabled: true,
      publishingIntervalMs: 1000,
      ...(kind === "memory"
        ? { value: 0 }
        : kind === "expression" ? { expression: "speed * 0.5", inputs: { speed: "[default]Line/Line1/Speed" } }
        : { connectionId: opcConnections[0]?.id || "", nodeId: "" }),
    });
  };
  const save = async () => {
    if (!current) return;
    try {
      if (
        !/^\[[^\]]+\][^/][^\r\n]*$/.test(current.path) ||
        current.path.endsWith("/") ||
        current.path.includes("//")
      )
        throw new Error(
          "Enter a tag path such as [default]Production/Line1/Speed.",
        );
      const interval = current.publishingIntervalMs ?? 1000;
      if (!Number.isInteger(interval) || interval < 100 || interval > 60000)
        throw new Error(
          "The publishing interval must be between 100 and 60,000 milliseconds.",
        );
      if (current.kind === "opcua" && (!Number.isFinite(current.absoluteDeadband ?? 0) || (current.absoluteDeadband ?? 0) < 0 || !Number.isInteger(current.queueSize ?? 16) || (current.queueSize ?? 16) < 1 || (current.queueSize ?? 16) > 1000)) throw new Error("OPC UA deadband must be nonnegative; monitored queue size must be 1–1,000.");
      const next: TagDefinition = {
        ...current,
        kind: current.kind || "opcua",
        publishingIntervalMs: interval,
        enabled: current.enabled !== false,
      };
      if (next.kind === "memory") {
        let value: unknown;
        try {
          value = JSON.parse(valueText);
        } catch {
          throw new Error('Enter a JSON value: 42, true, or "text".');
        }
        if (
          next.dataType === "String"
            ? typeof value !== "string"
            : next.dataType === "Boolean"
              ? typeof value !== "boolean"
              : typeof value !== "number" || !Number.isFinite(value)
        )
          throw new Error(
            `The initial value must match the ${next.dataType} data type.`,
          );
        if (/^(?:U?Int)/.test(next.dataType) && !Number.isInteger(value))
          throw new Error("Integer tags require a whole-number value.");
        if (/^(?:U?Int)/.test(next.dataType) && Number.isInteger(value) && !Number.isSafeInteger(value))
          throw new Error("This integer exceeds the browser’s exact-number range. Use a value between −9,007,199,254,740,991 and 9,007,199,254,740,991.");
        next.value = value;
        delete next.connectionId;
        delete next.nodeId;
      } else if (next.kind === "expression") {
        next.inputs = JSON.parse(inputsText) as Record<string, string>;
        if (!next.inputs || typeof next.inputs !== "object" || Array.isArray(next.inputs)) throw new Error("Inputs must be an object mapping names to tag paths.");
        if (!next.expression?.trim()) throw new Error("Enter an expression using your input names.");
        delete next.value; delete next.connectionId; delete next.nodeId;
      } else {
        if (!next.connectionId || !next.nodeId?.trim())
          throw new Error(
            "Choose an OPC UA connection and enter its variable node ID.",
          );
        delete next.value;
      }
      setBusy(true);
      await api("/tags", "POST", next);
      await reload();
      setSelectedPath(next.path);
      setDraft(null);
      onTagsChanged();
      notify(
        "Tag saved. Live values are available in the Designer and operator application.",
      );
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(
        `/tag-definitions?path=${encodeURIComponent(selected.path)}`,
        "DELETE",
      );
      setDefinitions((previous) =>
        previous.filter((definition) => definition.path !== selected.path),
      );
      setSelectedPath("");
      setDraft(null);
      setDeleteConfirm(false);
      onTagsChanged();
      notify(
        "Tag deleted. Any screen using this path will show a missing binding.",
      );
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), true);
    } finally {
      setBusy(false);
    }
  };
  const live = current
    ? liveByPath.get(current.path)
    : undefined;

  return (
    <div className="management-page tags-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A SHARED MODEL OF YOUR PROCESS</div>
          <h1>Tags</h1>
          <p>
            Organize live variables and memory values into reusable application
            data.
          </p>
        </div>
        <div className="page-heading-actions">
          <button className="button" onClick={() => setModels(true)}>UDTs / scan groups</button>
          <button className="button" onClick={() => setTransfer(true)}>Import / export</button>
          <button className="button" onClick={() => add("expression")}><Icon name="plus" size={16} />Expression tag</button>
          <button className="button" onClick={() => add("memory")}>
            <Icon name="plus" size={16} />
            Memory tag
          </button>
          <button className="button primary" onClick={() => add("opcua")}>
            <Icon name="plus" size={16} />
            OPC UA tag
          </button>
        </div>
      </div>
      <div className="tag-manager-layout">
        <aside className="tag-folder-list">
          <div className="section-heading">
            <span>FOLDERS</span>
            <span className="count-pill">{folders.length}</span>
          </div>
          <button
            className={`folder-filter ${folder === "" ? "active" : ""}`}
            onClick={() => setFolder("")}
          >
            <Icon name="layers" size={16} />
            <span>All configured tags</span>
            <small>{definitions.length}</small>
          </button>
          {folders.map((path) => (
            <button
              key={path}
              className={`folder-filter ${folder === path ? "active" : ""}`}
              style={{ paddingLeft: 14 + (path.split("/").length - 1) * 12 }}
              onClick={() => setFolder(path)}
              title={path}
            >
              <Icon name="folder" size={15} />
              <span>{path.split("/").at(-1)}</span>
            </button>
          ))}
          <p className="folder-help">
            Folders come from your tag paths. Use a slash to organize a new tag,
            such as <code>Production/Line1/Speed</code>.
          </p>
          <div className="tag-source-note">
            <Icon name="info" size={15} />
            <p>
              Built-in sample tags appear in the Designer’s Tag Browser. This
              workspace manages your configured tags.
            </p>
          </div>
        </aside>
        <section className="tag-manager-table">
          <div className="tag-manager-toolbar">
            <label className="search-box">
              <Icon name="search" size={15} />
              <input
                aria-label="Filter configured tags"
                placeholder="Find a tag by path…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <span>{visible.length} tags</span>
            <button
              className="icon-button"
              title="Refresh tags"
              onClick={() => void reload()}
              disabled={loading}
            >
              <Icon name="refresh" size={16} />
            </button>
          </div>
          {error && <div className="inline-error">{error}</div>}
          <nav aria-label="Configured tag pages" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 12px" }}>
            <span role="status">{visible.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, visible.length)} of ${visible.length} tags` : "0 tags"}</span>
            <button className="button small" disabled={currentPage === 0} onClick={() => setPage(0)}>First</button>
            <button className="button small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
            <span>Page {currentPage + 1} of {pageCount}</span>
            <button className="button small" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
            <button className="button small" disabled={currentPage === pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last</button>
          </nav>
          <div className="data-table-wrap">
            <table className="data-table tag-definition-table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((definition) => {
                  const tag = liveByPath.get(definition.path);
                  const good = tag?.quality.toLowerCase().startsWith("good");
                  return (
                    <tr
                      key={definition.path}
                      className={
                        current?.path === definition.path ? "selected" : ""
                      }
                      onClick={() => select(definition)}
                    >
                      <td>
                        <button
                          className="tag-name-button"
                          onClick={() => select(definition)}
                        >
                          <Icon
                            name={
                              definition.kind === "memory" ? "value" : "tag"
                            }
                            size={16}
                          />
                          <span>
                            <strong>
                              {cleanPath(definition.path).split("/").at(-1)}
                            </strong>
                            <small>{definition.path}</small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <span>{definition.dataType}</span>
                        <small>
                          {definition.kind === "memory" ? "Memory" : definition.kind === "expression" ? "Expression" : "OPC UA"}
                        </small>
                      </td>
                      <td className="tag-current-value">
                        {displayValue(tag?.value)}
                      </td>
                      <td>
                        <span
                          className={`tag-state ${definition.enabled === false ? "disabled" : good ? "good" : "bad"}`}
                        >
                          <span
                            className={`quality-dot ${good && definition.enabled !== false ? "" : "bad"}`}
                          />
                          {definition.enabled === false
                            ? "Disabled"
                            : tag
                              ? good
                                ? "Good"
                                : tag.quality.replace(/^Bad_?/, "")
                              : "Waiting"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visible.length && (
              <div className="tag-list-empty">
                <Icon name="tag" size={30} />
                <h3>
                  {loading
                    ? "Loading tags…"
                    : filter
                      ? "No matching tags"
                      : "Create your first tag"}
                </h3>
                <p>
                  {filter
                    ? "Try another path or select a different folder."
                    : "Add a memory value or connect an OPC UA variable. Every tag becomes available to your screens."}
                </p>
              </div>
            )}
          </div>
        </section>
        <aside className="tag-editor">
          {current ? (
            <>
              <div className="tag-editor-heading">
                <div>
                  <Icon
                    name={current.kind === "memory" ? "value" : "tag"}
                    size={20}
                  />
                  <span>
                    <strong>{selected ? "Edit tag" : "New tag"}</strong>
                    <small>
                      {draft ? "Unsaved changes" : "Saved configuration"}
                    </small>
                  </span>
                </div>
                <button
                  className="button primary small"
                  disabled={!draft || busy || Boolean(current.udtInstance)}
                  onClick={() => void save()}
                >
                  <Icon name="save" size={14} />
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
              {current.udtInstance && <div className="inspector-section"><p>Member of <strong>{current.udtDefinition}@{current.udtVersion}</strong> at {current.udtInstance}.</p><p>Overrides: {current.overrideFields?.join(", ") || "none"}</p><button className="button" onClick={() => setModels(true)}>Edit instance / definition</button></div>}
              <fieldset className="inspector-section" disabled={Boolean(current.udtInstance)} style={{ border: 0, margin: 0 }}>
                <Field
                  label="Tag path"
                  hint={
                    selected
                      ? "The path is fixed. Create a new tag to use a different path."
                      : "Include the provider and optional folder segments."
                  }
                >
                  <input
                    value={current.path}
                    readOnly={Boolean(selected)}
                    onChange={(event) => edit({ path: event.target.value })}
                    placeholder="[default]Production/Line1/Speed"
                  />
                </Field>
                <Field label="Value source">
                  <select
                    value={current.kind || "opcua"}
                    onChange={(event) =>
                      edit({
                        kind: event.target.value as "opcua" | "memory" | "expression",
                        ...(event.target.value === "opcua"
                          ? {
                              connectionId: opcConnections[0]?.id || "",
                              nodeId: "",
                            }
                          : event.target.value === "expression" ? { expression: current.expression || "0", inputs: current.inputs || {} } : { value: 0 }),
                      })
                    }
                  >
                    <option value="opcua">OPC UA variable</option>
                    <option value="memory">Memory value</option>
                    <option value="expression">Gateway expression</option>
                  </select>
                </Field>
                <Field label="Data type">
                  <select
                    value={
                      dataTypes.includes(current.dataType)
                        ? current.dataType
                        : "Double"
                    }
                    onChange={(event) => {
                      edit({ dataType: event.target.value });
                      setValueText(
                        event.target.value === "String"
                          ? '""'
                          : event.target.value === "Boolean"
                            ? "false"
                            : "0",
                      );
                    }}
                  >
                    {dataTypes.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </Field>
                {current.kind === "memory" ? (
                  <Field
                    label="Initial value (JSON)"
                    hint='Use a number, true/false, or quoted text such as "Running".'
                  >
                    <textarea
                      spellCheck={false}
                      className="binding-input"
                      rows={3}
                      value={valueText}
                      onChange={(event) => {
                        setValueText(event.target.value);
                        edit({});
                      }}
                    />
                  </Field>
                ) : current.kind === "expression" ? (
                  <>
                    <Field label="Expression" hint="Named inputs, numbers, quoted text, true/false, + − * / %, comparisons, &&, ||, ! and parentheses. No scripts or functions.">
                      <textarea rows={3} spellCheck={false} value={current.expression || ""} onChange={event => edit({ expression: event.target.value })} />
                    </Field>
                    <Field label="Input tag paths (JSON)" hint={'Example: {"speed":"[default]Production/Speed"}. All inputs must exist and have good quality.'}>
                      <textarea rows={5} spellCheck={false} value={inputsText} onChange={event => { setInputsText(event.target.value); edit({}); }} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="OPC UA connection">
                      <select
                        value={current.connectionId || ""}
                        onChange={(event) =>
                          edit({ connectionId: event.target.value })
                        }
                      >
                        <option value="">Choose a connection…</option>
                        {opcConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="Variable node ID"
                      hint="Browse the connection to find the variable’s node ID."
                    >
                      <input
                        placeholder="ns=2;s=Channel.Device.Speed"
                        value={current.nodeId || ""}
                        onChange={(event) =>
                          edit({ nodeId: event.target.value })
                        }
                      />
                    </Field>
                  </>
                )}
                {(!current.kind || current.kind === "opcua") && <>
                  <Field label="Absolute deadband" hint="Server-side numeric change threshold. Zero reports every change; quality changes remain visible."><input type="number" min={0} step="any" value={current.absoluteDeadband ?? 0} onChange={event => edit({ absoluteDeadband: Number(event.target.value) })} /></Field>
                  <Field label="Monitored queue size" hint="1–1,000 server samples; oldest samples are discarded on overflow."><input type="number" min={1} max={1000} step={1} value={current.queueSize ?? 16} onChange={event => edit({ queueSize: Number(event.target.value) })} /></Field>
                </>}
                <Field label="Scan group" hint="Choose a shared timing/availability group, or use an individual interval.">
                  <select value={current.scanGroup || ""} onChange={event => edit({ scanGroup: event.target.value || undefined })}>
                    <option value="">Individual timing</option>{scanGroups.map(group => <option key={group.name} value={group.name}>{group.name} · {group.publishingIntervalMs} ms{group.enabled === false ? " · disabled" : ""}</option>)}
                  </select>
                </Field>
                <Field
                  label="Publishing interval"
                  hint="100–60,000 ms. OPC UA requests this subscription interval. Expressions run on the gateway at this interval with a 100 ms scheduler resolution."
                >
                  <div className="input-suffix">
                    <input
                      type="number"
                      min="100"
                      max="60000"
                      step="100"
                      disabled={Boolean(current.scanGroup)}
                      value={current.publishingIntervalMs ?? 1000}
                      onChange={(event) =>
                        edit({
                          publishingIntervalMs: Number(event.target.value),
                        })
                      }
                    />
                    <span>ms</span>
                  </div>
                </Field>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={current.enabled !== false}
                    onChange={(event) =>
                      edit({ enabled: event.target.checked })
                    }
                  />
                  <span>Tag enabled</span>
                </label>
              </fieldset>
              <div className="inspector-section tag-live-preview">
                <h3>Current value</h3>
                <strong>{displayValue(live?.value)}</strong>
                <div>
                  <span
                    className={`quality-dot ${live?.quality.toLowerCase().startsWith("good") ? "" : "bad"}`}
                  />
                  {live?.quality || "Awaiting first value"}
                </div>
                {live && (
                  <small>
                    Updated {new Date(live.timestamp).toLocaleTimeString()}
                  </small>
                )}
              </div>
              {selected && !selected.udtInstance && (
                <div className="inspector-section">
                  {deleteConfirm ? (
                    <div className="tag-delete-confirm" role="alert">
                      <strong>Delete this tag?</strong>
                      <p>
                        Components using <code>{selected.path}</code> will show
                        a missing binding.
                      </p>
                      <div>
                        <button
                          className="button small"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          Cancel
                        </button>
                        <button
                          className="button danger small"
                          disabled={busy}
                          onClick={() => void remove()}
                        >
                          Delete tag
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="button danger subtle"
                      onClick={() => setDeleteConfirm(true)}
                    >
                      <Icon name="trash" size={14} />
                      Delete tag
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="tag-editor-empty">
              <span className="palette-icon">
                <Icon name="tag" size={22} />
              </span>
              <h3>A tag is a shared value</h3>
              <p>
                Select a tag to edit its source, timing, and data type. Bind the
                same path anywhere in your application.
              </p>
              <div>
                <Icon name="link" size={16} />
                <code>[default]Line/{"{line}"}/Speed</code>
              </div>
              <p>
                Use a context parameter for indirect binding across machines or
                lines.
              </p>
            </div>
          )}
        </aside>
      </div>
      {transfer && <TagTransfer onClose={() => setTransfer(false)} onApplied={() => { void reload(); setDraft(null); setSelectedPath(""); onTagsChanged(); }} />}
      {models && <TagModels onClose={() => setModels(false)} onApplied={() => { void reload(); setDraft(null); setSelectedPath(""); onTagsChanged(); }} />}
    </div>
  );
}
