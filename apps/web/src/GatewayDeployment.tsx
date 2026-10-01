import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import GatewayDeploymentSettings from "./GatewayDeploymentSettings";
import "./gatewayDeployment.css";

interface ConfigurationValues { values: string[]; source: string; omittedEntries: number }
interface DeploymentSnapshot {
  observedAt: string;
  startedAt: string;
  environment: { value: string; source: string };
  hosting: { kind: "windows-service" | "container" | "interactive" | "unknown"; description: string };
  listeners: { addresses: string[]; httpsEnabled: boolean | null; loopbackOnly: boolean | null; omittedEntries: number };
  configuration: {
    capturedAt: string;
    urls: ConfigurationValues;
    kestrelEndpoints: ConfigurationValues;
    allowedHosts: ConfigurationValues;
    dataDirectory: { value: string; source: string };
    restartNote: string;
  };
  publicOperatorAddress: { value: string | null; source: "gateway-settings" | "request-origin" | "bootstrap"; description: string };
  transport: {
    requestHttps: boolean;
    requestLoopback: boolean;
    forwardedHeadersEnabled: boolean | null;
    forwardedHeadersHostOverride: boolean;
    proxyNote: string;
    certificate: { status: "observed" | "unavailable"; expiresAt: string | null; note: string };
  };
}

const hostingNames: Record<DeploymentSnapshot["hosting"]["kind"], string> = { "windows-service": "Windows service", container: "Container", interactive: "Interactive process", unknown: "Not determined" };
const publicSources: Record<DeploymentSnapshot["publicOperatorAddress"]["source"], string> = { "gateway-settings": "Saved gateway setting", "request-origin": "Request origin", bootstrap: "Bootstrap configuration" };
const date = (value: string) => new Date(value).toLocaleString();

function ConfigurationRow({ label, value }: { label: string; value: ConfigurationValues }) {
  return <div className="gateway-deployment-config-row"><dt>{label}<small>Source: {value.source}</small></dt><dd>
    {value.values.length ? <ul className="gateway-deployment-values">{value.values.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul> : <span className="gateway-deployment-muted">{value.omittedEntries > 0 ? "No supported values to display" : "Not configured"}</span>}
    {value.omittedEntries > 0 && <small>At least {value.omittedEntries} additional or unsupported {value.omittedEntries === 1 ? "entry omitted" : "entries omitted"}.</small>}
  </dd></div>;
}

export default function GatewayDeployment() {
  const [snapshot, setSnapshot] = useState<DeploymentSnapshot | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [receivedAt, setReceivedAt] = useState(0);
  const serial = useRef(0), mounted = useRef(false), pending = useRef(false);
  const refresh = useCallback(async (showLoading = false) => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    const run = ++serial.current;
    if (showLoading) setBusy(true);
    try {
      const next = await api<DeploymentSnapshot>("/gateway/deployment");
      if (!mounted.current || run !== serial.current) return;
      const received = Date.now();
      setSnapshot(next); setNow(received); setReceivedAt(received); setError("");
    } catch (reason) {
      if (mounted.current && run === serial.current) setError(reason instanceof Error ? reason.message : "Unable to load deployment status.");
    } finally { if (mounted.current && run === serial.current) { pending.current = false; setBusy(false); } }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const polling = window.setInterval(() => void refresh(), 30_000);
    return () => { mounted.current = false; pending.current = false; serial.current++; window.clearInterval(timer); window.clearInterval(polling); };
  }, [refresh]);
  const stale = snapshot !== null && (Boolean(error) || now - receivedAt > 30_000);
  const certificate = snapshot?.transport.certificate;
  return <section className="gateway-deployment management-page" aria-labelledby="gateway-deployment-title">
    <div className="gateway-deployment-heading"><div><h2 id="gateway-deployment-title">Deployment &amp; HTTPS</h2><p>Inspect the running gateway and the configuration captured when it started. Live status updates automatically.</p></div></div>
    {error && <div className="gateway-error gateway-deployment-error" role="alert"><p>{error}</p><button type="button" className="button" disabled={busy} onClick={() => void refresh(true)}>Retry deployment status</button></div>}
    {snapshot && <p className={`gateway-deployment-status ${stale ? "gateway-stale" : "gateway-observation"}`} role="status"><strong>{stale ? "Last observation may be outdated." : "Deployment snapshot"}</strong><span>Observed <time dateTime={snapshot.observedAt}>{date(snapshot.observedAt)}</time></span></p>}
    <GatewayDeploymentSettings />
    {!snapshot ? <p role="status">{busy ? "Loading deployment status…" : "Deployment status is unavailable."}</p> : <>
      <div className="gateway-deployment-summary">
        <article><span>Hosting</span><strong>{hostingNames[snapshot.hosting.kind]}</strong><small>{snapshot.hosting.description}</small></article>
        <article><span>Observed listeners</span><strong>{!snapshot.listeners.addresses.length ? "Unavailable" : snapshot.listeners.httpsEnabled === null ? "Transport not determined" : snapshot.listeners.httpsEnabled ? "HTTPS listener present" : "HTTP only"}</strong><small>{snapshot.listeners.loopbackOnly === null ? "Listener scope is not determined." : snapshot.listeners.loopbackOnly ? "All observed listeners use loopback addresses." : "At least one listener uses a non-loopback or wildcard address."}</small></article>
        <article><span>This request at the gateway</span><strong>{snapshot.transport.requestHttps ? "HTTPS" : "HTTP"}</strong><small>{snapshot.transport.requestLoopback ? "The request reports a loopback address." : "The request reports a non-loopback address."} {snapshot.transport.forwardedHeadersEnabled !== false ? "Host or proxy forwarding may influence these values." : "This does not establish the transport used by a proxy."}</small></article>
        <article><span>Certificate expiry</span><strong>{certificate?.status === "observed" && certificate.expiresAt ? date(certificate.expiresAt) : "Not observed"}</strong><small>{certificate?.note}</small></article>
      </div>
      <div className="gateway-deployment-grid">
        <section className="gateway-deployment-panel" aria-labelledby="deployment-listeners-title"><div className="gateway-deployment-panel-heading"><h3 id="deployment-listeners-title">Actual listening addresses</h3><p>Addresses reported by the running web server.</p></div><div className="gateway-deployment-panel-body"><p>This observation does not test firewall rules or access from another computer.</p>
          {snapshot.listeners.addresses.length ? <ul className="gateway-deployment-values">{snapshot.listeners.addresses.map((address, index) => <li key={index}><code>{address}</code></li>)}</ul> : <p>{snapshot.listeners.omittedEntries > 0 ? "No supported listening addresses are available to display." : "No listening addresses were reported."}</p>}
          {snapshot.listeners.omittedEntries > 0 && <p>At least {snapshot.listeners.omittedEntries} additional or unsupported {snapshot.listeners.omittedEntries === 1 ? "address omitted" : "addresses omitted"}. The displayed list is incomplete.</p>}
        </div></section>
        <section className="gateway-deployment-panel" aria-labelledby="deployment-public-title"><div className="gateway-deployment-panel-heading"><h3 id="deployment-public-title">Public operator address</h3><p>The address included in published operator links.</p></div><div className="gateway-deployment-panel-body"><p className="gateway-deployment-address"><code>{snapshot.publicOperatorAddress.value || "Uses the requesting gateway address"}</code></p><p><strong>Source:</strong> {publicSources[snapshot.publicOperatorAddress.source]}</p><p>{snapshot.publicOperatorAddress.description}</p><p>Manage the saved address under Security → Operator settings. This address does not configure a listener or enable HTTPS.</p></div></section>
        <section className="gateway-deployment-panel" aria-labelledby="deployment-runtime-title"><div className="gateway-deployment-panel-heading"><h3 id="deployment-runtime-title">Runtime environment</h3><p>The process and data directory currently in use.</p></div><div className="gateway-deployment-panel-body"><dl className="gateway-deployment-config">
          <div className="gateway-deployment-config-row"><dt>Started</dt><dd><time dateTime={snapshot.startedAt}>{date(snapshot.startedAt)}</time></dd></div>
          <div className="gateway-deployment-config-row"><dt>Environment<small>Source: {snapshot.environment.source}</small></dt><dd><code>{snapshot.environment.value}</code></dd></div>
          <div className="gateway-deployment-config-row"><dt>Gateway data directory<small>Source: {snapshot.configuration.dataDirectory.source}</small></dt><dd><code>{snapshot.configuration.dataDirectory.value}</code></dd></div>
        </dl></div></section>
        <section className="gateway-deployment-panel" aria-labelledby="deployment-proxy-title"><div className="gateway-deployment-panel-heading"><h3 id="deployment-proxy-title">Proxy and certificate observations</h3><p>Transport information visible to the gateway process.</p></div><div className="gateway-deployment-panel-body"><p><strong>Forwarded headers:</strong> {snapshot.transport.forwardedHeadersEnabled === null ? "Not determined" : snapshot.transport.forwardedHeadersEnabled ? "Enabled by hosting configuration" : "Not enabled"}</p>{snapshot.transport.forwardedHeadersHostOverride && <p>The host requests a forwarded-header override.</p>}<p>{snapshot.transport.proxyNote}</p><p>Certificate trust, renewal and the certificate presented by a proxy are not verified by this page.</p></div></section>
      </div>
      <section className="gateway-deployment-panel" aria-labelledby="deployment-config-title"><div className="gateway-deployment-panel-heading"><h3 id="deployment-config-title">Startup configuration</h3><p>Selected deployment values and their winning configuration sources.</p></div><div className="gateway-deployment-panel-body"><p>Captured <time dateTime={snapshot.configuration.capturedAt}>{date(snapshot.configuration.capturedAt)}</time>. Compare these inputs with the actual listening addresses above.</p>
        <dl className="gateway-deployment-config"><ConfigurationRow label="URL bindings" value={snapshot.configuration.urls} /><ConfigurationRow label="Kestrel endpoints" value={snapshot.configuration.kestrelEndpoints} /><ConfigurationRow label="Allowed hosts" value={snapshot.configuration.allowedHosts} /></dl><p>{snapshot.configuration.restartNote}</p></div>
      </section>
    </>}
  </section>;
}
