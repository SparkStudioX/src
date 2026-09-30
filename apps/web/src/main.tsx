import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OperatorRuntime from "./OperatorRuntime";
import Projects, { DefaultProjectRedirect } from "./Projects";
import { parseProjectRoute } from "./api";
import { initializeTheme, ThemeProvider } from "./Theme";
import { AuthGate, AuthProvider } from "./Auth";
import GatewayConsole from "./GatewayConsole";
import "./style.css";
import "./operator.css";
import "./themes.css";

initializeTheme();

// Keep existing security bookmarks on the shared gateway navigation.
if (/^\/security\/?$/.test(window.location.pathname)) {
  window.history.replaceState(null, "", `/gateway${window.location.search}${window.location.hash === "#audit" ? "#audit" : "#security"}`);
}
const route = parseProjectRoute(window.location.pathname);
const audience = route.kind === "runtime" || route.kind === "home" && new URLSearchParams(window.location.search).get("audience") === "operator" ? "operator" : "engineering";
document.title = route.kind === "runtime" ? "SparkStudio · Operations" : route.kind === "designer" ? "SparkStudio · Designer" : route.kind === "gateway" || route.kind === "security" ? "SparkStudio · Gateway Settings" : "SparkStudio · Projects";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider audience={audience} projectId={route.kind === "designer" || route.kind === "runtime" ? route.projectId : null}>
        <AuthGate requireGateway={route.kind === "security" || route.kind === "gateway"}>
          {route.kind === "home" ? <Projects /> : route.kind === "gateway" || route.kind === "security" ? <GatewayConsole /> : route.kind === "invalid" ? <main className="projects-empty"><h1>Page not found</h1><a className="button" href="/">Open Projects</a></main> : route.projectId === null ? <DefaultProjectRedirect kind={route.kind} /> : route.kind === "runtime" ? <OperatorRuntime /> : <App />}
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
