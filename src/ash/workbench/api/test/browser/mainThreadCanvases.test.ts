import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot, ExtensionHostInvocationRequest, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import type { IAgentHostCanvasCollection, ICanvasProvider } from '../../../contrib/canvases/common/agentHostCanvas.js';
import { MainThreadCanvases } from '../../browser/mainThreadCanvases.js';

suite('Extension Canvas bridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const snapshot = (enabled = true): ExtensionHostFleetSnapshot =>
		({
			generation: 1,
			extensions: enabled
				? [
						{
							id: 'plugin:runtime',
							packageDigest: 'digest',
							lifecycle: 'ready',
							incarnation: 2,
							activationGeneration: 3,
							registrations: [{ kind: 'dataChannel', registrationId: 'board', channelId: 'canvas.provider.v1' }],
						},
					]
				: [],
		}) as unknown as ExtensionHostFleetSnapshot;
	const definition = {
		state: 'definition',
		canvasId: 'board',
		displayName: 'Board',
		description: '',
		requiresInput: false,
	};
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));

	test('discovers provider metadata through its admitted callback and fences every source operation', async () => {
		using f = fixture(async (request): Promise<JsonValue> => {
			const action = (request.payload as { data: { action: string } }).data.action;
			return action === 'describe' ? definition : action === 'close' ? { state: 'closed' } : { state: 'ready', url: 'http://localhost:9000/board', title: 'Board' };
		});
		f.bridge.update(snapshot());
		await settle();
		const provider = f.providers[0]!;
		assert.equal(provider.definition.extensionId, 'plugin:runtime');
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/source-session'),
			chat: URI.parse('ash-thread:/source-thread'),
		};
		await provider.open(owner, 'preview', new AbortController().signal);
		assert.deepEqual(f.calls[1]!.payload, {
			data: {
				action: 'open',
				context: { sessionId: 'source-session', threadId: 'source-thread', instanceId: 'preview' },
			},
		});
		assert.equal(f.calls[1]!.incarnation, 2);
		await assert.rejects(f.bridge.handleChange({ method: 'canvasChanged', canvasId: 'board' }, { extensionId: 'plugin:runtime', incarnation: 1, activationGeneration: 3 }));
		await f.bridge.handleChange({ method: 'canvasChanged', canvasId: 'board' }, { extensionId: 'plugin:runtime', incarnation: 2, activationGeneration: 3 });
		assert.equal(f.refreshes.length, 2);
		f.bridge.update(snapshot(false));
		assert.equal(provider.signal.aborted, true);
		assert.deepEqual(f.providers, []);
	});

	test('a retired metadata callback cannot publish a definition into the next runtime', async () => {
		const pending = promiseWithResolvers<JsonValue>();
		using f = fixture(() => pending.promise);
		f.bridge.update(snapshot());
		f.bridge.update(snapshot(false));
		pending.resolve(definition);
		await settle();
		assert.deepEqual(f.providers, []);
		assert.equal(f.loading, 0);
	});

	test('recovery suspends sources until the replacement incarnation settles, while removal retires them', async () => {
		using f = fixture(async request => ((request.payload as { data: { action: string } }).data.action === 'describe' ? definition : { state: 'unchanged' }));
		f.bridge.update(snapshot());
		await settle();
		const first = f.providers[0]!;
		const recovering = snapshot();
		f.bridge.update({
			...recovering,
			extensions: recovering.extensions.map(owner => ({ ...owner, lifecycle: 'recovering' })),
		});
		assert.deepEqual(f.suspended, [first]);
		assert.equal(first.signal.aborted, true);
		assert.deepEqual(f.retired, []);
		f.bridge.clear();
		f.bridge.update(snapshot(false));
		assert.deepEqual(f.retired, ['plugin:runtime']);
	});

	test('failed metadata remains unsettled and the next fleet update can retry it', async () => {
		let failed = true;
		using f = fixture(async () => {
			if (failed) {
				throw new Error('runtime temporarily unavailable');
			}
			return definition;
		});
		f.bridge.update(snapshot());
		await settle();
		assert.equal(f.loading, 1);
		assert.deepEqual(f.providers, []);
		failed = false;
		f.bridge.update(snapshot());
		await settle();
		assert.equal(f.loading, 0);
		assert.equal(f.providers.length, 1);
	});
});

function fixture(invoke: (request: ExtensionHostInvocationRequest) => Promise<JsonValue>) {
	const lifetime = new DisposableStore();
	const providers: ICanvasProvider[] = [];
	const refreshes: ICanvasProvider[] = [];
	const calls: ExtensionHostInvocationRequest[] = [];
	const suspended: ICanvasProvider[] = [];
	const retired: string[] = [];
	const f = {
		providers,
		refreshes,
		calls,
		suspended,
		retired,
		loading: 0,
		[Symbol.dispose]: () => lifetime.dispose(),
	};
	const collection = {
		register: (provider: ICanvasProvider) => {
			providers.push(provider);
			return toDisposable(() => {
				const index = providers.indexOf(provider);
				if (index >= 0) {
					providers.splice(index, 1);
				}
			});
		},
		beginDefinitionRefresh: () => {
			f.loading++;
			return toDisposable(() => f.loading--);
		},
		refreshProvider: async (provider: ICanvasProvider) => {
			refreshes.push(provider);
		},
		settleExtension: () => {},
		suspendProvider: (provider: ICanvasProvider) => {
			suspended.push(provider);
		},
		retireExtension: (extensionId: string) => {
			retired.push(extensionId);
		},
		reconcileExtensions: () => {},
	} as unknown as IAgentHostCanvasCollection;
	const bridge = lifetime.add(
		new MainThreadCanvases(
			5000,
			{
				invoke: async (request: ExtensionHostInvocationRequest) => {
					calls.push(request);
					return invoke(request);
				},
			} as unknown as IExtensionHostApi,
			{ getExtensionPointContributions: () => [] } as unknown as IExtensionService,
			collection,
			{ error: () => {} } as unknown as ILogService,
		),
	);
	return Object.assign(f, { bridge });
}
