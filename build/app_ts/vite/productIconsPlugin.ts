import { dirname, extname, resolve } from "node:path";
import type { Plugin } from "vite";
import { generateIcons } from "../../resources/icons/generate.ts";

const watchedEvents = new Set(["add", "change", "unlink"]);

interface ProductIconsPluginOptions {
  readonly sourceDirectory?: string;
  readonly outputFile?: string;
  readonly debounceMilliseconds?: number;
}

interface ProductIconsServer {
  readonly config: { readonly logger: { error(message: string, options?: { readonly error?: unknown }): void } };
  readonly watcher: {
    add(path: string): unknown;
    on(event: "all", listener: (event: string, path: string) => void): unknown;
  };
  readonly ws: { send(message: { readonly type: "full-reload" }): void };
}

export type AshProductIconsPlugin = Omit<Plugin, "configureServer"> & {
  readonly configureServer: (server: ProductIconsServer) => void;
};

/**
 * Keeps generated product-icon modules synchronized with their source SVGs
 * while Vite is running and reloads the Renderer after a successful update.
 */
export function productIconsPlugin(options: ProductIconsPluginOptions = {}): AshProductIconsPlugin {
  const sourceDirectory = resolve(options.sourceDirectory ?? resolve(import.meta.dirname, "../../../resources/icons"));
  const outputFile = resolve(options.outputFile ?? resolve(import.meta.dirname, "../../../app-ts/src/ash/base/common/productIcons.ts"));
  const debounceMilliseconds = options.debounceMilliseconds ?? 50;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<unknown> = Promise.resolve();

  return {
    name: "ash-product-icons",
    configureServer(server) {
      server.watcher.add(sourceDirectory);
      server.watcher.on("all", (event, path) => {
        if (!watchedEvents.has(event) || !isDirectSvgChild(path, sourceDirectory)) {
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          pending = pending
            .catch(() => undefined)
            .then(() => generateIcons({
              outputs: { typescriptFile: outputFile },
              sourceDirectory,
              sourceHandling: "ignore",
            }))
            .then((report) => {
              if (report.outputChanged) {
                server.ws.send({ type: "full-reload" });
              }
            })
            .catch((error) => server.config.logger.error(error instanceof Error ? error.message : String(error), { error }));
        }, debounceMilliseconds);
      });
    },
  };
}

function isDirectSvgChild(path: string, sourceDirectory: string): boolean {
  const resolvedPath = resolve(path);
  return extname(resolvedPath).toLowerCase() === ".svg" && samePath(dirname(resolvedPath), sourceDirectory);
}

function samePath(first: string, second: string): boolean {
  if (process.platform === "win32") {
    return first.toLowerCase() === second.toLowerCase();
  }
  return first === second;
}
