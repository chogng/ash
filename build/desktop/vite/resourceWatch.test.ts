import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { cp, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createLogger, createServer, type HMRPayload } from 'vite';
import { localizationPlugin } from '../../resources/localization.ts';
import { browserExtensionRoots } from '../../builtin/extensions.ts';
import { browserExtensionsPlugin } from './extensionsPlugin.ts';
import { productIconsPlugin } from './productIconsPlugin.ts';

const repository = resolve(import.meta.dirname, '../../..');
const execute = promisify(execFile);

async function iconFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'ash-resource-watch-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceDirectory = join(root, 'icons');
	await cp(join(repository, 'resources/icons'), sourceDirectory, { recursive: true });
	return { root, sourceDirectory, outputFile: join(root, 'icons.ts'), fontDirectory: join(root, 'fonts') };
}

test('icon generation watches formatter configuration and implementation', async () => {
	const inputs = [join(repository, 'tsfmt.json'), join(repository, '.prettierrc.toml'), join(repository, 'build/format.ts'), join(repository, 'build/lib/generatedTypeScript.ts')];
	const watched: string[] = [];
	const watcher = Object.assign(new EventEmitter(), {
		add(path: string) {
			watched.push(path);
		},
	});
	const httpServer = new EventEmitter();
	const plugin = productIconsPlugin();
	const close = plugin.closeBundle;
	if (typeof close !== 'function') throw new Error('Missing plugin cleanup');
	try {
		plugin.configureServer({ watcher, httpServer, ws: { send() { } }, config: { logger: { error() { } } } });
		for (const file of inputs) {
			assert.ok(watched.includes(file));
			assert.deepEqual(plugin.handleHotUpdate({ file }), []);
		}
	} finally {
		await Reflect.apply(close, {}, []);
	}
	assert.equal(watcher.listenerCount('all'), 0);
});

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
				watcher,
				httpServer,
				ws: {
					send() {
						assert.fail('closed server received a reload');
					},
				},
				config: {
					logger: {
						error() {
							assert.fail('pending generation ran after close');
						},
					},
				},
			};
			// Repeated setup uses the same event emitter to detect retained subscriptions.
			for (let index = 0; index < 3; index++) {
				const plugin = create();
				assert.ok(typeof plugin.configureServer === 'function');
				assert.ok(typeof plugin.closeBundle === 'function');
				Reflect.apply(plugin.configureServer, {}, [server]);
				assert.equal(watcher.listenerCount('all'), 1);
				watcher.emit('all', 'change', path);
				if (httpServer) {
					httpServer.emit('close');
				}
				Reflect.apply(plugin.closeBundle, {}, []);
				assert.equal(watcher.listenerCount('all'), 0);
				assert.equal(httpServer?.listenerCount('close') ?? 0, 0);
				t.mock.timers.tick(100);
			}
		}
	}
});

test('Vite middleware server closes the icon watcher through the plugin lifecycle', async t => {
	const fixture = await iconFixture(t);
	const { root } = fixture;
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	const server = await createServer({
		configFile: false,
		root,
		plugins: [productIconsPlugin(fixture)],
		server: { middlewareMode: true, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	t.after(() => server.close());
	assert.equal(server.httpServer, null);
	assert.ok(server.watcher.listenerCount('all') > 0);
	await server.close();
	assert.equal(server.watcher.listenerCount('all'), 0);
});

test('SVG imports rebuild both real WOFF2 faces and the catalog, preserve last good outputs on failure, and recover', { timeout: 180_000 }, async t => {
	const fixture = await iconFixture(t);
	const events = new EventEmitter();
	const reloads: unknown[] = [];
	async function nextReload(): Promise<unknown[]> {
		const controller = new AbortController();
		try {
			return await Promise.race([
				once(events, 'reload', { signal: controller.signal }),
				once(events, 'failure', { signal: controller.signal }).then(([message]) => {
					throw new Error(String(message));
				}),
			]);
		} finally {
			controller.abort();
		}
	}
	const plugin = productIconsPlugin({ ...fixture, debounceMilliseconds: 5 });
	const close = plugin.closeBundle;
	assert.equal(typeof close, 'function');
	if (typeof close !== 'function') throw new Error('Missing plugin cleanup');
	const logger = createLogger('silent');
	logger.error = message => {
		events.emit('failure', message);
	};
	const server = await createServer({
		configFile: false,
		root: fixture.root,
		customLogger: logger,
		plugins: [plugin],
		server: { host: '127.0.0.1', port: 0 },
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	t.after(() => server.close());
	server.ws.send = (message: HMRPayload | string) => {
		if (typeof message !== 'string' && message.type === 'full-reload') {
			reloads.push(message);
			events.emit('reload', message);
		}
	};
	await server.listen();
	const original = JSON.parse(await readFile(join(fixture.sourceDirectory, 'font/manifest.json'), 'utf8'));
	const paths = [
		fixture.outputFile,
		join(fixture.sourceDirectory, 'font/manifest.json'),
		join(fixture.sourceDirectory, 'manifest.json'),
		...['lxicon.woff2', 'lxicon-variable.woff2'].map(name => join(fixture.fontDirectory, name)),
	];
	const contents = () => Promise.all(paths.map(path => readFile(path)));
	const first = join(fixture.sourceDirectory, 'watch-first.svg');
	const second = join(fixture.sourceDirectory, 'watch-second.svg');
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="none" stroke="#000" d="M2 2H14V14H2Z"/></svg>';
	const imported = nextReload();
	await Promise.all([writeFile(first, svg), writeFile(second, svg.replace('fill="none"', 'fill="#e53c43"'))]);
	assert.deepEqual((await imported)[0], { type: 'full-reload' });
	const manifest = JSON.parse(await readFile(paths[1]!, 'utf8'));
	for (const [id, codepoint] of Object.entries(original.codepoints)) assert.equal(manifest.codepoints[id], codepoint);
	assert.equal(parseInt(manifest.codepoints['watch-first'], 16), Math.max(...Object.values(original.codepoints).map(value => parseInt(String(value), 16))) + 1);
	assert.equal(parseInt(manifest.codepoints['watch-second'], 16), parseInt(manifest.codepoints['watch-first'], 16) + 1);
	assert.equal(manifest.color['watch-second'], 'Source solid colors or opacity');
	assert.match(await readFile(fixture.outputFile, 'utf8'), /watchFirst: registerLxicon\("watch-first", 0x[\da-f]+\)/);
	const python = join(repository, '.build/product-icon-font/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
	const { stdout } = await execute(python, [
		'-c',
		'import json,sys; from fontTools.ttLib import TTFont; fonts=[TTFont(path) for path in sys.argv[1:]]; print(json.dumps([{ "cmap": font.getBestCmap(), "colors": [record.BaseGlyph for record in font["COLR"].table.BaseGlyphList.BaseGlyphPaintRecord] } for font in fonts]))',
		...paths.slice(3),
	]);
	for (const font of JSON.parse(stdout)) {
		assert.equal(font.cmap[parseInt(manifest.codepoints['watch-first'], 16)], 'watch-first');
		assert.equal(font.cmap[parseInt(manifest.codepoints['watch-second'], 16)], 'watch-second');
		assert.ok(font.colors.includes('watch-second'));
	}
	for (const file of [first, fixture.outputFile, ...paths.slice(3)]) assert.deepEqual(plugin.handleHotUpdate({ file }), []);
	assert.equal(plugin.handleHotUpdate({ file: join(fixture.root, 'unrelated.ts') }), undefined);

	const before = await contents();
	const edited = nextReload();
	await writeFile(first, svg.replace('H14', 'H12'));
	await edited;
	const after = await contents();
	assert.deepEqual(after[0], before[0], 'an outline-only edit keeps the catalog');
	assert.notDeepEqual(after[3], before[3], 'the IDE face must rebuild even when the catalog stays unchanged');
	assert.notDeepEqual(after[4], before[4], 'the Sessions face must rebuild as well');
	const modified = await Promise.all(paths.map(async path => (await stat(path)).mtimeMs));
	await plugin.buildStart();
	assert.deepEqual(await Promise.all(paths.map(async path => (await stat(path)).mtimeMs)), modified, 'a no-op build must not rewrite watched outputs');

	const broken = join(fixture.sourceDirectory, 'watch-broken.svg');
	const failed = once(events, 'failure');
	await writeFile(broken, svg.replace('fill="none"', 'fill="url(#gradient)"'));
	assert.match(String((await failed)[0]), /gradients|external resources/);
	assert.deepEqual(await contents(), after, 'failed conversion must not publish any partial catalog or font');
	assert.equal(reloads.length, 2, 'failed conversion must not refresh the renderer');

	const recovered = nextReload();
	await unlink(broken);
	await unlink(second);
	await recovered;
	assert.doesNotMatch(await readFile(fixture.outputFile, 'utf8'), /watchSecond/);
	assert.equal(JSON.parse(await readFile(paths[1]!, 'utf8')).codepoints['watch-second'], manifest.codepoints['watch-second'], 'removed codepoints stay reserved');
	assert.equal(reloads.length, 3);
});
