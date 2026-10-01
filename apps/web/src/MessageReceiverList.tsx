import type { ComponentMessageScope } from "./types";
import type { discoverComponentMessageReceivers } from "./componentMessageReceivers";

type ReceiverDiscovery = ReturnType<typeof discoverComponentMessageReceivers>;

/** Authoring information only: saved definitions do not describe live clients. */
export default function MessageReceiverList({ discovery, messageType, scope }: {
  discovery: ReceiverDiscovery; messageType: string; scope: ComponentMessageScope;
}) {
  const potential = discovery.receivers.filter(receiver => receiver.applicability === "possible");
  const other = discovery.receivers.filter(receiver => receiver.applicability !== "possible");
  const rows = (receivers: ReceiverDiscovery["receivers"]) => <ul className="component-message-receiver-list">{receivers.map(receiver => <li key={receiver.key}>
    <div className="component-message-receiver-name"><strong>{receiver.componentName}</strong><span>Component ID <code>{receiver.componentId}</code></span></div>
    <div className="component-message-receiver-meta"><span>{receiver.documentName}</span><small>{receiver.componentType} component · {receiver.documentKind} · {receiver.scope} · {receiver.language === "python" ? "Python" : "JavaScript"}</small><small>Handler ID <code>{receiver.handlerId}</code></small></div>
    {receiver.locations.length > 0 && <p className="component-message-receiver-path">{receiver.locations.join(" · ")}</p>}
    <p>{receiver.reason}{receiver.repeated && " Each mounted repeater row has its own receiver."}</p>
  </li>)}</ul>;
  return <section className="component-message-receivers" aria-label="Message receivers" aria-live="polite">
    <div className="component-message-receivers-heading"><h4>Message receivers</h4><span>{discovery.receivers.length} {discovery.receivers.length === 1 ? "definition" : "definitions"}</span></div>
    <p>Only mounted components in the selected scope receive a message. This list shows authored definitions.</p>
    {!messageType.trim() ? <p className="component-message-receivers-empty">Choose or enter a message type to see its receivers.</p>
      : !discovery.receivers.length ? <p className="component-message-receivers-empty">No receiver definitions match “{messageType.trim()}” in {scope} scope. Message types are case-sensitive.</p>
      : <>{potential.length > 0 && <><h5>Potential receivers in this scope</h5>{rows(potential)}</>}{other.length > 0 && <><h5>Other locations</h5>{rows(other)}</>}</>}
    {discovery.truncated && <p className="component-message-receivers-limit">The receiver list is limited. Some definitions or placements were not inspected.</p>}
    {discovery.notes.length > 0 && <ul className="component-message-receiver-notes">{discovery.notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </section>;
}
