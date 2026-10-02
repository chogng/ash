import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { DecorationsService } from '../../browser/decorationsService.js';
import type { IDecorationData } from '../../common/decorations.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('DecorationsService caches provider queries and removes styles when labels and providers release them', () => {
	const dom = new JSDOM('<!doctype html><head></head><body></body>');
	using services = new InstantiationService();
	services.registerInstance(ILogService, new NullLoggerService());
	using decorations = services.createInstance(DecorationsService, dom.window.document);
	using changes = new Emitter<readonly URI[]>();
	const uri = URI.file('/workspace/file');
	let queries = 0;
	const provider = decorations.registerDecorationsProvider({
		label: 'Test', onDidChange: changes.event,
		provideDecorations: () => {
			queries += 1;
			return { color: 'description.foreground', letter: 'M', tooltip: 'Modified' };
		},
	});
	const first = decorations.getDecoration(uri, false)!;
	const second = decorations.getDecoration(uri, false)!;
	assert.equal(queries, 1);
	assert.equal(first.labelClassName, second.labelClassName);
	first.dispose();
	assert.match(dom.window.document.head.textContent ?? '', /--ash-description-foreground/u);
	second.dispose();
	assert.equal(dom.window.document.head.textContent, '');
	provider.dispose();
	assert.equal(decorations.getDecoration(uri, false), undefined);
	dom.window.close();
});

test('DecorationsService discards cancelled results after invalidation and provider removal', async () => {
	const dom = new JSDOM('<!doctype html><head></head><body></body>');
	using decorations = new DecorationsService(dom.window.document, new NullLoggerService());
	using changes = new Emitter<readonly URI[]>();
	const uri = URI.file('/workspace/cache/file');
	const first = new DeferredPromise<IDecorationData | undefined>();
	const second = new DeferredPromise<IDecorationData | undefined>();
	const tokens: CancellationToken[] = [];
	using provider = decorations.registerDecorationsProvider({
		label: 'Async', onDidChange: changes.event,
		provideDecorations: (_uri, token) => {
			tokens.push(token);
			return tokens.length === 1 ? first.p : second.p;
		},
	});
	assert.equal(decorations.getDecoration(uri, false), undefined);
	changes.fire([URI.file('/workspace/cache')]);
	assert.equal(tokens[0]!.isCancellationRequested, true);
	assert.equal(decorations.getDecoration(uri, false), undefined);
	await first.complete({ tooltip: 'Old result' });
	await Promise.resolve();
	assert.equal(decorations.getDecoration(uri, false), undefined);
	const notifications: boolean[] = [];
	using listener = decorations.onDidChangeDecorations(event => notifications.push(event.affectsResource(uri)));
	await second.complete({ tooltip: 'Current result', color: 'description.foreground' });
	await Promise.resolve();
	assert.deepEqual(notifications, [true]);
	using result = decorations.getDecoration(uri, false)!;
	assert.equal(result.tooltip, 'Current result');
	provider.dispose();
	assert.equal(decorations.getDecoration(uri, false), undefined);
	dom.window.close();
});

test('DecorationsService combines provider descriptions and bubbles only opted-in child decorations', () => {
	const dom = new JSDOM('<!doctype html><head></head><body></body>');
	using decorations = new DecorationsService(dom.window.document, new NullLoggerService());
	using updates = new Emitter<readonly URI[]>();
	const folder = URI.file('/workspace/folder');
	const child = URI.joinPath(folder, 'file');
	using ignored = decorations.registerDecorationsProvider({ label: 'Ignore', onDidChange: Event.None, provideDecorations: resource => resource.path === child.path ? { color: 'description.foreground', tooltip: 'Ignored' } : undefined });
	using marker = decorations.registerDecorationsProvider({ label: 'Problems', onDidChange: updates.event, provideDecorations: resource => resource.path === child.path ? { weight: 10, color: 'error.foreground', letter: '!', tooltip: 'Error', bubble: true } : undefined });
	using file = decorations.getDecoration(child, false)!;
	assert.equal(file.tooltip, 'Error • Ignored');
	assert.equal(decorations.getDecoration(folder, false), undefined);
	using parent = decorations.getDecoration(folder, true)!;
	assert.equal(parent.tooltip, 'Error');
	marker.dispose();
	assert.equal(decorations.getDecoration(folder, true), undefined);
	dom.window.close();
});

test('DecorationsService cancels outstanding requests and removes its stylesheet on disposal', async () => {
	const dom = new JSDOM('<!doctype html><head></head><body></body>');
	const decorations = new DecorationsService(dom.window.document, new NullLoggerService());
	const pending = new DeferredPromise<IDecorationData | undefined>();
	let token: CancellationToken | undefined;
	using provider = decorations.registerDecorationsProvider({ label: 'Pending', onDidChange: Event.None, provideDecorations: (_uri, cancellation) => { token = cancellation; return pending.p; } });
	decorations.getDecoration(URI.file('/workspace/file'), false);
	decorations.dispose();
	assert.equal(token!.isCancellationRequested, true);
	await pending.complete({ tooltip: 'Late result' });
	await Promise.resolve();
	assert.equal(dom.window.document.querySelector('[data-ash-decorations]'), null);
	dom.window.close();
});


test('DecorationsService retains independent provider colors and badges and semantic icon colors', () => {
	const dom = new JSDOM('<!doctype html><head></head><body></body>');
	using decorations = new DecorationsService(dom.window.document, new NullLoggerService());
	using status = decorations.registerDecorationsProvider({ label: 'Status', onDidChange: Event.None, provideDecorations: () => ({ color: 'description.foreground', tooltip: 'Modified' }) });
	using marker = decorations.registerDecorationsProvider({ label: 'Marker', onDidChange: Event.None, provideDecorations: () => ({ weight: 10, letter: { ...Lxicon.add, color: { id: 'error.foreground' } }, tooltip: 'Problem' }) });
	using handle = decorations.getDecoration(URI.file('/workspace/file'), false)!;
	assert.equal(handle.tooltip, 'Problem • Modified');
	assert.match(dom.window.document.head.textContent!, /--ash-description-foreground/u);
	assert.match(dom.window.document.head.textContent!, /--ash-error-foreground/u);
	assert.deepEqual(handle.icon, { ...Lxicon.add, color: { id: 'error.foreground' } });
	assert.match(dom.window.document.head.textContent!, /--ash-icon-label-suffix-icon-color/u);
	handle.dispose();
	assert.equal(dom.window.document.head.textContent, '');
	dom.window.close();
});
