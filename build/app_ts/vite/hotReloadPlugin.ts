import { readFile } from "node:fs/promises";
import { relative, resolve, sep, win32 } from "node:path";
import { normalizePath, type HtmlTagDescriptor, type Plugin } from "vite";
import { analyzeHotReloadModule, type HotReloadModuleAnalysis, unsafeHotReloadChangeReason } from "./hotReloadAnalysis.ts";

const hotExportsName = "__ashViteHotReloadExports";

export interface HotReloadPluginOptions {
  readonly desktopRoot?: string;
  readonly setupPath?: string;
}

interface HotReloadContext {
  readonly file: string;
  readonly read?: () => string | Promise<string>;
  readonly server: {
    readonly config: { readonly logger: { info(message: string): void } };
    readonly ws: { send(payload: { readonly type: "full-reload"; readonly path: "*" }): void };
  };
}

export interface AshHotReloadPlugin extends Plugin {
  readonly transformIndexHtml: { readonly order: "pre"; readonly handler: () => HtmlTagDescriptor[] };
  readonly transform: { readonly order: "pre"; readonly handler: (code: string, id: string) => string | undefined };
  readonly handleHotUpdate: (context: HotReloadContext) => Promise<[] | undefined>;
}

/** Owns Vite's development-only bridge to the generic Renderer hot-reload runtime. */
export function hotReloadPlugin(options: HotReloadPluginOptions = {}): AshHotReloadPlugin {
  const desktopRoot = resolveHostPath(options.desktopRoot ?? resolve(import.meta.dirname, "../../../app-ts"));
  const setupPath = resolveHostPath(options.setupPath ?? resolve(import.meta.dirname, "setup-dev.ts"));
  const analyses = new Map<string, HotReloadModuleAnalysis>();
  return {
    name: "ash-hot-reload",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{ tag: "script", attrs: { type: "module", src: viteFileUrl(setupPath) }, injectTo: "head-prepend" }],
    },
    transform: {
      order: "pre",
      handler(code, id) {
        const file = cleanModuleId(id);
        if (!file.endsWith(".ts")) return undefined;
        const analysis = analyzeHotReloadModule(code, file);
        if (!analysis.syntaxValid || analysis.exportNames.length === 0) return undefined;
        if (code.includes(hotExportsName)) throw new Error(`Reserved hot-reload export is already declared: ${hotExportsName}`);
        analyses.set(file, analysis);
        return injectHotReloadBoundary(code, analysis.exportNames, neutralModuleId(file, desktopRoot), analysis.classNames.length > 0);
      },
    },
    async handleHotUpdate(context) {
      const file = cleanModuleId(context.file);
      const previous = analyses.get(file);
      if (!previous) return undefined;
      const code = context.read ? await context.read() : await readFile(file, "utf8");
      const next = analyzeHotReloadModule(code, file);
      if (!next.syntaxValid) return undefined;
      if (previous.classNames.length === 0) {
        analyses.set(file, next);
        return undefined;
      }
      const reason = unsafeHotReloadChangeReason(previous, next);
      analyses.set(file, next);
      if (!reason) return undefined;
      const moduleId = neutralModuleId(file, desktopRoot);
      context.server.config.logger.info(`[hot-reload] Full reload: ${moduleId}: ${reason}`);
      context.server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}

function injectHotReloadBoundary(code: string, exportNames: readonly string[], moduleId: string, patchPrototype: boolean): string {
  const exports = exportNames.join(", ");
  const config = patchPrototype ? '{ mode: "patch-prototype" }' : "{}";
  return `${code}\n\nconst ${hotExportsName} = { ${exports} };\nexport { ${hotExportsName} };\nif (import.meta.hot) {\n  const oldExports = import.meta.hot.data.$hotReloadExports ?? ${hotExportsName};\n  import.meta.hot.data.$hotReloadExports = oldExports;\n  import.meta.hot.accept(newModule => {\n    const newExports = newModule?.${hotExportsName};\n    const acceptNewExports = globalThis.$hotReload_applyNewExports?.({\n      oldExports,\n      newSrc: ${JSON.stringify(moduleId)},\n      config: ${config},\n    });\n    if (!newExports || !acceptNewExports?.(newExports)) import.meta.hot?.invalidate("No compatible hot-reload handler accepted this module");\n  });\n}\n`;
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0];
}

function resolveHostPath(path: string): string {
  return win32.isAbsolute(path) ? path : resolve(path);
}

function viteFileUrl(file: string): string {
  return `/@fs/${normalizePath(file).replaceAll("\\", "/").replace(/^\/+/, "")}`;
}

function neutralModuleId(file: string, root: string): string {
  const path = relative(root, file);
  const normalized = path.split(sep).join("/");
  return normalized.startsWith("../") ? `external/${normalized.replace(/^\.\.\//u, "")}` : normalized;
}
