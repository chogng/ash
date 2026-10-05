import type { Connect, Plugin } from "vite";

interface WorkbenchEntryServer {
  readonly middlewares: {
    use(middleware: Connect.NextHandleFunction): void;
  };
}

export type AshWorkbenchEntryPlugin = Omit<Plugin, "configureServer"> & {
  readonly configureServer: (server: WorkbenchEntryServer) => void;
};

/**
 * Redirects the development server root to the shared Browser Workbench.
 */
export function workbenchEntryPlugin(): AshWorkbenchEntryPlugin {
  return {
    name: "ash-workbench-entry",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const method = request.method;
        const targetsRoot = request.url === "/" || request.url?.startsWith("/?");
        if ((method !== "GET" && method !== "HEAD") || !targetsRoot) {
          next();
          return;
        }

        response.statusCode = 302;
        response.setHeader("Cache-Control", "no-store");
        const query = request.url?.indexOf('?') ?? -1;
        response.setHeader("Location", `/browser/workbench/workbench.html${query >= 0 ? request.url!.slice(query) : ''}`);
        response.end();
      });
    },
  };
}
