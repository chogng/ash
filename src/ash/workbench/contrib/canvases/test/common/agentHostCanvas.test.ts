import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type {
	IBrowserViewService,
	IBrowserViewInfo,
	IBrowserViewCreateOptions,
	BrowserViewEvent,
} from '../../../../../platform/browserView/common/browserView.js';
import type { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { AgentHostCanvasCollection, type ICanvasProvider } from '../../common/agentHostCanvas.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';

suite('Agent Canvas provider ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('removing an owner cancels its extension callback before a native page can be created', async () => {
		using resources = new DisposableStore();
		const started = promiseWithResolvers<AbortSignal>();
		const collection = resources.add(
			new AgentHostCanvasCollection(
				{
					onDidEvent: Event.None,
					getBrowserViews: async () => [],
					getOrCreateBrowserView: async () => assert.fail('Removed owners cannot create pages'),
				} as unknown as IBrowserViewService,
				{ activateByEvent: async () => {} } as unknown as IExtensionService,
			),
		);
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/source'),
			chat: URI.parse('ash-thread:/source'),
		};
		const definition = {
			canvasId: 'board',
			extensionId: 'fixture',
			extensionSource: 'plugin' as const,
			displayName: 'Board',
			description: '',
			requiresInput: false,
		};
		resources.add(
			collection.register({
				definition,
				signal: new AbortController().signal,
				close: async () => {},
				open: async (_owner, _instance, signal) => {
					started.resolve(signal);
					return new Promise((_resolve, reject) =>
						signal.addEventListener('abort', () => reject(new Error('Owner removed')), { once: true }),
					);
				},
			}),
		);
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
			onDidEvent: events.event,
			getBrowserViews: async () => [],
			getOrCreateBrowserView: async (id: string, options: IBrowserViewCreateOptions) => {
				const info: IBrowserViewInfo = {
					id,
					owner: options.owner,
					host: { windowId: 1 },
					session: options.session,
					canvas: options.canvas,
					state: {
						targetId: id,
						title: '',
						url: options.initialUrl,
						loading: false,
						visible: false,
						canGoBack: false,
						canGoForward: false,
					},
				};
				pages.set(id, info);
				events.fire({ type: 'created', info });
				return info;
			},
			destroyBrowserView: async (id: string) => {
				pages.delete(id);
				events.fire({ type: 'closed', targetId: id });
			},
			loadURL: async (id: string, url: string) => {
				const info = pages.get(id)!;
				const state = { ...info.state, url };
				pages.set(id, { ...info, state });
				events.fire({ type: 'stateChanged', state });
			},
		} as unknown as IBrowserViewService;
		const collection = resources.add(
			new AgentHostCanvasCollection(browser, { activateByEvent: async () => {} } as unknown as IExtensionService),
		);
		await Promise.resolve();
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/one'),
			chat: URI.parse('ash-thread:/one'),
		};
		let state: 'ready' | 'pending' | 'removed' = 'ready';
		let closes = 0;
		const calls: unknown[] = [];
		const provider: ICanvasProvider = {
			definition: {
				canvasId: 'board',
				extensionId: 'fixture',
				extensionSource: 'user',
				displayName: 'Board',
				description: '',
				requiresInput: false,
			},
			signal: new AbortController().signal,
			open: async (context, instanceId) => {
				calls.push({ context, instanceId });
				return { url: 'http://localhost:9000/board' };
			},
			resolve: async () =>
				state === 'ready'
					? { url: 'http://localhost:9000/updated', title: 'Updated' }
					: state === 'pending'
						? undefined
						: null,
			close: async () => {
				closes++;
			},
		};
		const registration = resources.add(collection.register(provider));
		const context = collection.createContext(owner);
		await context.definitionProvider!.openCanvas(provider.definition, 'preview');
		assert.equal(calls.length, 1);
		assert.deepEqual((calls[0] as { context: unknown }).context, owner);
		const canvas = context.canvases.get()![0]!;
		assert.equal(
			collection.createContext({ ...owner, chat: URI.parse('ash-thread:/other') }).canvases.get()!.length,
			0,
		);
		const request = context.openRequests!.get().get('preview');
		assert.equal(request?.succeeded, true);
		state = 'pending';
		await collection.refreshProvider(provider);
		assert.equal(context.canvases.get()![0]!.resource.toString(), canvas.resource.toString());
		assert.equal(context.canvases.get()![0]!.source, undefined);
		state = 'ready';
		await collection.refreshProvider(provider);
		assert.equal(context.canvases.get()![0]!.title, 'Updated');
		assert.equal(
			context.openRequests!.get().get('preview'),
			request,
			'source updates do not invent an explicit open',
		);
		await browser.loadURL(canvas.resource.path.slice(1), 'http://localhost:9000/updated/nested-route');
		await collection.refreshProvider(provider);
		assert.equal(
			pages.get(canvas.resource.path.slice(1))!.state.url,
			'http://localhost:9000/updated/nested-route',
			'metadata refresh must retain navigation inside the live page',
		);
		await context.closeCanvas!(context.canvases.get()![0]!);
		assert.equal(closes, 1);
		assert.equal(pages.size, 0);
		await context.definitionProvider!.openCanvas(provider.definition, 'preview');
		registration.dispose();
		await Promise.resolve();
		assert.equal(pages.size, 0);
		await assert.rejects(context.definitionProvider!.openCanvas(provider.definition, 'preview'));
	});
});
