import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function developmentPort(environment: Record<string, string>, name: string, fallback: number): number {
  const value = environment[name];
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} must be a port from 1 to 65535.`);
  return Number(value);
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "SPARKSTUDIO_");
  const browserPort = developmentPort(environment, "SPARKSTUDIO_WEB_PORT", 5173);
  const backendPort = developmentPort(environment, "SPARKSTUDIO_GATEWAY_PORT", 5090);
  if (browserPort === backendPort) throw new Error("Browser and gateway development ports must be different.");
  const gatewayProxy = { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false, ws: true };

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: browserPort,
      strictPort: true,
      // Preserve Host/Origin and cookies; /api includes authentication, assets and live SSE.
      // Vite serves /designer and /runtime through its SPA fallback and owns its HMR socket.
      proxy: { "/api": gatewayProxy, "/hubs": gatewayProxy },
    },
    build: { outDir: "dist", sourcemap: mode === "development" },
  };
});
