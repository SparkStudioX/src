import { useState } from "react";
import { api, id } from "./api";
import { Field } from "./App";
import Icon from "./Icon";
import type { BrowseNode, Connection } from "./types";

interface DiscoveredEndpoint {
  endpointUrl: string;
  securityMode: string;
  securityPolicy: string;
  serverCertificateSha256?: string;
  serverCertificateSubject?: string;
  userTokenTypes?: string[];
}

export default function Connections({
  connections,
  onChange,
  onTagsChanged,
  notify,
}: {
  connections: Connection[];
  onChange: (value: Connection[]) => void;
  onTagsChanged: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    connections.find((item) => item.id !== "sample")?.id ||
      connections[0]?.id ||
      "",
  );
  const [draft, setDraft] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [nodes, setNodes] = useState<BrowseNode[]>([]);
  const [browsePath, setBrowsePath] = useState<
    { nodeId: string; name: string }[]
  >([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [mappingNode, setMappingNode] = useState<BrowseNode | null>(null);
  const [mappingPath, setMappingPath] = useState("");
  const [mapBusy, setMapBusy] = useState(false);
  const [endpoints, setEndpoints] = useState<DiscoveredEndpoint[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [schema, setSchema] = useState<{ name: string; columns: {name:string; dataType:string; primaryKey:boolean}[] }[]>([]);
  const databaseAction = async (create: boolean) => {
    if (!selected || draft) return;
    setBusy(true);
    try {
      if (create) {
        const result = await api<{success:boolean;message:string}>(`/connections/${encodeURIComponent(selected.id)}/database`, "POST", {initializeSampleData:false});
        setTestResult(result);
        if (!result.success) return;
      }
      setSchema(await api(`/connections/${encodeURIComponent(selected.id)}/schema`));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
    finally { setBusy(false); }
  };
  const selected = connections.find((item) => item.id === selectedId);
  const current = draft || selected;
  const isSample = current?.id === "sample";
  const edit = (patch: Partial<Connection>) => {
    if (current) setDraft({ ...current, ...patch });
  };
  const discover = async () => {
    if (!current?.endpoint) return;
    setDiscovering(true);
    try {
      setEndpoints(
        await api<DiscoveredEndpoint[]>(
          `/opcua/endpoints?endpoint=${encodeURIComponent(current.endpoint)}`,
        ),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setDiscovering(false);
    }
  };
  const select = (connection: Connection) => {
    setSelectedId(connection.id);
    setDraft(null);
    setTestResult(null);
    setNodes([]);
    setBrowsePath([]);
    setMappingNode(null);
    setBrowseError("");
    setEndpoints([]);
    setSchema([]);
  };
  const add = (type: Connection["type"]) => {
    setDraft({
      id: id(type),
      name:
        type === "opcua"
          ? "New OPC UA connection"
          : type === "sqlite" ? "New SQLite database" : "New SQL Server connection",
      type,
      ...(type === "opcua"
        ? {
            endpoint: "opc.tcp://localhost:4840",
            securityMode: "SignAndEncrypt",
          }
        : type === "sqlite" ? {database:"application.db"} : { server: "localhost", database: "", trustServerCertificate: false }),
    });
    setSelectedId("");
    setTestResult(null);
    setNodes([]);
    setBrowsePath([]);
    setEndpoints([]);
  };
  const save = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const saved = await api<Connection>("/connections", "POST", current);
      onChange([...connections.filter((item) => item.id !== saved.id), saved]);
      setSelectedId(saved.id);
      setDraft(null);
      notify("Connection saved. Test it to check connectivity.");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (!selected || draft) return;
    setBusy(true);
    setTestResult(null);
    try {
      const result = await api<{ success: boolean; message: string }>(
        `/connections/${encodeURIComponent(selected.id)}/test`,
        "POST",
      );
      setTestResult(result);
      onChange(await api<Connection[]>("/connections"));
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const browse = async (
    nodeId = "",
    name = "Root",
    history?: { nodeId: string; name: string }[],
  ) => {
    if (!selected || draft) return;
    setBrowseBusy(true);
    setBrowseError("");
    try {
      setNodes(
        await api<BrowseNode[]>(
          `/connections/${encodeURIComponent(selected.id)}/browse?nodeId=${encodeURIComponent(nodeId)}`,
        ),
      );
      setBrowsePath(history || [...browsePath, { nodeId, name }]);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowseBusy(false);
    }
  };
  const mapTag = async () => {
    if (!selected || !mappingNode || !mappingPath) return;
    setMapBusy(true);
    try {
      await api("/tags", "POST", {
        path: mappingPath,
        connectionId: selected.id,
        nodeId: mappingNode.nodeId,
      });
      onTagsChanged();
      notify("Tag added. It is now available in the Designer.");
      setMappingNode(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setMapBusy(false);
    }
  };
  return (
    <div className="management-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR DATA, CONNECTED</div>
          <h1>Connections</h1>
          <p>Bring industrial and business data into your applications.</p>
        </div>
        <div className="page-heading-actions">
          <button className="button" onClick={() => add("sqlite")}><Icon name="plus" size={16} />SQLite</button>
          <button className="button" onClick={() => add("sqlserver")}>
            <Icon name="plus" size={16} />
            SQL Server
          </button>
          <button className="button primary" onClick={() => add("opcua")}>
            <Icon name="plus" size={16} />
            OPC UA client
          </button>
        </div>
      </div>
      <div className="connection-summary">
        <div>
          <span className="summary-icon">
            <Icon name="plug" size={20} />
          </span>
          <span>
            <strong>
              {connections.filter((item) => item.type === "opcua").length}
            </strong>
            <small>OPC UA clients</small>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <Icon name="database" size={20} />
          </span>
          <span>
            <strong>
              {connections.filter((item) => item.type === "sqlserver" || item.type === "sqlite").length}
            </strong>
            <small>Database connections</small>
          </span>
        </div>
        <div className="connection-summary-note">
          <Icon name="shield" size={24} />
          <span>
            <strong>Everything stays on your gateway</strong>
            <small>Connections run locally. No cloud account is needed.</small>
          </span>
        </div>
      </div>
      <div className="management-columns">
        <aside className="resource-list">
          <div className="section-heading">
            <span>CONNECTIONS</span>
            <span className="count-pill">{connections.length}</span>
          </div>
          {connections.map((connection) => (
            <button
              key={connection.id}
              className={`resource-item ${selectedId === connection.id ? "active" : ""}`}
              onClick={() => select(connection)}
            >
              <span className="resource-icon">
                <Icon
                  name={connection.type === "opcua" ? "plug" : "database"}
                  size={20}
                />
              </span>
              <span>
                <strong>{connection.name}</strong>
                <small>
                  {connection.id === "sample"
                    ? "Simulated sample data"
                    : connection.type === "opcua"
                      ? connection.endpoint
                      : connection.type === "sqlite" ? connection.database : connection.server}
                </small>
              </span>
              <span
                className={`quality-dot ${connection.status?.toLowerCase().includes("connect") || connection.id === "sample" ? "" : "neutral"}`}
              />
            </button>
          ))}
          {!connections.length && (
            <p className="panel-empty">
              Add your first connection to get started.
            </p>
          )}
        </aside>
        <section className="resource-editor">
          {!current ? (
            <div className="large-empty">
              <Icon name="plug" size={42} />
              <h2>Connect to your plant</h2>
              <p>Add an OPC UA server or SQL Server connection above.</p>
            </div>
          ) : (
            <>
              <div className="resource-editor-heading">
                <div>
                  <Icon
                    name={current.type === "opcua" ? "plug" : "database"}
                    size={22}
                  />
                  <div>
                    <h2>{current.name}</h2>
                    <span>
                      {current.type === "opcua"
                        ? "OPC UA client"
                        : current.type === "sqlite" ? "SQLite" : "SQL Server"}{" "}
                      configuration
                    </span>
                  </div>
                </div>
                {isSample ? (
                  <span className="soft-badge">SIMULATED</span>
                ) : (
                  <div className="editor-actions">
                    <button
                      className="button"
                      disabled={busy || Boolean(draft) || !selected}
                      onClick={() => void test()}
                    >
                      <Icon name="activity" size={15} />
                      {busy ? "Working…" : "Test connection"}
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || !draft}
                      onClick={() => void save()}
                    >
                      <Icon name="save" size={15} />
                      Save connection
                    </button>
                  </div>
                )}
              </div>
              {isSample ? (
                <div className="info-banner">
                  <Icon name="info" size={19} />
                  <div>
                    <strong>Sample connection</strong>
                    <p>
                      This built-in data source helps you explore the Designer
                      without hardware. Add an OPC UA client or SQL Server to
                      connect real data.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="connection-form">
                  <div className="form-two-col">
                    <Field label="Connection name">
                      <input
                        value={current.name}
                        onChange={(event) => edit({ name: event.target.value })}
                      />
                    </Field>
                    <Field label="Connection type">
                      <input
                        value={
                          current.type === "opcua"
                            ? "OPC UA client"
                            : current.type === "sqlite" ? "SQLite" : "Microsoft SQL Server"
                        }
                        disabled
                      />
                    </Field>
                  </div>
                  {current.type === "opcua" ? (
                    <>
                      <Field
                        label="Server endpoint"
                        hint="The OPC UA endpoint advertised by your server."
                      >
                        <input
                          placeholder="opc.tcp://192.168.1.10:4840"
                          value={current.endpoint || ""}
                          onChange={(event) =>
                            edit({ endpoint: event.target.value })
                          }
                        />
                      </Field>
                      <div className="form-two-col">
                        <Field label="Security mode">
                          <select
                            value={current.securityMode || "SignAndEncrypt"}
                            onChange={(event) =>
                              edit({ securityMode: event.target.value })
                            }
                          >
                            <option>None</option>
                            <option>Sign</option>
                            <option>SignAndEncrypt</option>
                          </select>
                        </Field>
                        <Field label="Security policy">
                          <input
                            readOnly
                            value={
                              current.securityMode === "None"
                                ? "None (unsecured)"
                                : "Automatic · strongest supported"
                            }
                          />
                        </Field>
                      </div>
                    </>
                  ) : current.type === "sqlite" ? (
                    <Field label="Database filename" hint="A local database in the gateway data directory. Use a filename such as production.db.">
                      <input value={current.database || ""} onChange={event => edit({database:event.target.value})} />
                    </Field>
                  ) : (
                    <div className="form-two-col">
                      <Field
                        label="Server"
                        hint="Hostname, IP address, or server\instance."
                      >
                        <input
                          placeholder="localhost"
                          value={current.server || ""}
                          onChange={(event) =>
                            edit({ server: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Database">
                        <input
                          placeholder="Production"
                          value={current.database || ""}
                          onChange={(event) =>
                            edit({ database: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                  )}
                  {current.type !== "sqlite" && <><h3 className="form-section-title">Authentication</h3>
                  <div className="form-two-col">
                    <Field
                      label="Username"
                      hint={
                        current.type === "opcua"
                          ? "Leave empty for anonymous access."
                          : "SQL Server login."
                      }
                    >
                      <input
                        autoComplete="off"
                        value={current.username || ""}
                        onChange={(event) =>
                          edit({ username: event.target.value })
                        }
                      />
                    </Field>
                    <Field
                      label="Password"
                      hint={
                        selected
                          ? "Leave unchanged to retain the saved password."
                          : "Stored on this gateway."
                      }
                    >
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={current.password || ""}
                        placeholder={selected ? "••••••••" : ""}
                        onChange={(event) =>
                          edit({ password: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  </>}{current.type === "sqlserver" && (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={current.trustServerCertificate || false}
                        onChange={(event) =>
                          edit({ trustServerCertificate: event.target.checked })
                        }
                      />
                      <span>
                        Trust the server certificate without validation
                      </span>
                    </label>
                  )}
                  {current.lastError && (
                    <div className="inline-error">{current.lastError}</div>
                  )}
                </div>
              )}
              {current.type === "sqlite" && <div className="browse-section">
                <div className="browse-section-heading"><div><h3>Local database</h3><p>Save the connection, then create an empty database or inspect an existing one.</p></div>
                  <div className="editor-actions"><button className="button" disabled={busy || !!draft || !selected} onClick={() => void databaseAction(true)}>Create database</button><button className="button" disabled={busy || !!draft || !selected} onClick={() => void databaseAction(false)}>Browse schema</button></div></div>
                {schema.map(table => <div key={table.name}><h4>{table.name}</h4><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Column</th><th>Type</th><th>Key</th></tr></thead><tbody>{table.columns.map(column => <tr key={column.name}><td>{column.name}</td><td>{column.dataType}</td><td>{column.primaryKey ? "Primary" : ""}</td></tr>)}</tbody></table></div></div>)}
              </div>}
              {current.type === "opcua" && !isSample && (
                <div className="browse-section certificate-section">
                  <div className="browse-section-heading">
                    <div>
                      <h3>Server identity</h3>
                      <p>
                        Discover available endpoints and choose the server
                        certificate to trust.
                      </p>
                    </div>
                    <button
                      className="button"
                      disabled={discovering || !current.endpoint}
                      onClick={() => void discover()}
                    >
                      <Icon name="search" size={14} />
                      {discovering ? "Discovering…" : "Discover endpoints"}
                    </button>
                  </div>
                  <Field
                    label="Server certificate SHA-256 pin"
                    hint="For encrypted connections, verify this fingerprint with the server administrator."
                  >
                    <input
                      className="certificate-pin"
                      placeholder="Certificate fingerprint"
                      value={current.serverCertificateSha256 || ""}
                      onChange={(event) =>
                        edit({ serverCertificateSha256: event.target.value })
                      }
                    />
                  </Field>
                  {endpoints.map((endpoint, index) => (
                    <div
                      className="discovered-endpoint"
                      key={`${endpoint.endpointUrl}-${index}`}
                    >
                      <div>
                        <strong>
                          {endpoint.securityMode} ·{" "}
                          {endpoint.securityPolicy.split("#").pop()}
                        </strong>
                        <span>
                          {endpoint.serverCertificateSubject ||
                            endpoint.endpointUrl}
                        </span>
                        <code>
                          {endpoint.serverCertificateSha256 ||
                            "No server certificate supplied"}
                        </code>
                      </div>
                      <button
                        className="button small"
                        onClick={() => {
                          edit({
                            endpoint: endpoint.endpointUrl,
                            securityMode: endpoint.securityMode,
                            serverCertificateSha256:
                              endpoint.serverCertificateSha256 || "",
                          });
                          notify(
                            "Endpoint selected. Verify the certificate fingerprint before saving.",
                          );
                        }}
                      >
                        <Icon name="check" size={13} />
                        Use endpoint
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {testResult && (
                <div
                  className={`test-result ${testResult.success ? "success" : "failed"}`}
                >
                  <Icon
                    name={testResult.success ? "check" : "info"}
                    size={20}
                  />
                  <div>
                    <strong>
                      {testResult.success
                        ? "Connection successful"
                        : "Connection failed"}
                    </strong>
                    <p>{testResult.message}</p>
                  </div>
                </div>
              )}
              {current.type === "opcua" && !isSample && (
                <div className="browse-section">
                  <div className="browse-section-heading">
                    <div>
                      <h3>Browse server</h3>
                      <p>
                        Explore nodes and add variables to your tag provider.
                      </p>
                    </div>
                    <button
                      className="button"
                      disabled={Boolean(draft) || !selected || browseBusy}
                      onClick={() =>
                        void browse("", "Root", [{ nodeId: "", name: "Root" }])
                      }
                    >
                      <Icon name="refresh" size={15} />
                      {browseBusy ? "Browsing…" : "Browse nodes"}
                    </button>
                  </div>
                  {draft && (
                    <p className="muted">
                      Save the connection to browse its server.
                    </p>
                  )}
                  {browseError && (
                    <div className="inline-error">{browseError}</div>
                  )}
                  {browsePath.length > 0 && (
                    <div className="browse-breadcrumb">
                      {browsePath.map((part, index) => (
                        <button
                          key={`${part.nodeId}-${index}`}
                          onClick={() =>
                            void browse(
                              part.nodeId,
                              part.name,
                              browsePath.slice(0, index + 1),
                            )
                          }
                        >
                          {part.name}
                          <Icon name="arrow" size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="browse-list">
                    {nodes.map((node) => (
                      <div className="browse-node" key={node.nodeId}>
                        <Icon
                          name={node.isVariable ? "tag" : "folder"}
                          size={17}
                        />
                        <button
                          className="browse-node-name"
                          onClick={() =>
                            void browse(node.nodeId, node.displayName)
                          }
                        >
                          <strong>{node.displayName}</strong>
                          <code>{node.nodeId}</code>
                        </button>
                        {node.isVariable && (
                          <button
                            className="button small"
                            onClick={() => {
                              setMappingNode(node);
                              setMappingPath(
                                `[default]${node.displayName.replaceAll("/", "_")}`,
                              );
                            }}
                          >
                            <Icon name="plus" size={13} />
                            Add tag
                          </button>
                        )}
                        <button
                          className="icon-button"
                          title="Browse child nodes"
                          onClick={() =>
                            void browse(node.nodeId, node.displayName)
                          }
                        >
                          <Icon name="arrow" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {browsePath.length > 0 &&
                    !nodes.length &&
                    !browseBusy &&
                    !browseError && (
                      <p className="panel-empty">This node has no children.</p>
                    )}
                  {mappingNode && (
                    <div className="tag-mapping-form">
                      <div>
                        <strong>Add {mappingNode.displayName} as a tag</strong>
                        <button
                          className="icon-button"
                          aria-label="Cancel tag mapping"
                          onClick={() => setMappingNode(null)}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      <Field label="Tag path">
                        <input
                          value={mappingPath}
                          onChange={(event) =>
                            setMappingPath(event.target.value)
                          }
                        />
                      </Field>
                      <button
                        className="button primary"
                        disabled={mapBusy || !mappingPath}
                        onClick={() => void mapTag()}
                      >
                        <Icon name="plus" size={15} />
                        {mapBusy ? "Adding…" : "Add tag"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
