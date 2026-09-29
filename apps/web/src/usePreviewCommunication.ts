import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, authenticatedFetch } from "./api";
import { setPreviewRequestContext, type PreviewMode, type PreviewSession } from "./previewRequest";

async function revoke(session: PreviewSession): Promise<void> {
  // Control request deliberately carries the old capability, even after active
  // preview reads have been cancelled. No capability is kept in browser storage.
  const response = await authenticatedFetch(apiUrl("/preview/session"), {
    method: "DELETE", headers: { "X-SPARK-PREVIEW": session.token },
  });
  if (!response.ok && response.status !== 401 && response.status !== 403)
    throw new Error("The previous preview could not be closed. Try again before enabling live actions.");
}

export function usePreviewCommunication() {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<PreviewSession | null>(null);
  const operation = useRef(0);
  const start = useCallback(async (mode: PreviewMode = "read-only") => {
    const generation = ++operation.current;
    const previous = current.current;
    current.current = null; setSession(null); setBusy(true);
    setPreviewRequestContext(null);
    try {
      if (previous) await revoke(previous);
      if (operation.current !== generation) return false;
      const next = await api<PreviewSession>("/preview/sessions", "POST", { mode });
      if (operation.current !== generation) { await revoke(next); return false; }
      current.current = next; setSession(next); setPreviewRequestContext(next);
      return true;
    } finally { if (operation.current === generation) setBusy(false); }
  }, []);
  const stop = useCallback(async () => {
    ++operation.current;
    const previous = current.current;
    current.current = null; setSession(null); setBusy(false);
    setPreviewRequestContext(null, false);
    if (previous) await revoke(previous);
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      if (current.current !== session) return;
      current.current = null; setSession(null); setPreviewRequestContext(null);
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session]);
  useEffect(() => () => {
    ++operation.current; setPreviewRequestContext(null, false);
    const previous = current.current;
    current.current = null;
    if (previous) void revoke(previous).catch(() => {});
  }, []);
  return { session, busy, start, stop };
}
