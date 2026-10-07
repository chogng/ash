import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, createServer, type Connect } from "vite";

import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";
import { CSSDevelopmentService } from '../../../src/ash/platform/cssDev/node/cssDevService.ts';

test("Workbench entry redirects root requests to the shared Workbench", () => {
	const middleware = configuredMiddleware();
	const result = invoke(middleware, { method: "GET", url: "/?theme=dark" });
	assert.deepEqual(result, {
		ended: true,
		headers: {
			"Cache-Control": "no-store",
			Location: "/browser/workbench/workbench.html?theme=dark",
		},
		nextCalled: false,
		statusCode: 302,
	});
});

test("Workbench entry leaves non-root and mutating requests to Vite", () => {
	const middleware = configuredMiddleware();
	for (const request of [
		{ method: "GET", url: "/browser/workbench/workbench.html" },
		{ method: "POST", url: "/" },
	]) {
		assert.deepEqual(invoke(middleware, request), {
			ended: false,
			headers: {},
			nextCalled: true,
			statusCode: undefined,
		});
	}
});

test('Sessions development opens its page directly and preserves workspace parameters', () => {
	const middleware = configuredMiddleware('/browser/sessions/sessions-code.html');
	assert.equal(invoke(middleware, { method: 'HEAD', url: '/?folder=project' }).headers.Location, '/browser/sessions/sessions-code.html?folder=project');
});

test('Sessions HTML is served and built from its owning layer with working module URLs', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-product-page-'));
	const root = join(directory, 'code');
	const source = join(directory, 'sessions/electron-browser/sessions.html');
	const output = join(directory, 'output');
	await mkdir(root);
	await mkdir(dirname(source), { recursive: true });
	await writeFile(source, '<html><body><script type="module" src="./sessions.ts"></script></body></html>');
	await writeFile(join(dirname(source), 'sessions.ts'), 'globalThis.sessionsEntryLoaded = true;');
	const url = '/sessions/electron-browser/sessions.html';
	const input = resolve(root, url.slice(1));
	const page = { url, inputFile: input, sourceFile: source };
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	try {
		server = await createServer({ configFile: false, root, plugins: [workbenchEntryPlugin(undefined, page)], server: { host: '127.0.0.1', port: 0 } });
		await server.listen();
		const address = server.httpServer!.address();
		assert.ok(address && typeof address !== 'string');
		const origin = `http://127.0.0.1:${address.port}`;
		const response = await fetch(`${origin}${url}?workspace=one`);
		assert.equal(response.status, 200);
		const html = await response.text();
		const module = /<script type="module" src="([^"\n]*sessions\.ts)"/u.exec(html)?.[1];
		assert.ok(module, html);
		assert.match(await (await fetch(new URL(module, origin))).text(), /sessionsEntryLoaded/);
		const head = await fetch(`${origin}${url}`, { method: 'HEAD' });
		assert.equal(head.status, 200);
		assert.equal(await head.text(), '');
		await server.close();
		server = undefined;
		assert.equal(dirname(resolve(output)), resolve(directory));
		await build({ configFile: false, root, base: './', plugins: [workbenchEntryPlugin(undefined, page)], build: { outDir: output, emptyOutDir: true, rolldownOptions: { input } } });
		const builtHtml = await readFile(join(output, url.slice(1)), 'utf8');
		const builtModule = /src="([^"]+\.js)"/u.exec(builtHtml)?.[1];
		assert.ok(builtModule, builtHtml);
		assert.doesNotMatch(builtHtml, /@fs\/|sessions\.ts/u);
		assert.match(await readFile(resolve(output, dirname(url.slice(1)), builtModule), 'utf8'), /sessionsEntryLoaded/);
	} finally {
		await server?.close();
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
		await rm(directory, { recursive: true, force: true });
	}
});

test('Development pages receive CSS import maps while production keeps bundled styles', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-css-development-'));
	const root = join(directory, 'code');
	const css = join(directory, 'shared/style.css');
	const output = join(directory, 'output');
	await mkdir(root);
	await mkdir(dirname(css));
	await writeFile(css, '.css-test { color: red; }');
	await writeFile(join(root, 'index.html'), '<html><head></head><body><script type="module" src="./entry.ts"></script></body></html>');
	await writeFile(join(root, 'entry.ts'), 'import "../shared/style.css";');
	const service = new CSSDevelopmentService({ sourceRoot: directory, isBuilt: false });
	const plugin = () => workbenchEntryPlugin(undefined, undefined, { service, sourceRoot: directory });
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	try {
		server = await createServer({ configFile: false, root, plugins: [plugin()], server: { host: '127.0.0.1', port: 0 } });
		await server.listen();
		const address = server.httpServer!.address();
		assert.ok(address && typeof address !== 'string');
		const origin = `http://127.0.0.1:${address.port}`;
		const html = await (await fetch(`${origin}/index.html`)).text();
		assert.match(html, /ash-workbench-css-modules/u);
		const data = /type="application\/json">\s*([^<]+)<\/script>/u.exec(html)?.[1];
		assert.ok(data, html);
		const modules = JSON.parse(data) as { specifiers: string[]; stylesheet: string; }[];
		assert.equal(modules.length, 1);
		const transformed = await (await fetch(`${origin}/entry.ts`)).text();
		assert.ok(modules[0].specifiers.some(specifier => transformed.includes(specifier)), transformed);
		assert.match(await (await fetch(new URL(modules[0].stylesheet, origin))).text(), /color: red/u);
		await server.close();
		server = undefined;
		await build({ configFile: false, root, plugins: [plugin()], build: { outDir: output, emptyOutDir: true } });
		const built = await readFile(join(output, 'index.html'), 'utf8');
		assert.doesNotMatch(built, /ash-workbench-css-modules|_ASH_CSS_LOAD|importmap/u);
		assert.match(built, /rel="stylesheet"/u);
	} finally {
		await server?.close();
		assert.equal(dirname(directory), tmpdir());
		await rm(directory, { recursive: true, force: true });
	}
});

test('CSS discovery caches relative sorted paths and skips filesystem access in builds', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-css-modules-'));
	try {
		await mkdir(join(directory, 'nested'));
		await writeFile(join(directory, 'z.css'), '');
		await writeFile(join(directory, 'nested/a.css'), '');
		await writeFile(join(directory, 'ignored.ts'), '');
		const service = new CSSDevelopmentService({ sourceRoot: directory, isBuilt: false });
		const first = service.getCssModules();
		assert.equal(first, service.getCssModules());
		assert.deepEqual(await first, ['nested/a.css', 'z.css']);
		await writeFile(join(directory, 'new.css'), '');
		assert.deepEqual(await service.getCssModules(), ['nested/a.css', 'z.css']);
		const built = new CSSDevelopmentService({ sourceRoot: join(directory, 'missing'), isBuilt: true });
		assert.equal(built.isEnabled, false);
		assert.deepEqual(await built.getCssModules(), []);
		await assert.rejects(new CSSDevelopmentService({ sourceRoot: join(directory, 'missing'), isBuilt: false }).getCssModules(), { code: 'ENOENT' });
	} finally {
		assert.equal(dirname(directory), tmpdir());
		await rm(directory, { recursive: true, force: true });
	}
});

function configuredMiddleware(entryPath?: string): Connect.NextHandleFunction {
	let middleware: Connect.NextHandleFunction | undefined;
	workbenchEntryPlugin(entryPath).configureServer({
		transformIndexHtml: async (_url, html) => html,
		middlewares: {
			use(candidate) {
				middleware = candidate;
			},
		},
	});
	assert.ok(middleware);
	return middleware;
}

function invoke(middleware: Connect.NextHandleFunction, request: { readonly method: string; readonly url: string; }) {
	const headers: Record<string, string | readonly string[] | number> = {};
	let ended = false;
	let nextCalled = false;
	const response = {
		statusCode: undefined as number | undefined,
		setHeader(name: string, value: string | readonly string[] | number) {
			headers[name] = value;
			return response;
		},
		end() {
			ended = true;
			return response;
		},
	};
	middleware(request as IncomingMessage, response as unknown as ServerResponse, () => {
		nextCalled = true;
	});
	return { ended, headers, nextCalled, statusCode: response.statusCode };
}
