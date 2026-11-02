import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentCanvasHost } from '../../../../../platform/agentHost/common/agentService.js';
import type { AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import type { ExtensionHostFleetSnapshot, IExtensionHostApi, JsonValue } from '../../../../../platform/extensions/common/extensionHostApi.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { IAgentHostCanvasCollection, type ICanvasProvider } from '../../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensionService.js';
import { RemoteCanvasHostContribution } from '../../electron-browser/remoteCanvasHost.js';
import { sessionIdentity } from '../../../../services/sessions/common/sessionIdentity.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('remote Canvas refreshes borrow one connection fleet and callbacks preserve backend owner identities across reconnect', async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const state = lifetime.add(new Emitter<AppServerConnectionState>());
	const changed = lifetime.add(new Emitter<number>());
	const registrations = new Set<ICanvasProvider>();
	const connection = { name: 'build', host: 'server', workspace: '/project' };
	const providerId = 'ssh-agent-host:' + JSON.stringify([connection.host, connection.workspace]);
	let starts = 0, activeStarts = 0, generation = 1;
	let activate: () => Promise<void> = async () => { throw new Error('Host is not registered'); };
	let callbacks: IAgentCanvasHost | undefined;
	const calls: unknown[] = [];
	const snapshot = (): ExtensionHostFleetSnapshot => ({
		generation, extensions: [{
			id: 'fixture.canvas', version: '1.0.0', packageDigest: 'sha256:' + 'a'.repeat(64), runtimeApiVersion: 1,
			activationGeneration: generation, incarnation: generation, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
			registrations: [{ kind: 'dataChannel', registrationId: 'canvas:board', channelId: 'canvas.provider.v1' }],
		}]
	});
	const runtime: IExtensionHostApi = {
		isAvailable: async () => true,
		start: async () => { assert.equal(activeStarts++, 0, 'Only one fleet may be forked in a connection generation'); starts++; return snapshot(); },
		list: async () => snapshot(), reconcile: async () => snapshot(), activateByEvent: async () => snapshot(),
		getConnectionState: async () => 'ready', onConnectionState: state.event, onDidChange: changed.event,
		registerClientHandler: () => toDisposable(() => { }),
		invoke: async (request): Promise<JsonValue> => {
			calls.push(request.payload);
			return (request.payload as { data: { action: string; }; }).data.action === 'describe'
				? { state: 'definition', canvasId: 'board', displayName: 'Board', description: '', requiresInput: false }
				: { state: 'ready', url: 'https://example.test/board' };
		},
	};
	const collection = {
		registerHost: (id: string, value: () => Promise<void>) => { assert.equal(id, providerId); activate = value; return toDisposable(() => { }); },
		beginDefinitionRefresh: () => toDisposable(() => { }),
		register: (provider: ICanvasProvider) => { registrations.add(provider); return toDisposable(() => registrations.delete(provider)); },
		suspendProvider: (provider: ICanvasProvider) => { registrations.delete(provider); },
		refreshProvider: async () => { }, retireExtension: () => { }, settleExtension: () => { }, reconcileExtensions: () => { },
		listCanvases: async (sessionId: string, threadId: string, _signal: AbortSignal, id: string) => {
			assert.equal(id, providerId);
			assert.equal(sessionId, sessionIdentity(providerId, 'session', 'local-agent-host'));
			assert.equal(threadId, sessionIdentity(providerId, 'thread', 'local-agent-host'));
			await activate(); return [];
		},
	} as unknown as IAgentHostCanvasCollection;
	services.registerInstance(IAgentHostCanvasCollection, collection);
	services.registerInstance(IExtensionService, {} as IExtensionService);
	services.registerInstance(IPlaywrightService, {} as IPlaywrightService);
	services.registerInstance(IConfigurationService, { getValue: () => ({}), getConfigurationData: () => null } as unknown as IConfigurationService);
	services.registerInstance(IBrowserViewWorkbenchService, { resolveNetwork: () => ({ authority: 'ssh+server' }) } as unknown as IBrowserViewWorkbenchService);
	services.registerInstance(ILogService, new NullLoggerService());
	const api = { extensionHost: runtime, browserHost: { register: (_playwright: IPlaywrightService, _configuration: IConfigurationService, value: IAgentCanvasHost) => { callbacks = value; return toDisposable(() => { callbacks = undefined; }); } } } as unknown as IRendererHost;
	const hosts = { onDidChangeConnections: Event.None, connections: [{ id: 'connection', isAmbient: false, connection: api, remoteConnection: connection, directory: { uri: URI.parse('ash-remote://ssh+server/project') } }] } as unknown as IAgentHostConnectionsService;
	const owner = lifetime.add(new RemoteCanvasHostContribution(hosts, services));
	await settle();
	await callbacks!.listCanvases('session', 'thread', new AbortController().signal);
	changed.fire(generation); await settle();
	await callbacks!.listCanvases('session', 'thread', new AbortController().signal);
	assert.equal(starts, 1);
	assert.equal(registrations.size, 1);
	const provider = [...registrations][0]!;
	await provider.open({ providerId, session: URI.from({ scheme: 'ash-session', path: '/' + sessionIdentity(providerId, 'session', 'local-agent-host') }), chat: URI.from({ scheme: 'ash-thread', path: '/' + sessionIdentity(providerId, 'thread', 'local-agent-host') }) }, 'preview', new AbortController().signal);
	assert.deepEqual(calls.at(-1), { data: { action: 'open', context: { sessionId: 'session', threadId: 'thread', instanceId: 'preview' } } });
	state.fire('crashed');
	assert.equal(registrations.size, 0);
	activeStarts = 0; generation++; state.fire('ready'); await settle();
	assert.equal(starts, 2); assert.equal(registrations.size, 1);
	owner.dispose();
	assert.equal(registrations.size, 0); assert.equal(callbacks, undefined);
});

function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
