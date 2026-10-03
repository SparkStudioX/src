import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PrivateRequest { purpose: string; kind: "secret" | "attachment"; resolve: (value: Record<string, string> | Blob) => void; reject: (reason: Error) => void }
const secretFields: Record<string, [string, string][]> = {
  connection: [["password", "Connection password"]], "source-connection": [["password", "Password"], ["token", "Bearer token or API key"]],
  "create-user": [["password", "New user's password"]], "update-user": [["password", "New password"]],
  "backup-destination": [["password", "Destination password"], ["secretAccessKey", "Secret access key"], ["sessionToken", "Session token"]],
  "backup-archive": [["archivePassphrase", "Archive passphrase"]],
};

export function useAskSparkPrivateInputs() {
  const [request, setRequest] = useState<PrivateRequest | null>(null);
  const pending = useRef<PrivateRequest | null>(null);
  const cancel = useCallback(() => {
    pending.current?.reject(new Error("Private input cancelled by the user.")); pending.current = null; setRequest(null);
  }, []);
  useEffect(() => () => { pending.current?.reject(new Error("The assistant session ended.")); pending.current = null; }, []);
  const ask = useCallback((kind: PrivateRequest["kind"], purpose: string): Promise<Record<string, string> | Blob> => {
    if (pending.current) return Promise.reject(new Error("Another secure input is already open."));
    return new Promise((resolve, reject) => { const next = { kind, purpose, resolve, reject }; pending.current = next; setRequest(next); });
  }, []);
  const resolveSecret = useCallback(async (_handle: string | undefined, purpose: string) => await ask("secret", purpose) as Record<string, string>, [ask]);
  const resolveAttachment = useCallback(async (_handle?: string, purpose = "project-import") => await ask("attachment", purpose) as Blob, [ask]);
  const complete = (value: Record<string, string> | Blob) => { pending.current?.resolve(value); pending.current = null; setRequest(null); };
  return { resolveSecret, resolveAttachment, cancel, dialog: request ? <PrivateInputDialog key={`${request.kind}-${request.purpose}`} request={request} onCancel={cancel} onComplete={complete} /> : null };
}

function PrivateInputDialog({ request, onCancel, onComplete }: { request: PrivateRequest; onCancel: () => void; onComplete: (value: Record<string, string> | Blob) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), file = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const fields = secretFields[request.purpose] || [["password", "Password"]];
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current; element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const submit = () => {
    if (request.kind === "secret") {
      const supplied = Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
      if (!Object.keys(supplied).length) { setError("Enter at least one credential, or cancel."); return; }
      onComplete(supplied); setValues({}); return;
    }
    const selected = file.current?.files?.[0], image = request.purpose === "asset-upload";
    if (!selected) { setError("Choose a file."); return; }
    if (selected.size > (image ? 512 * 1024 : 32 * 1024 * 1024)) { setError(image ? "Images must be at most 512 KiB." : "Project packages must be at most 32 MiB."); return; }
    onComplete(selected);
  };
  return createPortal(<dialog ref={dialog} className="ask-spark-private-dialog" aria-labelledby="ask-spark-private-title" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => event.stopPropagation()}>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <h2 id="ask-spark-private-title">{request.kind === "secret" ? "Enter credentials securely" : "Choose a local file"}</h2>
      <p>{request.kind === "secret" ? "These values go directly to the gateway operation. They are not included in chat, sent to the AI model, or saved in browser storage." : "This file is uploaded directly to the gateway. Its contents are not sent to the AI model."}</p>
      <small>Requested operation: {request.purpose.replaceAll("-", " ")}</small>
      {request.kind === "secret" ? fields.map(([key, label]) => <label key={key}>{label}<input autoFocus={key === fields[0][0]} type="password" autoComplete="new-password" maxLength={4096} value={values[key] || ""} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>)
        : <label>File<input ref={file} type="file" accept={request.purpose === "asset-upload" ? "image/*" : ".sparkproj"} /></label>}
      {error && <p role="alert" className="ask-spark-error">{error}</p>}
      <footer><button type="button" className="button" onClick={onCancel}>Cancel</button><button className="button primary">Continue</button></footer>
    </form>
  </dialog>, document.body);
}
