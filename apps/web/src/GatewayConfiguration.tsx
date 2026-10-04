import OpcCertificates from "./OpcCertificates";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "./api";
import Connections from "./Connections";
import type { Connection } from "./types";
import { useAskSpark } from "./askSparkContext";
import { clearModelLocation, requestModelNavigation } from "./modelNavigation";

const sections = [
  { id: "connections", name: "Connections" },
  { id: "certificates", name: "Public OPC certificates" },
] as const;

type DataSection = typeof sections[number]["id"];
const sectionFromHash = (): DataSection => window.location.hash === "#data/certificates" ? "certificates" : "connections";

export default function GatewayConfiguration() {
  const [section, setSection] = useState<DataSection>(sectionFromHash);
  const { registerContext } = useAskSpark();
  useEffect(() => registerContext("gateway:data", () => ({ section }), 10), [registerContext, section]);
  useEffect(() => { const hash = () => setSection(sectionFromHash()); window.addEventListener("hashchange", hash); return () => window.removeEventListener("hashchange", hash); }, []);
  const id = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]), generation = useRef(0), pending = useRef(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState(false);
  const [loadError, setLoadError] = useState("");
  const notify = (text: string, failed = false) => { setMessage(text); setError(failed); };
  const navigateSection = (next: typeof section, after?: () => void) => {
    if (next === section) { after?.(); return; }
    requestModelNavigation(() => { clearModelLocation(); window.location.hash = `#data/${next}`; setSection(next); setMessage(""); after?.(); });
  };
  const applyConnections = (value: Connection[]) => {
    // A pending snapshot captured before a save/delete must not restore old rows.
    generation.current++; pending.current = false;
    setConnections(value);
  };
  const refresh = useCallback(async (quiet = false) => {
    if (quiet && pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    try {
      const nextConnections = await api<Connection[]>("/connections");
      if (request !== generation.current) return;
      setConnections(nextConnections); setLoaded(true); setLoadError("");
    } catch (reason) { if (request === generation.current) setLoadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === generation.current) pending.current = false; }
  }, []);
  useEffect(() => {
    if (section === "certificates") return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(true); }, 30_000);
    return () => { generation.current++; pending.current = false; window.clearInterval(timer); };
  }, [refresh, section]);
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
    navigateSection(sections[next].id, () => tabs.current[next]?.focus());
  }
  return <section className="gateway-configuration">
    <div className="gateway-configuration-tabs" role="tablist" aria-label="Gateway data">{sections.map((item, index) =>
      <button key={item.id} ref={element => { tabs.current[index] = element; }} type="button" role="tab"
        id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} aria-selected={section === item.id}
        tabIndex={section === item.id ? 0 : -1} onClick={() => navigateSection(item.id)} onKeyDown={event => moveTab(event, index)}>{item.name}</button>
    )}</div>
    {message && <p className={error ? "gateway-error" : "gateway-observation"} role={error ? "alert" : "status"}>{message}</p>}
    {section !== "certificates" && loadError && <p className="gateway-error" role="alert">{loadError} <button type="button" className="button" onClick={() => void refresh()}>Retry</button></p>}
    {sections.map(item => <div key={item.id} id={`${id}-panel-${item.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${item.id}`} hidden={section !== item.id} tabIndex={0}>
      {section === item.id && (item.id === "certificates" ? <OpcCertificates /> : loaded ? <Connections connections={connections} onChange={applyConnections} onTagsChanged={() => void refresh()} notify={notify} /> : !loadError && <p role="status">Loading connections…</p>)}
    </div>)}
  </section>;
}
