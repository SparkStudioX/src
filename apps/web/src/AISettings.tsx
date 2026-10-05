import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAuth } from "./Auth";
import { useAskSpark } from "./askSparkContext";
import { askSparkError, defaultAskSparkModel, type AskSparkSettings, type AskSparkUsage } from "./askSparkClient";
import "./askSpark.css";

const initialSettings: AskSparkSettings = { revision: "0", enabled: false, model: defaultAskSparkModel, hasApiKey: false, parallelLimit: 4, monthlyTokenLimit: 20_000_000, modelStepLimit: 100, loggingEnabled: false };

function settingsHaveChanges(saved: AskSparkSettings | null, settings: AskSparkSettings, apiKey: string, clearApiKey: boolean) {
  return Boolean(saved && (JSON.stringify(settings) !== JSON.stringify(saved) || apiKey.length > 0 || clearApiKey));
}

function isIntegerInRange(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function settingsValidationError(settings: AskSparkSettings, apiKey: string) {
  if (!/^gemini-[a-zA-Z0-9][a-zA-Z0-9._-]{0,90}$/.test(settings.model.trim())) return "Enter a Gemini model ID, such as gemini-3.8-flash (at most 98 characters).";
  if (apiKey && !/^[\x21-\x7e]{1,512}$/.test(apiKey.trim())) return "Paste only the API key (up to 512 characters, without spaces or control characters). Surrounding whitespace is removed automatically.";
  if (!isIntegerInRange(settings.parallelLimit, 1, 8)) return "Parallel read tools must be between 1 and 8.";
  if (!isIntegerInRange(settings.modelStepLimit, 1, 1000)) return "Model steps per message must be between 1 and 1000.";
  if (!isIntegerInRange(settings.monthlyTokenLimit, 0, 1_000_000_000_000)) return "Monthly AI tokens must be between 0 (unlimited) and 1,000,000,000,000.";
  return "";
}

export default function AISettings() {
  const auth = useAuth(), [saved, setSaved] = useState<AskSparkSettings | null>(null), [settings, setSettings] = useState(initialSettings);
  const [apiKey, setApiKey] = useState(""), [clearApiKey, setClearApiKey] = useState(false), [busy, setBusy] = useState<"load" | "save" | "test" | null>("load");
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const mounted = useRef(true), active = useRef<AbortController | null>(null), pending = useRef(false);
  const dirty = settingsHaveChanges(saved, settings, apiKey, clearApiKey);
  const { registerContext } = useAskSpark(), hasUnsavedChanges = Boolean(dirty || busy === "save");
  useEffect(() => registerContext("gateway:ai-settings", () => ({ unsavedChanges: hasUnsavedChanges }), 20), [registerContext, hasUnsavedChanges]);
  useEffect(() => {
    mounted.current = true; setApiKey(""); setSaved(null); setBusy("load"); const abort = new AbortController(); active.current = abort;
    if (auth.gatewayAdmin) void api<AskSparkSettings>("/gateway/ai", "GET", undefined, abort.signal).then(value => { if (mounted.current) { setSaved(value); setSettings(value); setBusy(null); } }).catch(reason => { if (!abort.signal.aborted) { setError(askSparkError(reason)); setBusy(null); } });
    return () => { mounted.current = false; active.current?.abort(); };
  }, [auth.gatewayAdmin, auth.epoch]);
  async function save() {
    if (pending.current || !saved) return;
    const normalizedApiKey = apiKey.trim();
    const validationError = settingsValidationError(settings, apiKey);
    if (validationError) { setError(validationError); return; }
    pending.current = true; setBusy("save"); setError(""); setMessage(""); const abort = new AbortController(); active.current = abort;
    try {
      const next = await api<AskSparkSettings>("/gateway/ai", "PUT", { revision: saved.revision, enabled: settings.enabled, model: settings.model.trim(), parallelLimit: settings.parallelLimit, modelStepLimit: settings.modelStepLimit, monthlyTokenLimit: settings.monthlyTokenLimit, loggingEnabled: settings.loggingEnabled, ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) }, abort.signal);
      if (!mounted.current) return; setSaved(next); setSettings(next); setClearApiKey(false); setMessage("AI settings saved."); window.dispatchEvent(new Event("sparkstudio:ai-settings-changed"));
    } catch (reason) { if (!abort.signal.aborted) setError(askSparkError(reason)); }
    finally { pending.current = false; if (mounted.current) { setApiKey(""); setBusy(null); } }
  }
  async function test() {
    if (pending.current || !saved || dirty) return;
    pending.current = true; setBusy("test"); setError(""); setMessage(""); const abort = new AbortController(); active.current = abort;
    try { const result = await api<{ success: boolean; message: string; model: string }>("/gateway/ai/test", "POST", {}, abort.signal); if (mounted.current) { if (result.success) setMessage(result.message || `Connected to ${result.model}.`); else setError(result.message || "The connection test did not pass."); } }
    catch (reason) { if (!abort.signal.aborted) setError(askSparkError(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  async function reload() {
    if (pending.current) return;
    pending.current = true; setBusy("load"); setError(""); const abort = new AbortController(); active.current = abort;
    try { const next = await api<AskSparkSettings>("/gateway/ai", "GET", undefined, abort.signal); if (mounted.current) { setSaved(next); setSettings(next); } }
    catch (reason) { if (!abort.signal.aborted) setError(askSparkError(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  if (!auth.gatewayAdmin) return <p className="gateway-error">Gateway administrator permission is required to configure Ask Spark.</p>;
  return <section className="gateway-status-page ai-settings"><header className="gateway-section-heading"><div><h2>AI settings</h2><p>Connect Ask Spark to Gemini. The assistant is available in the Designer and Gateway Settings, with the same permissions as the signed-in user.</p></div></header>
    <form className="gateway-panel" onSubmit={event => { event.preventDefault(); void save(); }}><div className="gateway-panel-heading"><div><h3>Ask Spark</h3><p>Provider credentials stay on this gateway.</p></div><span className="gateway-badge">Google Gemini</span></div>
      <div className="gateway-panel-body ai-settings-fields">
        <label className="ai-settings-checkbox"><input type="checkbox" checked={settings.enabled} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, enabled: event.target.checked }))} /><span><strong>Enable Ask Spark</strong><small>Allow authorized engineering users to ask questions and use application tools.</small></span></label>
        <label>Model<input value={settings.model} maxLength={98} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, model: event.target.value }))} spellCheck={false} /><small>The default is {defaultAskSparkModel}. Your API key must have access to the selected model.</small></label>
        <label>Gemini API key<input type="password" autoComplete="new-password" value={apiKey} maxLength={512} disabled={busy !== null || clearApiKey} placeholder={saved?.hasApiKey ? "A key is saved. Leave blank to keep it." : "Enter a Gemini API key"} onChange={event => { setApiKey(event.target.value); setError(""); setMessage(""); }} /><small>Paste your key; surrounding whitespace is removed when saving. The saved key is never returned to the browser or included in conversation history.</small></label>
        {saved?.hasApiKey && <label className="ai-settings-checkbox"><input type="checkbox" checked={clearApiKey} disabled={busy !== null} onChange={event => { setClearApiKey(event.target.checked); setApiKey(""); }} /><span>Remove the saved API key when saving</span></label>}
        <label>Parallel read tools<input type="number" min={1} max={8} step={1} value={settings.parallelLimit} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, parallelLimit: Number(event.target.value) }))} /><small>Run up to this many independent read tools together. Changes execute in order, and operations requiring approval pause for review.</small></label>
        <label>Model steps per message<input type="number" min={1} max={1000} step={1} value={settings.modelStepLimit} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, modelStepLimit: Number(event.target.value) }))} /><small>Defaults to 100. Each model response counts as one step, even when it requests several tools. At the limit, Ask Spark makes one final response without tools. Saved changes apply to new messages.</small></label>
        <label>Monthly AI token allowance<input type="number" min={0} max={1_000_000_000_000} step={1} value={settings.monthlyTokenLimit} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, monthlyTokenLimit: Number(event.target.value) }))} /><small>0 means unlimited. Shared by every user and project on this gateway; resets each UTC month. Counts uncached input, output and thinking tokens. Cached input is reported separately. This is a token allowance, not a dollar budget.</small></label>
        <label className="ai-settings-checkbox"><input type="checkbox" checked={settings.loggingEnabled} disabled={busy !== null} onChange={event => setSettings(value => ({ ...value, loggingEnabled: event.target.checked }))} /><span><strong>Log raw Gemini requests and responses</strong><small>Enabled by default. Saves each provider request and its reply together in a timestamped text file under askspark/ in the gateway data directory. Bodies are unfiltered plaintext, including messages, scripts, tool output and base64 images or audio; HTTP authentication headers are excluded. Files have no logging size cap and are not automatically deleted. Turning this off stops new logging and keeps existing files.</small></span></label>
      </div><div className="gateway-panel-note"><strong>What is shared with Gemini</strong><p>Messages, attached images, selected workspace context and tool results are sent to the configured model. Recorded audio is sent for transcription after you stop recording. Review the editable transcript and click Send to submit it as a message. Use the separate secure prompts for connection credentials and passwords.</p></div>
      <footer className="ai-settings-footer"><span>{busy === "load" ? "Loading settings…" : !saved ? "Settings unavailable" : dirty ? "Unsaved changes" : "Settings saved"}</span><button type="button" className="button" disabled={busy !== null || Boolean(dirty) || !saved?.hasApiKey} onClick={() => void test()}>{busy === "test" ? "Testing…" : "Test connection"}</button><button className="button primary" disabled={busy !== null || !saved}>{busy === "save" ? "Saving…" : "Save settings"}</button></footer>
    </form>{saved && <AIUsage limit={saved.monthlyTokenLimit} />}{error && <div className="gateway-error" role="alert">{error}{!saved && <button type="button" className="button" disabled={busy !== null} onClick={() => void reload()}>Retry loading settings</button>}</div>}{message && <p className="gateway-observation" role="status">{message}</p>}
  </section>;
}

function AIUsage({ limit }: { limit: number }) {
  const [usage, setUsage] = useState<AskSparkUsage | null>(null), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api<AskSparkUsage>("/gateway/ai/usage", "GET", undefined, abort.signal).then(value => { if (!abort.signal.aborted) { setUsage(value); setError(""); } })
      .catch(reason => { if (!abort.signal.aborted) setError(askSparkError(reason)); });
    return () => abort.abort();
  }, [refresh]);
  return <section className="gateway-panel ai-usage"><div className="gateway-panel-heading"><div><h3>Monthly AI usage</h3><p>Shared across all users and projects on this gateway.</p></div><button type="button" className="button" onClick={() => setRefresh(value => value + 1)}>Refresh usage</button></div><div className="gateway-panel-body ai-usage-body">
    {usage && <>
      <dl className="ai-usage-stats ai-usage-token-stats" aria-label="Token breakdown">
        <div><dt>Input tokens</dt><dd>{usage.inputTokens?.toLocaleString() ?? "—"}<small>Includes cached input</small></dd></div>
        <div><dt>Output tokens</dt><dd>{usage.outputTokens?.toLocaleString() ?? "—"}<small>Generated responses, excluding thinking</small></dd></div>
        <div><dt>Thinking tokens</dt><dd>{usage.thoughtTokens?.toLocaleString() ?? "—"}<small>Model reasoning, counted separately</small></dd></div>
      </dl>
      {usage.unclassifiedTokens > 0 && <p className="ai-usage-reserved"><strong>{usage.unclassifiedTokens.toLocaleString()} tokens have no recorded breakdown.</strong> Earlier usage and uncategorized provider tokens remain in the monthly totals. The input, output and thinking cards show only the breakdown available.</p>}
      <dl className="ai-usage-stats">
        <div className="ai-usage-stat-primary"><dt>Tokens against allowance</dt><dd>{usage.usedTokens.toLocaleString()}</dd></div>
        <div><dt>Monthly allowance</dt><dd>{limit ? limit.toLocaleString() : "Unlimited"}</dd></div>
        <div><dt>Cached tokens excluded</dt><dd>{usage.cachedTokens.toLocaleString()}</dd></div>
        <div><dt>Completed requests</dt><dd>{usage.requests.toLocaleString()}</dd></div>
      </dl>
      <p className="ai-usage-reset"><span>Next reset</span><time dateTime={usage.resetsAt}>{new Date(usage.resetsAt).toLocaleString()}</time></p>
      {usage.uncertainRequests > 0 && <p className="ai-usage-reserved"><strong>{usage.uncertainRequests.toLocaleString()} in-flight or unconfirmed requests</strong> retain reserved tokens. Requests whose final outcome was lost stay charged for the rest of that UTC month.</p>}
    </>}
    <div className="ai-usage-notes">
      {limit > 0 && <p>Requests reserve tokens for the full prompt and maximum response, then charge actual usage. Leave headroom below the allowance.</p>}
      <p>Provider billing, including cache storage, is separate.</p>
    </div>
    {error && <p className="gateway-error" role="alert">{error}</p>}
  </div></section>;
}
