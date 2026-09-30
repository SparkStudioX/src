import { useEffect, useRef } from "react";
import { api, apiUrl } from "./api";
import { useAuth } from "./Auth";
import { authSessionRevision } from "./authSession";
import { RuntimeSessionConnection } from "./runtimeSessionMessaging";
import type { GatewaySessionMessage, RuntimeSessionIdentity } from "./runtimeSessionMessaging";
import type { Tag } from "./types";

/** One authenticated mailbox per operator tab, independent of its current screen. */
export function useRuntimeSessionMessaging(projectId: string | undefined, publishedAt: string | undefined,
  receiveTags: (tags: Tag[]) => void, receiveMessage: (message: GatewaySessionMessage) => void,
  report: (message: string) => void, receiveDelta?: (value: unknown) => void) {
  const { epoch, phase } = useAuth();
  const callbacks = useRef({ receiveTags, receiveMessage, report, receiveDelta });
  callbacks.current = { receiveTags, receiveMessage, report, receiveDelta };
  const contextKey = JSON.stringify([projectId, publishedAt, epoch, phase]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => {
    if (!projectId || !publishedAt || phase !== "ready") return;
    const authRevision = authSessionRevision();
    const isCurrent = () => currentContext.current === contextKey && authSessionRevision() === authRevision;
    // Capture the route. Delayed retirement must never use a newly selected project URL.
    const path = `/projects/${encodeURIComponent(projectId)}/runtime/sessions`;
    let lastError = "";
    const connection = new RuntimeSessionConnection(projectId, publishedAt, {
      isCurrent,
      register: signal => api<RuntimeSessionIdentity>(path, "POST", { publishedAt }, signal),
      open: identity => {
        const source = new EventSource(apiUrl(`/runtime/sessions/${encodeURIComponent(identity.sessionId)}/messages`, projectId) + "?audience=operator");
        return { addEventListener: (type, listener) => source.addEventListener(type, event => listener({ data: (event as MessageEvent).data ?? "" })), close: () => source.close() };
      },
      unregister: identity => authSessionRevision() === authRevision ? api(`${path}/${encodeURIComponent(identity.sessionId)}`, "DELETE") : Promise.resolve(),
      tags: tags => callbacks.current.receiveTags(tags as Tag[]),
      tagDelta: value => callbacks.current.receiveDelta?.(value),
      heartbeat: () => callbacks.current.receiveDelta?.({ upserts: [], removed: [] }),
      message: message => callbacks.current.receiveMessage(message),
      status: (_connected, error) => {
        if (error && error !== lastError) callbacks.current.report(error);
        lastError = error ?? "";
      },
    });
    connection.start();
    return () => connection.stop();
  }, [projectId, publishedAt, epoch, phase, contextKey]);
}
