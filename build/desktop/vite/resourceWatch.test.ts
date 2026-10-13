import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { localizationPlugin } from '../../resources/localization.ts';
import { browserExtensionRoots } from '../../builtin/extensions.ts';
import { browserExtensionsPlugin } from './extensionsPlugin.ts';
import { productIconsPlugin } from './productIconsPlugin.ts';

test('all resource plugins remove subscriptions and cancel pending generation on shutdown', t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const repository = resolve(import.meta.dirname, '../../..');
	const plugins = [
		{ create: localizationPlugin, path: join(repository, 'src/ash/feature.ts') },
		{ create: browserExtensionsPlugin, path: join(browserExtensionRoots[0]!, 'package.json') },
		{ create: productIconsPlugin, path: join(repository, 'resources/icons/close.svg') },
	];
	for (const { create, path } of plugins) {
		for (const middleware of [false, true]) {
			const watcher = Object.assign(new EventEmitter(), { add() { } });
			const httpServer = middleware ? null : new EventEmitter();
			const server = {
				watcher, httpServer,
				ws: { send() { assert.fail('closed server received a reload'); } },
				config: { logger: { error() { assert.fail('pending generation ran after close'); } } },
			};
			// Repeated setup uses the same event emitter to detect retained subscriptions.
			for (let index = 0; index < 3; index++) {
				const plugin = create();
				assert.ok(typeof plugin.configureServer === 'function');
				assert.ok(typeof plugin.closeBundle === 'function');
				Reflect.apply(plugin.configureServer, {}, [server]);
				assert.equal(watcher.listenerCount('all'), 1);
				watcher.emit('all', 'change', path);
				if (httpServer) { httpServer.emit('close'); }
				Reflect.apply(plugin.closeBundle, {}, []);
				assert.equal(watcher.listenerCount('all'), 0);
				assert.equal(httpServer?.listenerCount('close') ?? 0, 0);
				t.mock.timers.tick(100);
			}
		}
	}
});

test('Vite middleware server closes the icon watcher through the plugin lifecycle', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-resource-watch-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	const server = await createServer({
		configFile: false, root,
		plugins: [productIconsPlugin({ sourceDirectory: root, outputFile: join(root, 'icons.ts') })],
		server: { middlewareMode: true, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	t.after(() => server.close());
	assert.equal(server.httpServer, null);
	assert.ok(server.watcher.listenerCount('all') > 0);
	await server.close();
	assert.equal(server.watcher.listenerCount('all'), 0);
});
