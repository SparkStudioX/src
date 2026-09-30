import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { requirePreviewScriptPermission } from "./previewRequest";
import type { Project, RuntimeStateApi, Screen } from "./types";
import { BrowserScriptLifecycle } from "./browserScriptModel";
import type { BrowserPublication } from "./browserScriptModel";
import type { ComponentMessageSender } from "./componentMessageModel";

// Project authors are trusted. These scripts execute in the operator's browser,
// with that origin's privileges; this convenience API is not a security sandbox.
export function useBrowserScripts(project: Project | null, screen: Screen | undefined, notify:(message:string)=>void, navigate:(id:string)=>void, state?:RuntimeStateApi, scopeKey?:string, sendMessage?:ComponentMessageSender) {
  const [publication,setPublication]=useState<BrowserPublication | null>(null);
  const applicationStamp = (project as (Project & { publishedAt?: string }) | null)?.publishedAt;
  const lifecycle=useRef<BrowserScriptLifecycle | null>(null);
  const current=useRef({project,screen,notify,navigate});
  current.current={project,screen,notify,navigate};
  if (!lifecycle.current) lifecycle.current=new BrowserScriptLifecycle((resource,event,parameters,app,session) => {
    requirePreviewScriptPermission();
    const execute=new Function("event","parameters","app","session",`"use strict"; return (async () => {\n${resource.code}\n})();`);
    return execute(event,parameters,app,session);
  });
  // Context changes invalidate old helper calls synchronously, before the next effect.
  lifecycle.current.setContext(project && screen ? {
    applicationPublishedAt: applicationStamp,
    projectKey:JSON.stringify([project.id,project.revision,(project as Project & {publishedAt?:string}).publishedAt]),
    screenId:screen.id,
    screenName:screen.name,
    state,
    scopeKey,
    sendMessage,
    notify:message=>current.current.notify(message),
    navigate:id=>{
      if (current.current.project?.screens.some(item=>item.id===id && item.kind!=="popup")) current.current.navigate(id);
      else throw new Error("Screen not found.");
    },
    refresh:()=>window.dispatchEvent(new Event("sparkstudio:refresh-data")),
  } : null);
  useEffect(() => {
    const runner=lifecycle.current!;
    runner.activate();
    return ()=>runner.deactivate();
  },[]);
  useEffect(() => {
    if (!applicationStamp) { setPublication(null); return; }
    let stopped=false;
    let latestRequest=0;
    const load=() => { const request=++latestRequest; void api<BrowserPublication>(`/runtime/scripts?publishedAt=${encodeURIComponent(applicationStamp)}`).then(next => {
      if (!stopped && request===latestRequest) setPublication(prior => prior?.applicationPublishedAt === next.applicationPublishedAt && prior?.publishedAt === next.publishedAt && prior?.revision === next.revision ? prior : next);
    }).catch(() => { /* Gateway connection status already reports outages. */ }); };
    load(); const poll=setInterval(load,15000);
    return () => { stopped=true; clearInterval(poll); };
  },[applicationStamp]);
  useEffect(() => {
    lifecycle.current!.update(publication?.applicationPublishedAt === applicationStamp ? publication : null);
  },[project,screen,publication,scopeKey]);
}
