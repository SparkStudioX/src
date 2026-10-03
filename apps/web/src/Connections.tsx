import { useEffect, useRef, useState } from "react";
import { api, ApiError, displayValue, id } from "./api";
import { Field } from "./App";
import Icon from "./Icon";
import type { BrowseNode, Connection, ConnectionEditorSection, SourceMigrationPreview } from "./types";
import ConnectionDiagnostics from "./ConnectionDiagnostics";
import CreationMenu, { type CreationChoice } from "./CreationMenu";
import { connectionTypeName, defaultDeviceSettings, engineeringPointTypes, isDeviceType, isEquipmentType, mappedDevicePoint, nativeDevicePoint, supportsNativeDeviceBrowse, validateAllenBradleySettings, validateDevicePoints } from "./deviceConnections";
import { DeviceConnectionFields, DeviceRegisterMap } from "./DeviceConnectionEditor";
import { defaultSourceSettings, isSourceType, validateSourcePoints } from "./sourceConnections";
import { SourceConnectionFields, SourceConnectionTools } from "./SourceConnectionEditor";
import { useAskSpark } from "./askSparkContext";
import { connectionAskSparkContext } from "./askSparkClient";

const newConnectionChoices: CreationChoice<Connection["type"]>[] = [
  { value: "sqlite", label: "SQLite", description: "Use a local gateway database", icon: "database" },
  { value: "sqlserver", label: "SQL Server", description: "Connect to Microsoft SQL Server", icon: "database" },
  { value: "opcua", label: "OPC UA client", description: "Connect to an industrial data server", icon: "plug" },
  { value: "modbus-tcp", label: "Modbus TCP", description: "Read mapped coils and registers", icon: "plug" },
  { value: "ab-eip", label: "Allen Bradley EtherNet/IP", description: "Read controller symbols or legacy file elements", icon: "plug" },
  { value: "siemens-s7", label: "Siemens S7", description: "Read mapped DB and memory addresses", icon: "plug" },
  { value: "beckhoff-ads", label: "Beckhoff ADS", description: "Connect to TwinCAT PLC symbols", icon: "plug" },
  { value: "mtconnect", label: "MTConnect agent", description: "Read CNC observations and reduced conditions", icon: "plug" },
  { value: "i3x", label: "i3X source", description: "Browse and read industrial objects", icon: "plug" },
  { value: "mqtt", label: "MQTT subscriber", description: "Map broker topics to read-only tags", icon: "plug" },
];

interface DiscoveredEndpoint {
  endpointUrl: string;
  securityMode: string;
  securityPolicy: string;
  serverCertificateSha256?: string;
  serverCertificateSubject?: string;
  userTokenTypes?: string[];
}

function connectionSections(connection: Connection): { id: ConnectionEditorSection; name: string }[] {
  const sections: { id: ConnectionEditorSection; name: string }[] = [{ id: "connection", name: "Connection" }];
  if (connection.id === "sample") return sections;
  if (connection.type === "opcua" || connection.type === "sqlserver" || isSourceType(connection.type)) sections.push({ id: "security", name: "Security" });
  if (connection.type === "sqlite") sections.push({ id: "schema", name: "Database" });
  if (isDeviceType(connection.type)) sections.push({ id: "points", name: "Register map" });
  if (isSourceType(connection.type)) {
    sections.push(connection.type === "mqtt" ? { id: "mappings", name: "Topic mappings" } : { id: "acquisition", name: "Acquisition" });
    sections.push({ id: "points", name: "Points" });
  }
  if (connection.type === "opcua" || isDeviceType(connection.type) || isSourceType(connection.type)) sections.push({ id: "browse", name: connection.type === "mqtt" ? "Observed topics" : isSourceType(connection.type) ? "Browse & import" : "Browse" });
  if (connection.type === "mqtt") sections.push({ id: "mapping-test", name: "Mapping test" }, { id: "ownership", name: "Ownership" });
  if (isSourceType(connection.type)) sections.push({ id: "advanced", name: "Advanced" });
  sections.push({ id: "diagnostics", name: "Diagnostics" });
  return sections;
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
  const [sourceMigration, setSourceMigration] = useState<SourceMigrationPreview | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [activeSection, setActiveSection] = useState<ConnectionEditorSection>("connection");
  const sectionButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const generation = useRef(0);
  const browseRequest = useRef(0);
  const watchRequest = useRef(0);
  const mounted = useRef(false);
  const latestConnections = useRef(connections);
  latestConnections.current = connections;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    completedAt?: string;
    durationMs?: number;
    accepted?: boolean;
    revision?: number;
    version?: string | null;
    capabilities?: Record<string, unknown>;
    details?: Record<string, unknown> | null;
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
  const [watchValues, setWatchValues] = useState<Record<string, { value: unknown; dataType: string; quality: string; timestamp: string }>>({});
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [endpoints, setEndpoints] = useState<DiscoveredEndpoint[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [schema, setSchema] = useState<{ name: string; columns: {name:string; dataType:string; primaryKey:boolean}[] }[]>([]);
  const databaseAction = async (create: boolean) => {
    if (!selected || draft || selected.enabled === false) return;
    const stamp = generation.current;
    setBusy(true);
    try {
      if (create) {
        const result = await api<{success:boolean;message:string}>(`/connections/${encodeURIComponent(selected.id)}/database`, "POST", {initializeSampleData:false});
        if (stamp !== generation.current || !currentSavedRevision(selected)) return;
        setTestResult(result);
        if (!result.success) return;
      }
      const result = await api<typeof schema>(`/connections/${encodeURIComponent(selected.id)}/schema`);
      if (stamp === generation.current && currentSavedRevision(selected)) setSchema(result);
    } catch (error) { if (stamp === generation.current) notify(error instanceof Error ? error.message : String(error), true); }
    finally { if (stamp === generation.current) setBusy(false); }
  };
  const selected = connections.find((item) => item.id === selectedId);
  const current = draft || selected;
  const sections = current ? connectionSections(current) : [];
  const displayedSection = sections.some(section => section.id === activeSection) ? activeSection : "connection";
  const { registerContext } = useAskSpark();
  const hasUnsavedChanges = Boolean(draft);
  useEffect(() => registerContext("resource:connection", () => connectionAskSparkContext(selected?.id, current?.name, displayedSection, hasUnsavedChanges), 20), [registerContext, selected?.id, current?.name, displayedSection, hasUnsavedChanges]);
  const paneId = `connection-${encodeURIComponent(current?.id ?? "empty")}-sections`;
  function moveSection(event: import("react").KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
    setActiveSection(sections[next].id); sectionButtons.current[next]?.focus();
  }
  const currentSavedRevision = (connection: Connection) => latestConnections.current.some(item => item.id === connection.id && (item.revision ?? 0) === (connection.revision ?? 0));
  useEffect(() => {
    // A parent poll may observe our own save before its refresh completes. Invalidate
    // acquisition state without interrupting that configuration acknowledgement.
    browseRequest.current++;
    watchRequest.current++;
    setBrowseBusy(false); setMapBusy(false); setDiscovering(false);
    setTestResult(null); setNodes([]); setBrowsePath([]); setMappingNode(null); setBrowseError(""); setSchema([]); setEndpoints([]);
    setWatchValues({}); setWatchBusy(false); setWatchError("");
  }, [selected?.id, selected?.revision]);
  const browseModes = [...new Set(nodes.map(node => node.browseMode).filter(Boolean))];
  const isSample = current?.id === "sample";
  const edit = (patch: Partial<Connection>) => {
    if (deleting) return;
    if (current) {
      generation.current++;
      setBusy(false); setBrowseBusy(false); setDiscovering(false); setTestResult(null);
      setNodes([]); setBrowsePath([]); setSchema([]); setMappingNode(null); setMapBusy(false); setEndpoints([]);
      setWatchValues({}); setWatchBusy(false); setWatchError("");
      setDraft({ ...current, ...patch });
      setSourceMigration(null);
      setDeleteConfirm(false); setDeleteError("");
    }
  };
  const discover = async () => {
    if (!current?.endpoint) return;
    const stamp = generation.current;
    setDiscovering(true);
    try {
      const result = await api<DiscoveredEndpoint[]>(
          `/opcua/endpoints?endpoint=${encodeURIComponent(current.endpoint)}`,
        );
      if (stamp === generation.current) setEndpoints(result);
    } catch (error) {
      if (stamp === generation.current) notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (stamp === generation.current) setDiscovering(false);
    }
  };
  const select = (connection: Connection) => {
    generation.current++;
    setBusy(false); setBrowseBusy(false); setDiscovering(false); setMapBusy(false);
    setSelectedId(connection.id);
    setDraft(null);
    setSourceMigration(null);
    setTestResult(null);
    setNodes([]);
    setBrowsePath([]);
    setMappingNode(null);
    setBrowseError("");
    setEndpoints([]);
    setSchema([]);
    setWatchValues({}); setWatchBusy(false); setWatchError("");
    setDeleteConfirm(false); setDeleteError(""); setActiveSection("connection");
  };
  const add = (type: Connection["type"]) => {
    if (deleting) return;
    generation.current++;
    setBusy(false); setBrowseBusy(false); setDiscovering(false); setMapBusy(false);
    setDraft({
      id: id(type),
      name: `New ${connectionTypeName(type)} connection`,
      type,
      enabled: true,
      ...(type === "opcua"
        ? {
            endpoint: "opc.tcp://localhost:4840",
            securityMode: "SignAndEncrypt",
          }
        : isDeviceType(type) ? { device: defaultDeviceSettings(type) }
        : isSourceType(type) ? { source: defaultSourceSettings(type) }
        : type === "sqlite" ? {database:"application.db"} : { server: "localhost", database: "", trustServerCertificate: false }),
    });
    setSelectedId("");
    setSourceMigration(null);
    setTestResult(null);
    setNodes([]);
    setBrowsePath([]);
    setEndpoints([]);
    setSchema([]); setMappingNode(null);
    setWatchValues({}); setWatchBusy(false); setWatchError("");
    setDeleteConfirm(false); setDeleteError(""); setActiveSection("connection");
  };
  const save = async (migrationToken?: string) => {
    if (!current) return;
    const stamp = generation.current;
    setBusy(true);
    try {
      if (isDeviceType(current.type)) {
        const errors = [...(current.type === "ab-eip" ? validateAllenBradleySettings(current.device ?? defaultDeviceSettings(current.type)) : []), ...validateDevicePoints(current.type, current.device?.points ?? [], current.device?.controllerFamily)];
        if (errors.length) throw new Error(errors.join("\n"));
      }
      if (isSourceType(current.type)) {
        const errors = validateSourcePoints(current.source?.points ?? []);
        if (errors.length) throw new Error(errors.join("\n"));
        if (selected && current.type === "mqtt" && !migrationToken) {
          const preview = await api<SourceMigrationPreview>(`/connections/${encodeURIComponent(current.id)}/source/migration/preview`, "POST", { revision: selected.revision ?? 0, source: current.source });
          if (stamp !== generation.current) return;
          if (preview.changed) { setSourceMigration(preview); return; }
        }
      }
      const saved = await api<Connection>("/connections", "POST", { ...current, ...(migrationToken ? { sourceMigrationToken: migrationToken } : {}) });
      const refreshed = await api<Connection[]>("/connections");
      if (stamp !== generation.current) return;
      onChange(refreshed);
      setSelectedId(saved.id);
      setDraft(null);
      setSourceMigration(null);
      setTestResult(null); setNodes([]); setSchema([]);
      setWatchValues({}); setWatchError("");
      notify(saved.enabled === false ? "Connection disabled. New operations are blocked and tag subscriptions are stopped." : "Connection saved. Test it to check connectivity.");
    } catch (error) {
      if (stamp === generation.current) notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };
  const test = async () => {
    if (!selected || draft || selected.enabled === false) return;
    const stamp = generation.current;
    setBusy(true);
    setTestResult(null);
    try {
      const sourceTest = isSourceType(selected.type) ? await api<{ success: boolean; message: string; version?: string | null; capabilities: Record<string, unknown>; details?: Record<string, unknown> | null; saved: NonNullable<Connection["lastTest"]> }>(`/connections/${encodeURIComponent(selected.id)}/source/test`, "POST", { revision: selected.revision ?? 0 }) : null;
      const result = sourceTest?.saved ?? await api<NonNullable<Connection["lastTest"]>>(`/connections/${encodeURIComponent(selected.id)}/test`, "POST");
      const refreshed = await api<Connection[]>("/connections");
      if (stamp !== generation.current || !currentSavedRevision(selected)) return;
      setTestResult(result.accepted && (!sourceTest || result.revision === (selected.revision ?? 0)) ? { ...result, ...(sourceTest ? { version: sourceTest.version, capabilities: sourceTest.capabilities, details: sourceTest.details } : {}) } : { success: false, message: "This test was superseded by a newer test or a configuration change. Review the saved connection before testing again." });
      onChange(refreshed);
    } catch (error) {
      if (stamp === generation.current) setTestResult({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };
  const browse = async (
    nodeId = "",
    name = "Root",
    history?: { nodeId: string; name: string }[],
  ) => {
    if (!selected || draft || selected.enabled === false) return;
    const stamp = generation.current;
    const request = ++browseRequest.current;
    setBrowseBusy(true);
    setBrowseError("");
    try {
      const result = await api<BrowseNode[]>(
          `/connections/${encodeURIComponent(selected.id)}/browse?nodeId=${encodeURIComponent(nodeId)}`,
        );
      if (stamp !== generation.current || request !== browseRequest.current || !currentSavedRevision(selected)) return;
      setNodes(result);
      setBrowsePath(history || [...browsePath, { nodeId, name }]);
    } catch (error) {
      if (stamp === generation.current && request === browseRequest.current && currentSavedRevision(selected)) setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      if (stamp === generation.current && request === browseRequest.current) setBrowseBusy(false);
    }
  };
  const mapTag = async () => {
    if (!selected || draft || selected.enabled === false || !mappingNode || !mappingPath) return;
    const point = isDeviceType(selected.type) ? mappedDevicePoint(selected, mappingNode) : undefined;
    if (isDeviceType(selected.type) && !point) { notify("This symbol has no current saved point mapping. Browse the saved map again.", true); return; }
    const stamp = generation.current;
    setMapBusy(true);
    try {
      await api("/tags", "POST", {
        path: mappingPath,
        connectionId: selected.id,
        nodeId: point?.id ?? mappingNode.nodeId,
        ...(point ? { kind: "device", dataType: point.dataType, writable: point.writable } : {}),
      });
      onTagsChanged();
      if (stamp !== generation.current || !currentSavedRevision(selected)) return;
      notify("Tag added. It is now available in the Designer.");
      setMappingNode(null);
    } catch (error) {
      if (stamp === generation.current) notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (stamp === generation.current) setMapBusy(false);
    }
  };
  const quickRead = async (node: BrowseNode) => {
    if (!selected || draft || selected.enabled === false || watchBusy) return;
    const point = isDeviceType(selected.type) ? mappedDevicePoint(selected, node) : undefined;
    if (isDeviceType(selected.type) && !point) return;
    const stamp = generation.current;
    const request = ++watchRequest.current;
    const currentRead = () => stamp === generation.current && request === watchRequest.current && currentSavedRevision(selected);
    setWatchBusy(true); setWatchError("");
    try {
      const result = await api<({ nodeId: string; value: unknown; dataType: string; quality: string; timestamp: string })[]>(`/connections/${encodeURIComponent(selected.id)}/read`, "POST", { revision: selected.revision ?? 0, nodeIds: [point?.id ?? node.nodeId] });
      if (!currentRead()) return;
      const value = result.find(item => item.nodeId === (point?.id ?? node.nodeId));
      if (!value) throw new Error("The gateway returned no value for this point.");
      setWatchValues(previous => ({ ...previous, [node.nodeId]: value }));
    } catch (error) { if (currentRead()) { setWatchError(error instanceof Error ? error.message : String(error)); setWatchValues(previous => previous[node.nodeId] ? { ...previous, [node.nodeId]: { ...previous[node.nodeId], quality: "Read failed · last value" } } : previous); } }
    finally { if (currentRead()) setWatchBusy(false); }
  };
  const addNativePoint = (node: BrowseNode) => {
    if (!current || !isDeviceType(current.type) || !engineeringPointTypes(current.type, current.device?.controllerFamily).includes(node.dataType as import("./types").TagWriteDataType)) return;
    const device = current.device ?? defaultDeviceSettings(current.type);
    let index = device.points.length + 1;
    while (device.points.some(point => point.id === `point${index}`)) index++;
    const point = nativeDevicePoint(current.type, node, index, current.device?.controllerFamily);
    edit({ device: { ...device, points: [...device.points, point] } });
    setActiveSection("points");
    sectionButtons.current[sections.findIndex(section => section.id === "points")]?.focus();
    notify("Point added to the register-map draft as read-only. Review its encoding and save the connection before reading or adding a tag.");
  };
  const cancelDraft = async () => {
    const stamp = ++generation.current;
    setBusy(true);
    try {
      const result = await api<Connection[]>("/connections");
      if (stamp !== generation.current) return;
      onChange(result);
      const next = result.find(item => item.id === selectedId);
      if (next) select(next);
      else { setDraft(null); setSourceMigration(null); setSelectedId(""); }
    } catch (error) { if (stamp === generation.current) notify(error instanceof Error ? error.message : String(error), true); }
    finally { if (stamp === generation.current) setBusy(false); }
  };
  const remove = async () => {
    if (!selected || draft || selected.id === "sample" || !deleteConfirm || busy || browseBusy || mapBusy) return;
    const stamp = generation.current;
    setBusy(true); setDeleting(true); setDeleteError("");
    try {
      await api(`/connections/${encodeURIComponent(selected.id)}`, "DELETE", { revision: selected.revision ?? 0 });
      if (stamp !== generation.current) return;
      let refreshed: Connection[];
      let refreshFailed = false;
      try { refreshed = await api<Connection[]>("/connections"); }
      catch { refreshed = latestConnections.current.filter(item => item.id !== selected.id); refreshFailed = true; }
      if (stamp !== generation.current) return;
      onChange(refreshed);
      const next = refreshed.find(item => item.id !== "sample") || refreshed[0];
      if (next) select(next);
      else {
        setSelectedId(""); setDraft(null); setDeleteConfirm(false); setActiveSection("connection");
        setTestResult(null); setNodes([]); setBrowsePath([]); setSchema([]); setMappingNode(null);
      }
      notify(refreshFailed ? "Connection deleted. The list could not be refreshed; reopen Connections to load its latest state." : `Connection deleted.${isEquipmentType(selected.type) ? "" : " Database files are retained."}`, refreshFailed);
    } catch (error) {
      if (stamp !== generation.current) return;
      setDeleteError(error instanceof Error ? error.message : String(error));
      if (error instanceof ApiError && error.status === 409) setActiveSection("diagnostics");
    } finally { if (mounted.current) setDeleting(false); if (stamp === generation.current) setBusy(false); }
  };
  const displayedTest = testResult || (!draft ? current?.lastTest : null);
  // Pure render helpers share this hook owner, preserving child keys and edit lifetimes.
  function renderConnectionForm(current: Connection) {
    return (<div className="connection-form" inert={deleting}>
      <div hidden={displayedSection !== "connection"}>
      <label className="checkbox-field"><input type="checkbox" checked={current.enabled !== false} onChange={event => edit({ enabled: event.target.checked })} /><span>Connection enabled</span></label>
      <p className="muted">Disabling stops tag subscriptions and blocks new operations. Operations already in progress may finish. Save to apply.</p>
      <div className="form-two-col">
        <Field label="Connection name">
          <input
            value={current.name}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </Field>
        <Field label="Connection type">
          <input
            value={connectionTypeName(current.type)}
            disabled
          />
        </Field>
      </div>
      </div>
      {current.type === "opcua" ? (
        <>
          <div hidden={displayedSection !== "connection"}><Field
            label="Server endpoint"
            hint="Enter the server address, then choose its security mode and credentials."
          >
            <input
              placeholder="opc.tcp://192.168.1.10:4840"
              value={current.endpoint || ""}
              onChange={(event) =>
                edit({ endpoint: event.target.value })
              }
            />
          </Field>
          </div><div className="form-two-col" hidden={displayedSection !== "security"}>
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
      ) : isDeviceType(current.type) ? (
        <div hidden={displayedSection !== "connection"}><DeviceConnectionFields type={current.type} settings={current.device} onChange={device => edit({ device })} /></div>
      ) : isSourceType(current.type) ? (
        <SourceConnectionFields type={current.type} source={current.source} onChange={source => edit({ source })} section={displayedSection} savedMappingIds={selected?.id === current.id ? selected.source?.mqtt?.mappings?.map(mapping => mapping.id) : []} />
      ) : current.type === "sqlite" ? (
        <div hidden={displayedSection !== "connection"}><Field label="Database filename" hint="A local database in the gateway data directory. Use a filename such as production.db.">
          <input value={current.database || ""} onChange={event => edit({ database: event.target.value })} />
        </Field></div>
      ) : (
        <div className="form-two-col" hidden={displayedSection !== "connection"}>
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
      {(current.type === "opcua" || current.type === "sqlserver") && <div hidden={displayedSection !== "security"}><h3 className="form-section-title">Authentication</h3>
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
      </div>}{current.type === "sqlserver" && (
        <label className="checkbox-field" hidden={displayedSection !== "security"}>
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
    </div>);
  }

  function renderConnectionEditor() {
    return (<section className="resource-editor connection-editor">
      {!current ? (
        <div className="large-empty">
          <Icon name="plug" size={42} />
          <h2>Connect to your plant</h2>
          <p>Choose New Connection to add a PLC, industrial read source, OPC UA server or database.</p>
        </div>
      ) : (
        <>
          <div className="resource-editor-heading">
            <div>
              <Icon
                name={isEquipmentType(current.type) ? "plug" : "database"}
                size={22}
              />
              <div>
                <h2>{current.name}</h2>
                <span>
                  {connectionTypeName(current.type)}{" "}
                  configuration
                </span>
              </div>
            </div>
            {isSample ? (
              <span className="soft-badge">SIMULATED</span>
            ) : (
              <div className="editor-actions">
                {draft && <button className="button" disabled={busy} onClick={() => void cancelDraft()}>Cancel changes</button>}
                <button
                  className="button"
                  disabled={busy || Boolean(draft) || !selected || selected.enabled === false || current.type === "ab-eip" && !supportsNativeDeviceBrowse(current.type, current.device?.controllerFamily) && !current.device?.points.length}
                  title={current.type === "ab-eip" && !supportsNativeDeviceBrowse(current.type, current.device?.controllerFamily) && !current.device?.points.length ? "Declare and save at least one point to test this controller profile." : undefined}
                  onClick={() => void test()}
                >
                  <Icon name="activity" size={15} />
                  {busy ? "Working…" : "Test connection"}
                </button>
                {selected && !deleteConfirm && <button className="button danger" disabled={busy || browseBusy || mapBusy || Boolean(draft)} onClick={() => { setDeleteConfirm(true); setDeleteError(""); }}>
                  <Icon name="trash" size={15} />Delete connection
                </button>}
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
          <div className="connection-section-tabs" role="tablist" aria-label="Connection sections">{sections.map((section, index) => <button key={section.id} ref={element => { sectionButtons.current[index] = element; }} type="button" role="tab" id={`${paneId}-${section.id}`} aria-controls={paneId} aria-selected={displayedSection === section.id} tabIndex={displayedSection === section.id ? 0 : -1} onClick={() => setActiveSection(section.id)} onKeyDown={event => moveSection(event, index)}>{section.name}</button>)}</div>
          {deleteConfirm && selected && <div className="connection-delete-confirm" role="alert">
            <div><strong>Delete {selected.name}?</strong><p>Remove or change any saved tag and named-query references first.{!isEquipmentType(selected.type) && " Database files are retained."} Update any scripts that use this connection.</p></div>
            <div className="editor-actions"><button className="button" disabled={deleting} onClick={() => { setDeleteConfirm(false); setDeleteError(""); }}>Cancel</button><button className="button danger" disabled={busy || browseBusy || mapBusy} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete connection"}</button></div>
            {deleteError && <p className="inline-error" role="status">{deleteError}</p>}
          </div>}
          {current.lastError && <div className="connection-panel-notice inline-error" role="status">{current.lastError}</div>}
          {displayedTest && (
            <div
              className={`test-result ${displayedTest.success ? "success" : "failed"}`}
            >
              <Icon
                name={displayedTest.success ? "check" : "info"}
                size={20}
              />
              <div>
                <strong>
                  {displayedTest.success
                    ? "Last connection test passed"
                    : "Connection test did not pass"}
                </strong>
                <p>{displayedTest.message}</p>
                {testResult?.capabilities && <><p>Source version {testResult.version ?? "not reported"} · tested revision {testResult.revision}</p><details><summary>Source capabilities and effective profile</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ capabilities: testResult.capabilities, details: testResult.details }, null, 2)}</pre></details></>}
                {displayedTest.completedAt && <small>{new Date(displayedTest.completedAt).toLocaleString()} · {displayedTest.durationMs} ms · A test result is a point-in-time observation.</small>}
              </div>
            </div>
          )}
          {sourceMigration && <div className="connection-delete-confirm" role="status"><div><strong>Review source namespace migration</strong><p>{sourceMigration.changes.length} owned definitions retain their identities and locked types. Review paths and mapping changes before saving.</p><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Point</th><th>Before</th><th>After</th><th>Type</th></tr></thead><tbody>{sourceMigration.changes.slice(0, 200).map(change => <tr key={change.pointId}><td>{change.pointId}</td><td>{change.before}</td><td>{change.after}</td><td>{change.dataType}{change.suppressed ? " · suppressed" : change.pruned ? " · pruned" : ""}</td></tr>)}</tbody></table></div>{sourceMigration.changes.length > 200 && <p>Showing 200 of {sourceMigration.changes.length} records; saving applies the complete reviewed migration.</p>}</div><div className="editor-actions"><button className="button" disabled={busy} onClick={() => setSourceMigration(null)}>Cancel migration</button><button className="button primary" disabled={busy || !draft} onClick={() => void save(sourceMigration.token)}>Save reviewed migration</button></div></div>}
          <div id={paneId} className="connection-tab-panel" role="tabpanel" aria-labelledby={`${paneId}-${displayedSection}`} tabIndex={0}>
          {isSample ? (
            <div className="info-banner">
              <Icon name="info" size={19} />
              <div>
                <strong>Sample connection</strong>
                <p>
                  This built-in data source helps you explore the Designer
                  without hardware. Add a PLC, OPC UA client or database to
                  connect real data.
                </p>
              </div>
            </div>
          ) : (
            <div hidden={!["connection", "security", "acquisition", "mappings", "advanced"].includes(displayedSection)}>{renderConnectionForm(current)}</div>
          )}
          {isDeviceType(current.type) && <div inert={deleting} hidden={displayedSection !== "points"}><DeviceRegisterMap key={`${current.id}:${current.device?.controllerFamily ?? ""}`} type={current.type} controllerFamily={current.device?.controllerFamily} configurationKey={JSON.stringify({ ...current.device, points: undefined, id: current.id, revision: current.revision })} points={current.device?.points ?? []} disabled={busy} onChange={points => edit({ device: { ...(current.device ?? defaultDeviceSettings(current.type as import("./types").DeviceConnectionType)), points } })} /></div>}
          {isSourceType(current.type) && current.source && <SourceConnectionTools key={current.id} connection={current} section={displayedSection} saved={!draft && Boolean(selected)} disabled={busy || deleting} onChange={source => edit({ source })} notify={notify} onImported={connection => { generation.current++; setDraft(null); setSourceMigration(null); onChange(latestConnections.current.map(item => item.id === connection.id ? connection : item)); setSelectedId(connection.id); onTagsChanged(); }} />}
          {current.type === "sqlite" && <div className="browse-section" inert={deleting} hidden={displayedSection !== "schema"}>
            <div className="browse-section-heading"><div><h3>Local database</h3><p>Save the connection, then create an empty database or inspect an existing one.</p></div>
              <div className="editor-actions"><button className="button" disabled={busy || !!draft || !selected || selected.enabled === false} onClick={() => void databaseAction(true)}>Create database</button><button className="button" disabled={busy || !!draft || !selected || selected.enabled === false} onClick={() => void databaseAction(false)}>Browse schema</button></div></div>
            {schema.map(table => <div key={table.name}><h4>{table.name}</h4><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Column</th><th>Type</th><th>Key</th></tr></thead><tbody>{table.columns.map(column => <tr key={column.name}><td>{column.name}</td><td>{column.dataType}</td><td>{column.primaryKey ? "Primary" : ""}</td></tr>)}</tbody></table></div></div>)}
          </div>}
          {current.type === "opcua" && !isSample && (
            <div className="browse-section certificate-section" inert={deleting} hidden={displayedSection !== "security"}>
              <div className="browse-section-heading">
                <div>
                  <h3>Server identity</h3>
                  <p>
                    Discover endpoints can fill in the security mode and certificate pin.
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
                hint="Secure connections require a trusted server certificate or a verified pin. Verify this fingerprint with the server administrator."
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
                    {endpoint.userTokenTypes?.length ? <small>Authentication: {endpoint.userTokenTypes.map(type => type === "UserName" ? "Username and password" : type === "IssuedToken" ? "Issued token" : type).join(" / ")}</small> : null}
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
          {(current.type === "opcua" || isDeviceType(current.type)) && !isSample && (
            <div className="browse-section" inert={deleting} hidden={displayedSection !== "browse"}>
              <div className="browse-section-heading">
                <div>
                  <h3>{isDeviceType(current.type) ? "Browse and quick watch" : "Browse server"}</h3>
                  <p>
                    {isDeviceType(current.type) ? !supportsNativeDeviceBrowse(current.type, current.device?.controllerFamily) ? "Browse the authored address map, read a point and add gateway tags." : "Explore controller symbols or mapped points, read values and add gateway tags." : "Explore nodes and add variables to your tag provider."}
                  </p>
                </div>
                <div className="editor-actions">
                {isDeviceType(current.type) && <button className="button" disabled={Boolean(draft) || !selected || browseBusy || selected.enabled === false} onClick={() => void browse("@configured", "Saved point map", [{ nodeId: "@configured", name: "Saved point map" }])}>Browse saved map</button>}
                {(current.type !== "ab-eip" || supportsNativeDeviceBrowse(current.type, current.device?.controllerFamily)) && <button
                  className="button"
                  disabled={Boolean(draft) || !selected || browseBusy || selected.enabled === false}
                  onClick={() =>
                    void browse("", "Root", [{ nodeId: "", name: "Root" }])
                  }
                >
                  <Icon name="refresh" size={15} />
                  {browseBusy ? "Browsing…" : isDeviceType(current.type) ? current.type === "modbus-tcp" || current.type === "siemens-s7" ? "Browse points" : "Browse controller" : "Browse nodes"}
                </button>}
                </div>
              </div>
              {draft && (
                <p className="muted">
                  Save the connection to browse and read its points.
                </p>
              )}
              {browseError && (
                <div className="inline-error">{browseError}</div>
              )}
              {watchError && <div className="inline-error" role="alert">{watchError}</div>}
              {browseModes.length > 0 && <p className="muted">Browse source: {browseModes.join(" · ")}. Configured points come from the saved map; native metadata comes from the controller.</p>}
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
                {nodes.map((node) => {
                  const point = isDeviceType(current.type) ? mappedDevicePoint(selected, node) : undefined;
                  return (
                  <div className="browse-node" key={node.nodeId}>
                    <Icon
                      name={node.isVariable ? "tag" : "folder"}
                      size={17}
                    />
                    <button
                      className="browse-node-name"
                      disabled={isDeviceType(current.type) && node.isVariable}
                      onClick={() =>
                        void browse(node.nodeId, node.displayName)
                      }
                    >
                      <strong>{node.displayName}</strong>
                      <code>{node.address ?? node.nodeId}</code>
                      {node.dataType && <small>{node.dataType} · {node.writable ? "Read / write" : "Read only"}{node.browseMode ? ` · ${node.browseMode}` : ""}</small>}
                      {watchValues[node.nodeId] && <small role="status">{displayValue(watchValues[node.nodeId].value)} · {watchValues[node.nodeId].quality} · {new Date(watchValues[node.nodeId].timestamp).toLocaleTimeString()}</small>}
                    </button>
                    {node.isVariable && (
                      <button className="button small" disabled={watchBusy || browseBusy || Boolean(draft) || isDeviceType(current.type) && !point} title={isDeviceType(current.type) && !point ? "Add this symbol to the saved register map before reading it." : undefined} onClick={() => void quickRead(node)}>{watchBusy ? "Reading…" : "Read value"}</button>
                    )}
                    {node.isVariable && isDeviceType(current.type) && !point && <button className="button small" disabled={!engineeringPointTypes(current.type, current.device?.controllerFamily).includes(node.dataType as import("./types").TagWriteDataType)} title={!engineeringPointTypes(current.type, current.device?.controllerFamily).includes(node.dataType as import("./types").TagWriteDataType) ? "This symbol's type is outside the supported controller profile." : undefined} onClick={() => addNativePoint(node)}><Icon name="plus" size={13} />Add to map</button>}
                    {node.isVariable && (!isDeviceType(current.type) || point) && (
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
                    {(!isDeviceType(current.type) || !node.isVariable) && <button
                      className="icon-button"
                      title="Browse child nodes"
                      onClick={() =>
                        void browse(node.nodeId, node.displayName)
                      }
                    >
                      <Icon name="arrow" size={14} />
                    </button>}
                  </div>
                ); })}
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
          <div hidden={displayedSection !== "diagnostics"}>{selected && !isSample && !draft ? <ConnectionDiagnostics key={`${selected.id}:${selected.revision ?? 0}`} connection={selected} embedded expanded={displayedSection === "diagnostics"} onExpandedChange={() => {}} /> : !isSample && <p className="connection-panel-notice">Save the connection or cancel changes to review diagnostics for its saved configuration.</p>}</div>
          </div>
        </>
      )}
    </section>);
  }

  return (
    <div className="management-page">
      <div className="page-heading">
        <div>
          <h1>Connections</h1>
          <p>Bring industrial and business data into your applications.</p>
        </div>
        <div className="page-heading-actions" inert={deleting}>
          <CreationMenu label="New Connection" menuLabel="New connection type" choices={newConnectionChoices} onSelect={add} />
        </div>
      </div>
      <div className="connection-summary">
        <div>
          <span className="summary-icon">
            <Icon name="plug" size={20} />
          </span>
          <span>
            <strong>
              {connections.filter((item) => isEquipmentType(item.type)).length}
            </strong>
            <small>Industrial connections</small>
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
              disabled={deleting}
              className={`resource-item ${selectedId === connection.id ? "active" : ""}`}
              onClick={() => select(connection)}
            >
              <span className="resource-icon">
                <Icon
                  name={isEquipmentType(connection.type) ? "plug" : "database"}
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
                      : isDeviceType(connection.type) ? `${connectionTypeName(connection.type)} · ${connection.device?.host || "No host"}`
                      : connection.type === "sqlite" ? connection.database : connection.server}
                </small>
              </span>
              <span
                className={`quality-dot ${connection.enabled !== false && (connection.lastTest?.success || connection.id === "sample") ? "" : "neutral"}`}
                title={connection.enabled === false ? "Disabled" : connection.lastTest ? `Last test ${connection.lastTest.success ? "passed" : "failed"}; this is not continuous health monitoring` : "Not tested"}
              />
            </button>
          ))}
          {!connections.length && (
            <p className="panel-empty">
              Add your first connection to get started.
            </p>
          )}
        </aside>
        {renderConnectionEditor()}
      </div>
    </div>
  );
}
