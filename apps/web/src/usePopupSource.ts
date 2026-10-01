import { useEffect, useState } from "react";
import { api } from "./api";
import { validatePopupSource, type PopupSourceStatus } from "./popupModel";
import { bindingReferenceDependencies } from "./propertyBindings";
import type { PopupState, Project, Tag } from "./types";

export function usePopupSource(project: Project, popup: PopupState, tags: Tag[], scope: "designer" | "runtime", offline: boolean, publishedAt?: string): PopupSourceStatus {
  const path = popup.origin.instancePath ?? (popup.origin.instanceId ? [{ instanceId: popup.origin.instanceId }] : []);
  let document = [...project.screens, ...(project.templates ?? [])].find(item => item.id === popup.origin.screenId);
  const relevantPaths: string[] = [];
  for (const step of path) {
    const instance = document?.components.find(component => component.id === step.instanceId);
    if (instance) try {
      for (const binding of Object.values(instance.props.parameterBindings ?? {}))
        for (const { reference } of bindingReferenceDependencies(binding, instance, { components: document?.components ?? [] }))
          if (reference.kind === "tag") relevantPaths.push(reference.path);
    } catch { /* Source validation presents malformed definitions as unavailable. */ }
    document = project.templates?.find(item => item.id === instance?.props.templateId);
  }
  const patterns = relevantPaths.map(address => new RegExp("^" + address.split(/\{[^{}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
  const tagKey = tags.filter(tag => patterns.some(pattern => pattern.test(tag.path))).map(tag => [tag.path, tag.value, tag.quality]);
  const key = JSON.stringify([project, popup, scope, offline, publishedAt, tagKey]);
  const [state, setState] = useState<{ key: string; status: PopupSourceStatus } | null>(null);
  useEffect(() => {
    if (!path.length) return;
    if (offline && popup.querySourceParameters) return;
    let live = true, running = false, rerun = false;
    const cancellation = new AbortController();
    const run = async () => {
      if (running) { rerun = true; return; }
      running = true;
      try {
        const status = await validatePopupSource(project, popup, tags, scope, api, publishedAt, AbortSignal.any([cancellation.signal, AbortSignal.timeout(30000)]));
        if (live) setState({ key, status });
      } catch (reason) {
        if (live) setState({ key, status: { ready: false, stale: false, message: reason instanceof Error ? reason.message : "Source verification failed." } });
      } finally { running = false; if (live && rerun) { rerun = false; void run(); } }
    };
    void run();
    const interval = window.setInterval(run, 10000);
    window.addEventListener("sparkstudio:refresh-data", run); window.addEventListener("sparkstudio:refresh-queries", run);
    return () => { live = false; cancellation.abort(); window.clearInterval(interval); window.removeEventListener("sparkstudio:refresh-data", run); window.removeEventListener("sparkstudio:refresh-queries", run); };
  }, [key]);
  if (!path.length) return { ready: true, stale: false, message: "" };
  if (offline && popup.querySourceParameters) return { ready: false, stale: false, message: "Communication lost. Source parameters are unavailable." };
  return state?.key === key ? state.status : { ready: false, stale: false, message: "Checking source parameters…" };
}
