import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { normalizePath, type Connect, type Plugin } from "vite";
import type { ICSSDevelopmentService } from '../../../src/ash/platform/cssDev/node/cssDevService.ts';

interface WorkbenchEntryServer {
	readonly middlewares: {
		use(middleware: Connect.NextHandleFunction): void;
	};
	transformIndexHtml(url: string, html: string): Promise<string>;
}

type ProductPage = {
	readonly url: string;
	readonly inputFile: string;
} & ({ readonly sourceFile: string; } | { readonly html: string; });

interface CSSDevelopmentHost {
	readonly service: ICSSDevelopmentService;
	readonly sourceRoot: string;
}

export type AshWorkbenchEntryPlugin = Omit<Plugin, "configureServer"> & {
	readonly configureServer: (server: WorkbenchEntryServer) => void;
};

/**
 * Hosts product entry URLs independently of the layer that owns their HTML source.
 */
export function workbenchEntryPlugin(entryPath = '/browser/workbench/workbench.html', pages: readonly ProductPage[] = [], cssDevelopment?: CSSDevelopmentHost): AshWorkbenchEntryPlugin {
	const inputs = new Map(pages.map(page => [normalizePath(page.inputFile), page]));
	const inputFilter = inputs.size ? new RegExp(`^(?:${[...inputs.keys()].map(path => path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`, 'u') : undefined;
	let root: string;
	let development = false;
	async function readPage(page: ProductPage): Promise<string> {
		if ('html' in page) { return page.html; }
		const html = await readFile(page.sourceFile, 'utf8');
		// Vite's HTML input is rooted under Code, while the Sessions module stays at its owning source path.
		return html.replace(/(<script\b[^>]*\bsrc=["'])(\.\/[^"']+)(["'])/gu, (_match, prefix: string, source: string, suffix: string) => {
			const file = normalizePath(resolve(dirname(page.sourceFile), source));
			return `${prefix}/@fs/${file.replace(/^\/+/u, '')}${suffix}`;
		});
	}
	return {
		name: "ash-workbench-entry",
		configResolved(config) {
			root = config.root;
			development = config.command === 'serve';
		},
		transformIndexHtml: {
			order: 'pre',
			async handler(html) {
				if (!development || !cssDevelopment?.service.isEnabled) return html;
				const modules = (await cssDevelopment.service.getCssModules()).map(module => {
					const file = resolve(cssDevelopment.sourceRoot, module);
					const path = normalizePath(relative(root, file));
					const url = path.startsWith('../') ? `/@fs/${normalizePath(file).replace(/^\/+/, '')}` : `/${path}`;
					const encoded = encodeURI(url).replaceAll('#', '%23').replaceAll('?', '%3F');
					return { specifiers: [encoded, `${encoded}?import`], stylesheet: `${encoded}?direct` };
				});
				const template = await readFile(resolve(import.meta.dirname, '../../../src/ash/code/browser/workbench/workbench-dev.html'), 'utf8');
				// Escape HTML delimiters before putting source paths in an executable page.
				const prelude = template.replace('{{WORKBENCH_DEV_CSS_MODULES}}', JSON.stringify(modules).replaceAll('<', '\\u003c'));
				return html.replace(/<head\b[^>]*>/iu, head => `${head}\n${prelude}`);
			},
		},
		// Filter before invoking JavaScript so ordinary renderer modules bypass the HTML mount.
		resolveId: inputs.size ? { filter: { id: inputFilter }, handler: id => id } : undefined,
		load: inputs.size ? { filter: { id: inputFilter }, handler: id => readPage(inputs.get(normalizePath(id))!) } : undefined,
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const method = request.method;
				const page = pages.find(page => request.url?.split('?')[0] === page.url);
				if (page && (method === 'GET' || method === 'HEAD') && request.url?.split('?')[0] === page.url) {
					void (async () => {
						const html = await server.transformIndexHtml(request.url!, await readPage(page));
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
