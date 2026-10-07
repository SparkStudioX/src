import { Field } from "./App";
import { describeConnector, queryConnectorNote, type DatabaseConnectorDescriptor } from "./databaseConnectors";
import type { Connection, ConnectionEditorSection } from "./types";

export function DatabaseConnectionFields({
  current, catalog, section, edit,
}: {
  current: Connection;
  catalog: DatabaseConnectorDescriptor[];
  section: ConnectionEditorSection;
  edit: (patch: Partial<Connection>) => void;
}) {
  const plugin = current.type === "sqlserver" ? undefined : describeConnector(current, catalog);
  if (!plugin) {
    return <div className="form-two-col" hidden={section !== "connection"}>
      <Field label="Server" hint="Hostname, IP address, or server\instance.">
        <input placeholder="localhost" value={current.server || ""} onChange={event => edit({ server: event.target.value })} />
      </Field>
      <Field label="Database">
        <input placeholder="Production" value={current.database || ""} onChange={event => edit({ database: event.target.value })} />
      </Field>
    </div>;
  }
  return <div hidden={section !== "connection"}>
    <p className="connection-panel-notice">Write a normal SELECT on the named query. SparkStudio sends it to this query node as sql &lt;dbms&gt; format=json &lt;select&gt;, with destination network.</p>
    {plugin.fields.map(field => <Field key={field.name} label={field.label} hint={field.help}>
      <input
        value={current.connector?.[field.name] ?? ""}
        placeholder={field.placeholder}
        inputMode={field.kind === "port" ? "numeric" : undefined}
        autoComplete="off"
        onChange={event => edit({ connector: { ...current.connector, [field.name]: event.target.value } })}
      />
    </Field>)}
  </div>;
}

export function QueryConnectorNotice({ connectionId, connections, catalog }: { connectionId: string; connections: Connection[]; catalog: DatabaseConnectorDescriptor[] }) {
  const note = queryConnectorNote(connectionId, connections, catalog);
  if (!note) return null;
  return <p className="connection-panel-notice">{note}</p>;
}
