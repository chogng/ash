import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, createServer, type Connect } from "vite";

import { workbenchEntryPlugin } from "./workbenchEntryPlugin.ts";

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
