import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger, createServer, type Plugin } from 'vite';
import { prepareViteClient } from './developmentServer.ts';

async function fixture(plugin: Plugin) {
	const root = await mkdtemp(join(tmpdir(), 'ash-vite-preparation-'));
	await writeFile(join(root, 'entry.ts'), "import { value } from './dependency.ts';\nthrow new Error('Renderer must not execute during preparation');\nexport { value };\n");
	await writeFile(join(root, 'dependency.ts'), 'export const value = 42;\n');
	const errors: string[] = [];
	const logger = createLogger('silent');
	logger.error = message => { errors.push(message); };
	const server = await createServer({
		configFile: false, root, publicDir: false, customLogger: logger,
		server: { middlewareMode: true, hmr: false, watch: null },
		optimizeDeps: { noDiscovery: true },
		plugins: [plugin],
	});
	return { server, errors, async close() { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

test('development preparation waits for a delayed static dependency without executing the Renderer', async () => {
	const started = Promise.withResolvers<void>();
	const dependency = Promise.withResolvers<void>();
	const setup = await fixture({
		name: 'delayed-dependency',
		async transform(code, id) {
			if (!id.endsWith('/dependency.ts')) return;
			started.resolve();
			await dependency.promise;
			return code;
		},
	});
	try {
		let ready = false;
		const pending = prepareViteClient(setup.server, ['/entry.ts'], setup.errors).then(() => { ready = true; });
		await started.promise;
		assert.equal(ready, false);
		dependency.resolve();
		await pending;
		assert.match((await setup.server.environments.client.moduleGraph.getModuleByUrl('/dependency.ts'))!.transformResult!.code, /value = 42/u);
		assert.deepEqual(setup.errors, []);
	} finally {
		dependency.resolve();
		await setup.close();
	}
});

test('development preparation rejects a failed static dependency reported by Vite', async () => {
	const setup = await fixture({
		name: 'failed-dependency',
		transform(_code, id) { if (id.endsWith('/dependency.ts')) throw new Error('Dependency transform rejected'); },
	});
	try {
		await assert.rejects(prepareViteClient(setup.server, ['/entry.ts'], setup.errors), error => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.errors.map((entry: Error) => entry.message).join('\n'), /Dependency transform rejected/u);
			return true;
		});
	} finally { await setup.close(); }
});
