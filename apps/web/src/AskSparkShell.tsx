import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./Auth";
import { useAskSpark } from "./askSparkContext";
import { AskSparkPanel } from "./AskSpark";
import "./askSparkShell.css";

function useNarrowAskSpark() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => { const query = window.matchMedia("(max-width: 900px)"), update = () => setNarrow(query.matches); update(); query.addEventListener("change", update); return () => query.removeEventListener("change", update); }, []);
  return narrow;
}
export function trapAskSparkFocus(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const candidates = [...container.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(item => !item.closest("[hidden]") && item.getClientRects().length > 0);
  const first = candidates[0], last = candidates.at(-1);
  if (!first || !last) { event.preventDefault(); container.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}
export function AskSparkShell({ children }: { children: ReactNode }) {
  const ask = useAskSpark(), auth = useAuth(), narrow = useNarrowAskSpark(), page = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null), launcher = useRef<HTMLElement | null>(null);
  const visible = Boolean(ask.open && auth.user && auth.audience === "engineering"), designer = ask.activeContext.surface === "designer" && ask.activeContext.section === "designer";
  useLayoutEffect(() => {
    if (!visible) return;
    launcher.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { const previous = launcher.current; if (previous?.isConnected) previous.focus(); };
  }, [visible]);
  useEffect(() => {
    if (!visible || !narrow) return;
    const content = page.current, overflow = document.body.style.overflow; if (content) content.inert = true; document.body.style.overflow = "hidden";
    const handle = (event: KeyboardEvent) => {
      // A native secure-input or property dialog owns its own focus and Escape handling.
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") { event.preventDefault(); ask.setOpen(false); }
      else if (dock.current) trapAskSparkFocus(event, dock.current);
    };
    document.addEventListener("keydown", handle, true);
    return () => { if (content) content.inert = false; document.body.style.overflow = overflow; document.removeEventListener("keydown", handle, true); };
  }, [visible, narrow, ask.setOpen]);
  const settings = () => { window.location.assign("/gateway#ai"); };
  return <div className={`ask-spark-shell${visible ? " ask-spark-shell-open" : ""}${visible && designer ? " ask-spark-shell-designer" : ""}${narrow ? " ask-spark-shell-narrow" : ""}`}>
    <div className="ask-spark-page" ref={page}>{children}</div>
    {visible && <>{narrow && <div className="ask-spark-backdrop" aria-hidden="true" onClick={() => ask.setOpen(false)} />}
      <div ref={dock} className="ask-spark-dock" role={narrow ? "dialog" : undefined} aria-modal={narrow || undefined} aria-label={narrow ? "Ask Spark" : undefined} tabIndex={-1}>
        {designer && <div className="ask-spark-inspector-switch" role="group" aria-label="Right workspace pane"><button type="button" onClick={() => ask.setOpen(false)}>Properties</button><span aria-current="true">Ask Spark</span></div>}
        <AskSparkPanel onOpenSettings={settings} />
      </div></>}
  </div>;
}
