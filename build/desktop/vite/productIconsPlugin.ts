import { dirname, extname, resolve } from "node:path";
import type { Plugin } from "vite";
import { generateIcons } from "../../resources/icons/generate.ts";
import { watchRebuild, type RebuildServer } from "../../lib/watchRebuild.ts";

interface ProductIconsPluginOptions {
	readonly sourceDirectory?: string;
	readonly outputFile?: string;
	readonly debounceMilliseconds?: number;
}

interface ProductIconsServer extends RebuildServer {
	readonly watcher: RebuildServer["watcher"] & {
		add(path: string): unknown;
	};
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
	const outputFile = resolve(options.outputFile ?? resolve(import.meta.dirname, "../../../src/ash/base/common/productIcons.ts"));
	const debounceMilliseconds = options.debounceMilliseconds ?? 50;
	let stopWatching: (() => Promise<void>) | undefined;

	return {
		name: "ash-product-icons",
		async closeBundle() { await stopWatching?.(); },
		configureServer(server) {
			server.watcher.add(sourceDirectory);
			stopWatching = watchRebuild(server, path => isDirectSvgChild(path, sourceDirectory), async () => {
				const report = await generateIcons({ outputs: { typescriptFile: outputFile }, sourceDirectory, sourceHandling: "ignore" });
				return report.outputChanged;
			}, debounceMilliseconds);
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
