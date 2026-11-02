import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope, type IBrowserViewService, type IBrowserViewInfo, type IBrowserViewCreateOptions, type BrowserViewEvent } from '../../../../../platform/browserView/common/browserView.js';
import type { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { AgentHostCanvasCollection, type ICanvasProvider } from '../../common/agentHostCanvas.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import type { INotificationService, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { readFile } from 'node:fs/promises';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';

suite('Agent Canvas provider ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('removing an owner cancels its extension callback before a native page can be created', async () => {
		using resources = new DisposableStore();
		const started = promiseWithResolvers<AbortSignal>();
		const collection = resources.add(new AgentHostCanvasCollection({ onDidEvent: Event.None, getBrowserViews: async () => [], getOrCreateBrowserView: async () => assert.fail('Removed owners cannot create pages') } as unknown as IBrowserViewService, { activateByEvent: async () => { } } as unknown as IExtensionService, {} as INotificationService));
		const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/source'), chat: URI.parse('ash-thread:/source') };
		const definition = { canvasId: 'board', extensionId: 'fixture', extensionSource: 'plugin' as const, displayName: 'Board', description: '', requiresInput: false };
		resources.add(collection.register({
			definition, signal: new AbortController().signal, close: async () => { }, open: async (_owner, _instance, signal) => {
				started.resolve(signal);
				return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Owner removed')), { once: true }));
			}
		}));
		const opening = collection.createContext(owner).definitionProvider!.openCanvas(definition, 'preview');
		const signal = await started.promise;
		collection.removeOwner(owner);
		await assert.rejects(opening, /Owner removed/);
		assert.equal(signal.aborted, true);
	});
	test('binds definitions and live sources to the exact conversation, preserves pending identity, and retires pages', async () => {
		using resources = new DisposableStore();
		const events = resources.add(new Emitter<BrowserViewEvent>());
		const pages = new Map<string, IBrowserViewInfo>();
		const browser = {
			onDidEvent: events.event, getBrowserViews: async () => [],
			getOrCreateBrowserView: async (id: string, options: IBrowserViewCreateOptions) => {
				const info: IBrowserViewInfo = {
					id, owner: options.owner, host: { windowId: 1 }, session: options.session, canvas: options.canvas,
					state: { isDevToolsOpen: false, targetId: id, title: '', url: options.initialUrl, loading: false, visible: false, canGoBack: false, canGoForward: false }
				};
				pages.set(id, info); events.fire({ type: 'created', info }); return info;
			},
			destroyBrowserView: async (id: string) => { pages.delete(id); events.fire({ type: 'closed', targetId: id }); },
			loadURL: async (id: string, url: string) => { const info = pages.get(id)!; const state = { ...info.state, url }; pages.set(id, { ...info, state }); events.fire({ type: 'stateChanged', state }); },
		} as unknown as IBrowserViewService;
		const collection = resources.add(new AgentHostCanvasCollection(browser, { activateByEvent: async () => { } } as unknown as IExtensionService, { warn: () => assert.fail('User-owned pages refresh without a warning') } as unknown as INotificationService));
		await Promise.resolve();
		const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one') };
		let state: 'ready' | 'pending' | 'removed' = 'ready';
		let closes = 0;
		const calls: unknown[] = [];
		const provider: ICanvasProvider = {
			definition: { canvasId: 'board', extensionId: 'fixture', extensionSource: 'user', displayName: 'Board', description: '', requiresInput: false },
			signal: new AbortController().signal,
			open: async (context, instanceId) => { calls.push({ context, instanceId }); return { url: 'http://localhost:9000/board' }; },
			resolve: async () => state === 'ready' ? { url: 'http://localhost:9000/updated', title: 'Updated' } : state === 'pending' ? undefined : null,
			close: async () => { closes++; },
		};
		const registration = resources.add(collection.register(provider));
		const context = collection.createContext(owner);
		await context.definitionProvider!.openCanvas(provider.definition, 'preview');
		assert.equal(calls.length, 1);
		assert.deepEqual((calls[0] as { context: unknown; }).context, owner);
		const canvas = context.canvases.get()![0]!;
		assert.equal(collection.createContext({ ...owner, chat: URI.parse('ash-thread:/other') }).canvases.get()!.length, 0);
		const request = context.openRequests!.get().get('preview');
		assert.equal(request?.succeeded, true);
		state = 'pending'; await collection.refreshProvider(provider);
		assert.equal(context.canvases.get()![0]!.resource.toString(), canvas.resource.toString());
		assert.equal(context.canvases.get()![0]!.source, undefined);
		state = 'ready'; await collection.refreshProvider(provider);
		assert.equal(context.canvases.get()![0]!.title, 'Updated');
		assert.equal(context.openRequests!.get().get('preview'), request, 'source updates do not invent an explicit open');
		await browser.loadURL(canvas.resource.path.slice(1), 'http://localhost:9000/updated/nested-route');
		await collection.refreshProvider(provider);
		assert.equal(pages.get(canvas.resource.path.slice(1))!.state.url, 'http://localhost:9000/updated/nested-route', 'metadata refresh must retain navigation inside the live page');
		await context.closeCanvas!(context.canvases.get()![0]!);
		assert.equal(closes, 1); assert.equal(pages.size, 0);
		await context.definitionProvider!.openCanvas(provider.definition, 'preview');
		registration.dispose(); await Promise.resolve(); assert.equal(pages.size, 0);
		await assert.rejects(context.definitionProvider!.openCanvas(provider.definition, 'preview'));
	});

	for (const locale of ['en', 'zh-CN']) {
		test('retains an Agent page when its provider changes URL and lets the user open the new source in ' + locale, async () => {
			try {
				if (locale === 'zh-CN') { setNlsMessages(locale, JSON.parse(await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'))); }
				using resources = new DisposableStore();
				const events = resources.add(new Emitter<BrowserViewEvent>());
				const pages = new Map<string, IBrowserViewInfo>();
				const warnings: (NotificationMessage | NotificationMessage[])[] = [];
				const browser = {
					onDidEvent: events.event, getBrowserViews: async () => [],
					loadURL: async () => assert.fail('Provider refresh cannot navigate an Agent page without execution authority'),
					getOrCreateBrowserView: async (id: string, options: IBrowserViewCreateOptions) => {
						assert.deepEqual(options.owner, { type: 'user' });
						const info: IBrowserViewInfo = {
							id, owner: options.owner, host: { windowId: 1 }, session: options.session, canvas: options.canvas,
							state: { isDevToolsOpen: false, targetId: id, title: '', url: options.initialUrl, loading: false, visible: false, canGoBack: false, canGoForward: false }
						};
						pages.set(id, info); events.fire({ type: 'created', info }); return info;
					},
					destroyBrowserView: async (id: string) => { pages.delete(id); events.fire({ type: 'closed', targetId: id }); },
				} as unknown as IBrowserViewService;
				const collection = resources.add(new AgentHostCanvasCollection(browser, { activateByEvent: async () => { } } as unknown as IExtensionService,
					{ warn: message => { warnings.push(message); } } as INotificationService));
				await Promise.resolve();
				let source = { url: 'http://localhost:9000/board', title: 'Renamed board' };
				const provider: ICanvasProvider = {
					definition: { canvasId: 'board', extensionId: 'fixture', extensionSource: 'user', displayName: 'Fixture board', description: '', requiresInput: false },
					signal: new AbortController().signal,
					open: async () => source, resolve: async () => source, close: async () => { },
				};
				resources.add(collection.register(provider));
				const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one') };
				const context = collection.createContext(owner);
				const info: IBrowserViewInfo = {
					id: 'agent-page', owner: { type: 'agent', sessionId: 'one' }, host: { windowId: 1 },
					session: { scope: BrowserViewStorageScope.Agent, affinity: 'one' },
					canvas: { sessionId: 'one', instanceId: 'preview', extensionId: 'fixture', canvasId: 'board', title: 'Original board' },
					state: { isDevToolsOpen: false, targetId: 'agent-page', title: '', url: source.url, loading: false, visible: false, canGoBack: false, canGoForward: false }
				};
				pages.set(info.id, info); events.fire({ type: 'canvasOpened', targetId: info.id, info });
				const request = context.openRequests!.get().get('preview');
				await collection.refreshProvider(provider);
				assert.equal(context.canvases.get()![0]!.title, 'Renamed board', 'same-source metadata does not require network authority');
				assert.deepEqual(warnings, []);
				source = { url: 'http://localhost:9000/updated', title: 'Updated board' };
				await collection.refreshProvider(provider);
				assert.equal(pages.get(info.id), info, 'retain the native page and its contents');
				assert.equal(context.canvases.get()![0]!.source?.toString(), info.state.url);
				assert.equal(context.canvases.get()![0]!.title, 'Renamed board', 'do not publish an unloaded source');
				assert.equal(context.openRequests!.get().get('preview'), request);
				assert.deepEqual(warnings, [locale === 'en'
					? 'Canvas Fixture board has a new address. Open it again from the Canvas menu to load the updated page.'
					: 'Canvas Fixture board 的地址已更改。请从 Canvas 菜单再次打开它以加载更新后的页面。']);
				await context.definitionProvider!.openCanvas(provider.definition, 'preview');
				assert.equal(pages.has(info.id), false);
				assert.equal(pages.size, 1);
				assert.equal([...pages.values()][0]!.state.url, source.url);
				assert.equal(context.canvases.get()![0]!.title, source.title);
				assert.equal(context.openRequests!.get().get('preview')?.succeeded, true);
			} finally { resetNlsResolver(); }
		});
	}
});

test('independent hosts isolate identical Canvas definitions, native membership and provider retirement', async () => {
	using lifetime = new DisposableStore();
	const events = lifetime.add(new Emitter<BrowserViewEvent>());
	const pages = new Map<string, IBrowserViewInfo>();
	const destroyed: string[] = [];
	const browser = {
		onDidEvent: events.event, getBrowserViews: async () => [],
		getOrCreateBrowserView: async (id: string, options: IBrowserViewCreateOptions) => {
			const page: IBrowserViewInfo = {
				id, owner: options.owner, session: options.session, canvas: options.canvas, host: { windowId: 1 },
				state: { targetId: id, url: options.initialUrl, title: '', visible: false, loading: false, canGoBack: false, canGoForward: false, isDevToolsOpen: false }
			};
			pages.set(id, page); events.fire({ type: 'created', info: page }); return page;
		},
		destroyBrowserView: async (id: string) => { destroyed.push(id); pages.delete(id); events.fire({ type: 'closed', targetId: id }); },
	} as unknown as IBrowserViewService;
	const collection = lifetime.add(new AgentHostCanvasCollection(browser, { activateByEvent: async () => { } } as unknown as IExtensionService, {} as INotificationService));
	await Promise.resolve();
	const remoteHost = lifetime.add(collection.registerHost('remote', async () => { }, () => ({ authority: 'remote-authority', root: '/workspace' })));
	const definition = { extensionId: 'fixture', canvasId: 'board', extensionSource: 'user' as const, displayName: 'Board', description: '', requiresInput: false };
	const provider = (providerId: string): ICanvasProvider => ({
		providerId, definition, signal: new AbortController().signal,
		open: async () => ({ url: 'http://localhost:9000/' + providerId }), close: async () => { }
	});
	const localProvider = provider('local-agent-host'), remoteProvider = provider('remote');
	lifetime.add(collection.register(localProvider)); lifetime.add(collection.register(remoteProvider));
	const local = collection.createContext({ providerId: 'local-agent-host', session: URI.parse('ash-session:/same'), chat: URI.parse('ash-thread:/same') });
	const remote = collection.createContext({ ...local.owner, providerId: 'remote' });
	await local.definitionProvider!.openCanvas(definition, 'same');
	await remote.definitionProvider!.openCanvas(definition, 'same');
	assert.equal(local.canvases.get()!.length, 1); assert.equal(remote.canvases.get()!.length, 1);
	const localId = local.canvases.get()![0]!.resource.path.slice(1), remoteId = remote.canvases.get()![0]!.resource.path.slice(1);
	assert.notEqual(localId, remoteId);
	const remoteSession = pages.get(remoteId)!.session;
	assert.ok('network' in remoteSession);
	assert.deepEqual(remoteSession.network, { authority: 'remote-authority', root: '/workspace' });
	const localSession = pages.get(localId)!.session;
	assert.equal('network' in localSession ? localSession.network : undefined, undefined);
	collection.reconcileExtensions(new Set());
	await Promise.resolve();
	assert.deepEqual(destroyed, [localId]);
	assert.equal(remote.canvases.get()!.length, 1);
	remoteHost.dispose();
	assert.equal(remote.canvases.get(), undefined, 'A disconnected host has unknown membership');
	assert.equal(pages.has(remoteId), true, 'Disconnection must not destroy a recoverable native identity');
});
