import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { normalizePath, type Connect, type Plugin } from "vite";

interface WorkbenchEntryServer {
	readonly middlewares: {
		use(middleware: Connect.NextHandleFunction): void;
	};
	transformIndexHtml(url: string, html: string): Promise<string>;
}

interface ProductPage {
	readonly url: string;
	readonly sourceFile: string;
	readonly inputFile: string;
}

export type AshWorkbenchEntryPlugin = Omit<Plugin, "configureServer"> & {
	readonly configureServer: (server: WorkbenchEntryServer) => void;
};

/**
 * Hosts product entry URLs independently of the layer that owns their HTML source.
 */
export function workbenchEntryPlugin(entryPath = '/browser/workbench/workbench.html', page?: ProductPage): AshWorkbenchEntryPlugin {
	const inputFilter = page ? new RegExp(`^${normalizePath(page.inputFile).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') : undefined;
	async function readPage(): Promise<string> {
		const html = await readFile(page!.sourceFile, 'utf8');
		// Vite's HTML input is rooted under Code, while the Sessions module stays at its owning source path.
		return html.replace(/(<script\b[^>]*\bsrc=["'])(\.\/[^"']+)(["'])/gu, (_match, prefix: string, source: string, suffix: string) => {
			const file = normalizePath(resolve(dirname(page!.sourceFile), source));
			return `${prefix}/@fs/${file.replace(/^\/+/u, '')}${suffix}`;
		});
	}
	return {
		name: "ash-workbench-entry",
		// Filter before invoking JavaScript so ordinary renderer modules bypass the HTML mount.
		resolveId: page ? { filter: { id: inputFilter }, handler: id => id } : undefined,
		load: page ? { filter: { id: inputFilter }, handler: () => readPage() } : undefined,
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const method = request.method;
				if (page && (method === 'GET' || method === 'HEAD') && request.url?.split('?')[0] === page.url) {
					void (async () => {
						const html = await server.transformIndexHtml(request.url!, await readPage());
						response.statusCode = 200;
						response.setHeader('Content-Type', 'text/html; charset=utf-8');
						response.setHeader('Cache-Control', 'no-store');
						response.end(method === 'HEAD' ? undefined : html);
					})().catch(next);
					return;
				}
				const targetsRoot = request.url === "/" || request.url?.startsWith("/?");
				if ((method !== "GET" && method !== "HEAD") || !targetsRoot) {
					next();
					return;
				}

				response.statusCode = 302;
				response.setHeader("Cache-Control", "no-store");
				const query = request.url?.indexOf('?') ?? -1;
				response.setHeader("Location", `${entryPath}${query >= 0 ? request.url!.slice(query) : ''}`);
				response.end();
			});
		},
	};
}
