import OpcCertificates from "./OpcCertificates";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import Tags from "./Tags";
import Connections from "./Connections";
import type { Connection, Tag } from "./types";

export default function GatewayConfiguration() {
  const [section, setSection] = useState<"tags" | "connections" | "certificates">("tags");
  const [connections, setConnections] = useState<Connection[]>([]), [tags, setTags] = useState<Tag[]>([]);
  const [message, setMessage] = useState(""), [error, setError] = useState(false);
  const notify = (text: string, failed = false) => { setMessage(text); setError(failed); };
  const refresh = useCallback(async () => {
    try {
      const [nextConnections, nextTags] = await Promise.all([api<Connection[]>("/connections"), api<Tag[]>("/tag-engineering/values")]);
      setConnections(nextConnections); setTags(nextTags);
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <section>
    <nav aria-label="Shared configuration"><button className="button" aria-pressed={section === "tags"} onClick={() => setSection("tags")}>Tags</button><button className="button" aria-pressed={section === "connections"} onClick={() => setSection("connections")}>Connections</button><button className="button" aria-pressed={section === "certificates"} onClick={() => setSection("certificates")}>Public OPC certificates</button><button className="button" onClick={() => void refresh()}>Refresh shared resources</button></nav>
    {message && <p className={error ? "gateway-error" : "gateway-observation"} role={error ? "alert" : "status"}>{message}</p>}
    {section === "certificates" ? <OpcCertificates /> : section === "tags" ? <Tags connections={connections} tags={tags} onTagsChanged={() => void refresh()} notify={notify} /> : <Connections connections={connections} onChange={setConnections} onTagsChanged={() => void refresh()} notify={notify} />}
  </section>;
}
