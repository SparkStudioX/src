import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { api } from "./api";
import { useAskSpark } from "./askSparkContext";
import { executeDesignerTool, supportsDesignerTool } from "./askSparkDesignerTools";
import type { DesignerBridge, DesignerSnapshot } from "./askSparkDesignerModel";
import type { Project } from "./types";

const draftTokens = new WeakMap<Project, string>();
export function designerSnapshotToken(project: Project): string {
  let token = draftTokens.get(project);
  if (!token) { token = crypto.randomUUID(); draftTokens.set(project, token); }
  return token;
}
interface DesignerIntegration {
  snapshot(): Omit<DesignerSnapshot, "token"> | null;
  change(update: (project: Project) => Project): void;
  select: DesignerBridge["select"];
  save(signal: AbortSignal): Promise<unknown>;
  preview: DesignerBridge["preview"];
  capture?: DesignerBridge["capture"];
  refreshResources?(event: { projectId: string; name: string }, signal: AbortSignal): Promise<void>;
  editable: boolean; workspace: string; dirty: boolean;
}
export function useAskSparkDesigner(integration: DesignerIntegration) {
  const latest = useRef(integration); latest.current = integration;
  const { registerContext, registerExecutor, registerMutationListener, refreshContext, open } = useAskSpark();
  useEffect(() => {
    const snapshot = (): DesignerSnapshot => {
      const value = latest.current.snapshot();
      if (!value) throw new Error("Open a project before using designer tools.");
      return { ...value, token: designerSnapshotToken(value.project), unsavedChanges: latest.current.dirty };
    };
    const requireCurrent = (token: string) => {
      if (!latest.current.editable) throw new Error("Exit preview before editing the designer draft.");
      if (snapshot().token !== token) throw new Error("The draft changed. Inspect it again before applying this edit.");
    };
    const bridge: DesignerBridge = {
      snapshot,
      validate: (project, signal) => api("/project/validate", "POST", project, signal),
      commit: (project, token) => {
        requireCurrent(token);
        flushSync(() => latest.current.change(current => {
          if (designerSnapshotToken(current) !== token) throw new Error("The draft changed while applying the edit.");
          return project;
        }));
        if (snapshot().token === token) throw new Error("The designer did not apply this edit. Inspect the draft before continuing.");
        refreshContext();
      },
      select: (id, kind, ids) => {
        if (!latest.current.editable) throw new Error("Exit preview and finish the current action before opening another document.");
        flushSync(() => latest.current.select(id, kind, ids)); refreshContext();
      },
      save: async (token, signal) => { requireCurrent(token); signal.throwIfAborted(); return latest.current.save(signal); },
      preview: signal => latest.current.preview(signal),
      capture: signal => {
        if (!latest.current.capture) throw new Error("Canvas capture is unavailable in this workspace.");
        return latest.current.capture(signal);
      },
    };
    const contextCleanup = registerContext("designer", () => {
      const current = latest.current.snapshot();
      if (!current) return { surface: "designer", editorAvailable: false };
      const document = (current.documentKind === "screen" ? current.project.screens : current.project.templates ?? []).find(item => item.id === current.documentId);
      return { surface: "designer", editorAvailable: true, projectId: current.project.id, projectName: current.project.name, revision: current.project.revision,
        snapshotToken: designerSnapshotToken(current.project), documentId: current.documentId, documentName: document?.name, documentKind: current.documentKind,
        selectedComponentIds: current.selectedComponentIds, section: latest.current.workspace, unsavedChanges: latest.current.dirty };
    });
    const executorCleanup = registerExecutor({ id: "designer", supports: supportsDesignerTool, execute: (name, args, context, signal) => executeDesignerTool(bridge, name, args, context, signal) });
    const mutationCleanup = registerMutationListener("designer", async (event, signal) => {
      if (latest.current.snapshot()?.project.id !== event.projectId) return;
      await latest.current.refreshResources?.(event, signal); refreshContext();
    });
    return () => { contextCleanup(); executorCleanup(); mutationCleanup(); };
  }, [registerContext, registerExecutor, registerMutationListener, refreshContext]);
  // Refresh metadata after any editor render; provider compares captured values before notifying.
  useEffect(() => { refreshContext(); });
  return open;
}
