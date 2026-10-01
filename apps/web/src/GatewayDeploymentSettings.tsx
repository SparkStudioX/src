import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface ListenerIntent { enabled: boolean; url: string; certificateFile: string | null; privateKeyFile: string | null; publicHostname?: string | null }
interface ListenerSettings {
  revision: string; saved: ListenerIntent; startupIntent: ListenerIntent | null;
  startupState: string; state: string; restartRequired: boolean; overrideReason: string | null;
  recovery: string | null; previousAvailable: boolean; certificateDirectory: string; installerManagementPort: number | null; restartNote: string;
}
interface Validation { settings: ListenerIntent; certificateExpiresAt: string | null; overrideReason: string | null; message: string }
const states: Record<string, string> = { unmanaged: "Host configuration", overridden: "External override", "restart-required": "Restart required", "applied-at-startup": "Applied at startup", recovery: "Recovery needed", managed: "Managed listener" };
const defaultIntent: ListenerIntent = { enabled: false, url: "http://127.0.0.1:5090", certificateFile: null, privateKeyFile: null };

export default function GatewayDeploymentSettings() {
  const [settings, setSettings] = useState<ListenerSettings | null>(null);
  const [draft, setDraft] = useState<ListenerIntent>(defaultIntent);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const serial = useRef(0), mounted = useRef(false), pending = useRef(false);
  const accept = useCallback((next: ListenerSettings) => { setSettings(next); setDraft(next.saved); setValidation(null); }, []);
  const reload = useCallback(async () => {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    const run = ++serial.current; setBusy(true); setError(""); setMessage("");
    try { const next = await api<ListenerSettings>("/gateway/deployment/settings"); if (mounted.current && serial.current === run) accept(next); }
    catch (reason) { if (mounted.current && serial.current === run) setError(reason instanceof Error ? reason.message : "Unable to load listener settings."); }
    finally { if (mounted.current && serial.current === run) { pending.current = false; setBusy(false); } }
  }, [accept]);
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; pending.current = false; serial.current++; }; }, [reload]);
  const change = (patch: Partial<ListenerIntent>) => { setDraft(current => ({ ...current, ...patch })); setValidation(null); setMessage(""); setError(""); };
  const run = async (kind: "validate" | "save" | "restore" | "disable") => {
    if (!mounted.current || pending.current || !settings) return;
    pending.current = true;
    const request = ++serial.current; setBusy(true); setError(""); setMessage("");
    try {
      if (kind === "validate") {
        const next = await api<Validation>("/gateway/deployment/settings/validate", "POST", draft);
        if (mounted.current && request === serial.current) setValidation(next);
      } else {
        const next = await api<ListenerSettings>(kind === "restore" ? "/gateway/deployment/settings/restore" : "/gateway/deployment/settings", kind === "restore" ? "POST" : "PUT",
          kind === "restore" ? { revision: settings.revision } : { revision: settings.revision, settings: kind === "disable" ? defaultIntent : draft });
        if (mounted.current && request === serial.current) { accept(next); setMessage("Saved. The running listener has not changed. Review the restart and recovery instructions below."); }
      }
    } catch (reason) { if (mounted.current && request === serial.current) setError(reason instanceof Error ? reason.message : "Unable to update listener settings."); }
    finally { if (mounted.current && request === serial.current) { pending.current = false; setBusy(false); } }
  };
  const dirty = settings !== null && JSON.stringify(settings.saved) !== JSON.stringify(draft);
  const tls = /^https:/i.test(draft.url);
  return <section className="gateway-deployment-panel gateway-listener-settings" aria-labelledby="listener-settings-title">
    <div className="gateway-deployment-panel-heading"><h3 id="listener-settings-title">Listener settings</h3><p>Stage local access or a network HTTPS listener for the next gateway start.</p></div>
    <div className="gateway-deployment-panel-body">
    {error && <div className="gateway-error gateway-deployment-error" role="alert"><p>{error}</p>{settings ? <p>Cancel changes discards this draft and loads the latest saved settings.</p> : <button type="button" className="button" disabled={busy} onClick={() => void reload()}>Retry listener settings</button>}</div>}
    {message && <p className="gateway-listener-notice" role="status">{message}</p>}
    {!settings ? <p role="status">{busy ? "Loading listener settings…" : "Listener settings are unavailable."}</p> : <>
      <dl className="gateway-deployment-config gateway-listener-status">
        <div className="gateway-deployment-config-row"><dt>Saved intent<small>{states[settings.state] ?? settings.state}</small></dt><dd>{settings.saved.enabled ? <code>{settings.saved.url}</code> : "Managed listener disabled"}{settings.restartRequired && <small>Saved intent differs from the intent loaded at startup.</small>}</dd></div>
        <div className="gateway-deployment-config-row"><dt>Loaded at startup<small>{states[settings.startupState] ?? settings.startupState}</small></dt><dd>{settings.startupIntent?.enabled ? <code>{settings.startupIntent.url}</code> : "Host configuration"}<small>Compare with Actual listening addresses below.</small></dd></div>
      </dl>
      {settings.overrideReason && <p className="gateway-stale">{settings.overrideReason} Saving remains available, but does not remove this override.</p>}
      {settings.recovery && <p className="gateway-error" role="alert">{settings.recovery}</p>}
      {settings.installerManagementPort && <p className="gateway-listener-help">Local setup and recovery remain available at <code>http://127.0.0.1:{settings.installerManagementPort}</code>. Network HTTPS uses a different port.</p>}
      <form onSubmit={event => { event.preventDefault(); void run("validate"); }}>
        <fieldset disabled={busy}>
          <label className="gateway-listener-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} /><span>Use the saved listener at startup</span></label>
          <label>Listener URL<input value={draft.url} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:5090" onChange={event => change({ url: event.target.value, ...(!/^https:\/\/0\.0\.0\.0(?::|\/|$)/i.test(event.target.value) ? { publicHostname: null } : {}), ...(!/^https:/i.test(event.target.value) ? { certificateFile: null, privateKeyFile: null, publicHostname: null } : {}) })} /></label>
          <p className="gateway-listener-help">Use HTTP or HTTPS on 127.0.0.1 or [::1] for local access. For network access use https://0.0.0.0:5443 (all IPv4 interfaces) and enter the operator hostname or IPv4 address below. Ports must be 1024–65535.</p>
          {tls && <>{/^https:\/\/0\.0\.0\.0(?::|\/|$)/i.test(draft.url) && <><label>Operator DNS hostname or IPv4 address<input value={draft.publicHostname ?? ""} autoComplete="off" spellCheck={false} placeholder="sparkstudio.factory.local or 10.20.30.40" onChange={event => change({ publicHostname: event.target.value || null })} /></label><p>Enter a hostname or a specific IPv4 address without a scheme or port. Use four decimal IPv4 octets without leading zeros; a stable LAN address is recommended. DNS is unnecessary when using an IP address. 0.0.0.0 is only the listening address; network IPv6 is not supported.</p></>}<div className="gateway-listener-certificate-fields"><label>PEM certificate filename<input value={draft.certificateFile ?? ""} autoComplete="off" onChange={event => change({ certificateFile: event.target.value || null })} placeholder="gateway-cert.pem" /></label><label>PEM private key filename<input value={draft.privateKeyFile ?? ""} autoComplete="off" onChange={event => change({ privateKeyFile: event.target.value || null })} placeholder="gateway-key.pem" /></label></div>
            <p>Need a certificate? Run the Windows installer, choose Network access and Generate a self-signed certificate. Setup creates the certificate and key for your operator hostname or IP address. Trust its exported public certificate on operator computers. Choose Keep existing listener settings on later upgrades to retain it.</p><p>For a certificate you supply, install these files offline in <code>{settings.certificateDirectory}</code>. The gateway account must be able to read them. Use a currently valid certificate and its matching unencrypted PEM private key. The certificate needs an exact DNS subject alternative name for a hostname, or an exact iPAddress subject alternative name for an IP address. An IP written as a DNS name or common name is insufficient. Include intermediate certificates after the leaf in the certificate file. Protect key-file access at the operating system level.</p><p>Only filenames and the operator hostname or IP address are saved here. Operator computers must trust the issuing CA or your generated self-signed certificate; a DNS hostname must also resolve to this gateway. Configure the HTTPS firewall rule separately. This form does not upload private keys, install browser trust or bypass certificate checks.</p></>}
          {validation && <div className="gateway-listener-validation" role="status"><strong>Validation passed</strong><p>{validation.message}</p>{validation.certificateExpiresAt && <p>Certificate expires {new Date(validation.certificateExpiresAt).toLocaleString()}. Browser trust is not verified.</p>}{validation.overrideReason && <p>{validation.overrideReason}</p>}</div>}
          <div className="gateway-listener-actions"><button type="button" className="button" disabled={!dirty && !error} onClick={() => void reload()}>Cancel changes</button><button type="submit" className="button">Validate draft</button><button type="button" className="button primary" disabled={!validation || !dirty} onClick={() => void run("save")}>Save for next start</button></div>
        </fieldset>
      </form>
      <details className="gateway-listener-recovery"><summary>Restart and recovery</summary><p>{settings.restartNote}</p><p>For a failed listener start, stop the process or service and relaunch with an explicit loopback URL override. Keep the same data directory. Return here to disable the saved listener or restore the previous intent before removing the override.</p><div className="gateway-listener-actions"><button type="button" className="button" disabled={busy || !settings.previousAvailable} onClick={() => void run("restore")}>Restore previous intent</button><button type="button" className="button" disabled={busy || (!settings.saved.enabled && !settings.recovery)} onClick={() => void run("disable")}>Disable managed listener</button></div></details>
    </>}
    </div>
  </section>;
}
