import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import RenderBoundary from "./RenderBoundary";
const App = lazy(() => import("./App"));
import OperatorRuntime from "./OperatorRuntime";
import Projects, { DefaultProjectRedirect } from "./Projects";
import { parseProjectRoute } from "./api";
import { initializeTheme, ThemeProvider } from "./Theme";
import { AuthGate, AuthProvider } from "./Auth";
import { AskSparkProvider } from "./askSparkContext";
import { AskSparkShell } from "./AskSparkShell";
import { askSparkNavigationBlocked, registerAskSparkProjectNavigation } from "./askSparkProjectNavigation";
const GatewayConsole = lazy(() => import("./GatewayConsole"));
import "./style.css";
import "./operator.css";
import "./themes.css";

initializeTheme();

// Keep existing security bookmarks on the shared gateway navigation.
if (/^\/security\/?$/.test(window.location.pathname)) {
  window.history.replaceState(null, "", `/gateway${window.location.search}${window.location.hash === "#audit" ? "#audit" : "#security"}`);
}
function WorkspaceRouter() {
  const [pathname, setPathname] = useState(window.location.pathname), previous = useRef(window.location.pathname);
  const [navigationError, setNavigationError] = useState("");
  const route = parseProjectRoute(pathname);
  const audience = route.kind === "runtime" || route.kind === "home" && new URLSearchParams(window.location.search).get("audience") === "operator" ? "operator" : "engineering";
  useEffect(() => {
    const cleanup = registerAskSparkProjectNavigation(projectId => {
      if (audience !== "engineering") throw new Error("Open an engineering session to use the Designer.");
      const next = `/designer/${encodeURIComponent(projectId)}`;
      if (window.location.pathname !== next) window.history.pushState(null, "", next);
      previous.current = next; setPathname(next); setNavigationError("");
    });
    const pop = () => {
      if (window.location.pathname === previous.current) return;
      if (askSparkNavigationBlocked()) {
        window.history.pushState(null, "", previous.current);
        setNavigationError("Save or cancel your unsaved edits before leaving this workspace."); return;
      }
      previous.current = window.location.pathname; setPathname(previous.current); setNavigationError("");
    };
    window.addEventListener("popstate", pop);
    return () => { cleanup(); window.removeEventListener("popstate", pop); };
  }, [audience]);
  useEffect(() => { document.title = route.kind === "runtime" ? "SparkStudio · Operations" : route.kind === "designer" ? "SparkStudio · Designer" : route.kind === "gateway" || route.kind === "security" ? "SparkStudio · Gateway Settings" : "SparkStudio · Projects"; }, [route.kind]);
  return <>
      {navigationError && <div className="gateway-error" role="alert">{navigationError}</div>}
      <AuthProvider audience={audience} projectId={route.kind === "designer" || route.kind === "runtime" ? route.projectId : null}>
        <AskSparkProvider><AskSparkShell><RenderBoundary><Suspense fallback={<main className="projects-empty" role="status">Loading workspace…</main>}><AuthGate requireGateway={route.kind === "security" || route.kind === "gateway"}>
          {route.kind === "home" ? <Projects /> : route.kind === "gateway" || route.kind === "security" ? <GatewayConsole /> : route.kind === "invalid" ? <main className="projects-empty"><h1>Page not found</h1><a className="button" href="/">Open Projects</a></main> : route.projectId === null ? <DefaultProjectRedirect kind={route.kind} /> : route.kind === "runtime" ? <OperatorRuntime key={route.projectId} /> : <App key={route.projectId} />}
        </AuthGate></Suspense></RenderBoundary></AskSparkShell></AskSparkProvider>
      </AuthProvider>
    </>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ThemeProvider><WorkspaceRouter /></ThemeProvider></React.StrictMode>);
