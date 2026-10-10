import { api } from "./api";
import { connectionTypeName, defaultDeviceSettings, isDeviceType } from "./deviceConnections";
import { defaultSourceSettings, isSourceType } from "./sourceConnections";
import type { Connection, NamedQuery } from "./types";
import type { CreationChoice } from "./CreationMenu";

export interface DatabaseConnectorField {
  name: string;
  label: string;
  kind: "text" | "port" | string;
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  help?: string;
}

export interface DatabaseConnectorDescriptor {
  type: string;
  displayName: string;
  description: string;
  supportsUpdates: boolean;
  defaultSql: string;
  fields: DatabaseConnectorField[];
}

const anylogFallback: DatabaseConnectorDescriptor = {
  type: "anylog",
  displayName: "AnyLog query node",
  description: "Query an AnyLog node with SELECT.",
  supportsUpdates: false,
  defaultSql: "SELECT * FROM your_table LIMIT 100",
  fields: [
    { name: "host", label: "Query node address", kind: "text", required: true, placeholder: "192.168.1.20", help: "Hostname or IP address. Do not include the port." },
    { name: "port", label: "REST port", kind: "port", required: true, placeholder: "32349", defaultValue: "32349", help: "REST port of the query node. 32349 is a common default; use the port configured on the node." },
    { name: "dbms", label: "DBMS", kind: "text", required: true, placeholder: "aloperator", help: "Logical database name inserted into sql <dbms>." },
  ],
};

export function loadDatabaseConnectors() {
  return api<DatabaseConnectorDescriptor[]>("/database-connectors").then(items => Array.isArray(items) ? items : [], () => [] as DatabaseConnectorDescriptor[]);
}

export function describeConnector(connection: { type: string; connector?: Record<string, string> } | undefined, catalog: DatabaseConnectorDescriptor[]) {
  if (!connection) return undefined;
  return catalog.find(item => item.type === connection.type) ?? (connection.type === "anylog" ? anylogFallback : undefined);
}

export function isNamedQueryConnection(connection: Connection, catalog: DatabaseConnectorDescriptor[]) {
  return connection.id === "sample" || connection.type === "sqlserver" || connection.type === "sqlite" || connection.queryable === true || describeConnector(connection, catalog) !== undefined;
}

export function isSummarizedDatabase(connection: Connection) {
  return connection.type === "sqlserver" || connection.type === "sqlite" || connection.type === "anylog" || connection.queryable === true;
}

export function connectionHeading(type: string, catalog: DatabaseConnectorDescriptor[]) {
  return catalog.find(item => item.type === type)?.displayName || connectionTypeName(type as Connection["type"]) || type;
}

export function connectionListDetail(connection: Connection) {
  if (connection.id === "sample") return "Simulated sample data";
  if (connection.type === "opcua") return connection.endpoint || "";
  if (isDeviceType(connection.type)) return `${connectionTypeName(connection.type)} · ${connection.device?.host || "No host"}`;
  if (connection.connector) {
    const host = connection.connector.host || "No address";
    const port = connection.connector.port ? `:${connection.connector.port}` : "";
    const dbms = connection.connector.dbms ? ` · ${connection.connector.dbms}` : "";
    return `${host}${port}${dbms}`;
  }
  return connection.type === "sqlite" ? connection.database || "" : connection.server || "";
}

export function connectionMenuChoices(builtIn: CreationChoice<Connection["type"]>[], catalog: DatabaseConnectorDescriptor[]) {
  const extra = catalog.filter(item => !builtIn.some(choice => choice.value === item.type)).map(item => ({
    value: item.type as Connection["type"], label: item.displayName, description: item.description, icon: "database",
  }));
  return [...builtIn, ...extra];
}

export function createConnectionDraft(type: Connection["type"], catalog: DatabaseConnectorDescriptor[], nextId: (prefix: string) => string): Connection {
  const plugin = catalog.find(item => item.type === type);
  if (plugin) {
    const connector: Record<string, string> = {};
    for (const field of plugin.fields) connector[field.name] = field.defaultValue ?? "";
    return { id: nextId(type), name: `New ${plugin.displayName} connection`, type, enabled: true, connector };
  }
  return {
    id: nextId(type), name: `New ${connectionTypeName(type)} connection`, type, enabled: true,
    ...(type === "opcua" ? { endpoint: "opc.tcp://localhost:4840", securityMode: "SignAndEncrypt" }
      : isDeviceType(type) ? { device: defaultDeviceSettings(type) }
      : isSourceType(type) ? { source: defaultSourceSettings(type) }
      : type === "sqlite" ? { database: "application.db" } : { server: "localhost", database: "", trustServerCertificate: false }),
  };
}

export function namedQuerySeed(connections: Connection[], catalog: DatabaseConnectorDescriptor[]): Pick<NamedQuery, "connectionId" | "sql" | "parameters"> {
  const available = connections.filter(connection => isNamedQueryConnection(connection, catalog));
  const connection = available[0];
  const plugin = describeConnector(connection, catalog);
  if (plugin && connection) return { connectionId: connection.id, sql: plugin.defaultSql, parameters: [] };
  if (connection?.type === "sqlite") return { connectionId: connection.id, sql: "SELECT * FROM production_records LIMIT 100", parameters: [] };
  return {
    connectionId: connection?.id || "",
    sql: "SELECT TOP (100) *\nFROM dbo.YourTable\nWHERE Line = @line",
    parameters: [{ name: "line", type: "string", defaultValue: "Line1" }],
  };
}

export function selectQueryConnection(current: NamedQuery, connectionId: string, connections: Connection[], catalog: DatabaseConnectorDescriptor[]): Partial<NamedQuery> {
  const plugin = describeConnector(connections.find(item => item.id === connectionId), catalog);
  if (plugin && !plugin.supportsUpdates && current.kind === "update") return { connectionId, kind: "query" };
  return { connectionId };
}

export function queryUpdatesSupported(connectionId: string, connections: Connection[], catalog: DatabaseConnectorDescriptor[]) {
  const plugin = describeConnector(connections.find(item => item.id === connectionId), catalog);
  return !plugin || plugin.supportsUpdates;
}

export function queryConnectorNote(connectionId: string, connections: Connection[], catalog: DatabaseConnectorDescriptor[]) {
  const connection = connections.find(item => item.id === connectionId);
  const plugin = describeConnector(connection, catalog);
  if (!plugin || !connection?.connector) return "";
  const dbms = connection.connector.dbms || "<dbms>";
  return `${plugin.displayName} keeps your SELECT unchanged and sends sql ${dbms} format=json <select> with destination network. Use @name parameters the same way as SQL Server. AnyLog reads rows; it does not run INSERT, UPDATE or DELETE from this connection.`;
}
