import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { AppServerConnectionState } from '../../../../platform/agentHost/common/appServerApi.js';
import { ContextKeyService, IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IDataChannelService, ILinkPresentationService } from '../../../../platform/dataChannel/common/dataChannel.js';
import { IExtensionHostApi, normalizeExtensionHostSnapshot, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../platform/log/common/log.js';
import { DataChannelService, LinkPresentationService } from '../../../services/dataChannel/browser/dataChannelService.js';
import { MainThreadDataChannels } from '../../browser/mainThreadDataChannels.js';

class ExtensionHost extends Disposable implements IExtensionHostApi {
	public registerClientHandler(): { dispose(): void; } { throw new Error('Client calls are outside this fixture'); }
	private readonly changes = this._register(new Emitter<number>());
	private readonly connection = this._register(new Emitter<AppServerConnectionState>());
	public current = snapshot(1, 1);
	public state: AppServerConnectionState = 'ready';
	public readonly requests: ExtensionHostInvocationRequest[] = [];
	public readonly signals: AbortSignal[] = [];
	public invokeResult: (request: ExtensionHostInvocationRequest) => Promise<JsonValue> = async request => request.operation === 'provideLinkPresentation' ? { kind: 'issue', title: 'Issue one', status: { kind: 'open', label: 'Open' } } : null;
	public start(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Startup is outside this fixture'); }
	public isAvailable(): Promise<boolean> { return Promise.resolve(true); }
	public list(): Promise<ExtensionHostFleetSnapshot> { return Promise.resolve(this.current); }
	public reconcile(): Promise<ExtensionHostFleetSnapshot> { return this.list(); }
	public activateByEvent(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Activation is outside this fixture'); }
	public getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve(this.state); }
	public onDidChange(listener: (generation: number) => void) { return this.changes.event(listener); }
	public onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.connection.event(listener); }
	public invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		this.requests.push(request);
		this.signals.push(signal);
		return this.invokeResult(request);
	}
	public change(incarnation: number): void {
		this.current = snapshot(this.current.generation + 1, incarnation);
		this.changes.fire(this.current.generation);
	}
	public connect(state: AppServerConnectionState): void {
		this.state = state;
		this.connection.fire(state);
	}
}

function snapshot(generation: number, incarnation: number): ExtensionHostFleetSnapshot {
	return normalizeExtensionHostSnapshot({
		generation, extensions: [{
			id: 'acme.links', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 1, incarnation, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: [
				{ kind: 'dataChannel', registrationId: 'edits', channelId: 'editTelemetry' },
				{ kind: 'linkPresentationProvider', registrationId: 'issues', uriPattern: '^https://example\\.com/issues/', presentationKind: 'issue' },
			],
		}]
	});
}

function servicesFor(api: ExtensionHost): InstantiationService {
	const services = new InstantiationService();
	services.registerInstance(IExtensionHostApi, api);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerSingleton(IDataChannelService, () => new DataChannelService());
	services.registerSingleton(ILinkPresentationService, () => services.createInstance(LinkPresentationService));
	return services;
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) { return; }
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('Expected extension state was not reached');
}

test('channel delivery is ordered and survives unrelated fleet changes', async () => {
	using api = new ExtensionHost();
	using services = servicesFor(api);
	using bridge = services.createInstance(MainThreadDataChannels, 1_000);
	const first = new DeferredPromise<JsonValue>();
	api.invokeResult = request => api.requests.length === 1 ? first.p : Promise.resolve(null);
	await bridge.start();
	const channels = services.get(IDataChannelService);
	channels.getDataChannel('other').sendData('ignored');
	const channel = channels.getDataChannel('editTelemetry');
	channel.sendData(1);
	channel.sendData(2);
	api.change(1);
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(api.signals[0]!.aborted, false);
	assert.equal(api.requests.length, 1);
	await first.complete(null);
	await until(() => api.requests.length === 2);
	assert.deepEqual(api.requests.map(request => ({ operation: request.operation, payload: { ...request.payload as Record<string, JsonValue> }, incarnation: request.incarnation })), [
		{ operation: 'receiveData', payload: { data: 1 }, incarnation: 1 },
		{ operation: 'receiveData', payload: { data: 2 }, incarnation: 1 },
	]);
});

test('link registration listeners observe the complete extension snapshot', async () => {
	using api = new ExtensionHost();
	const next = JSON.parse(JSON.stringify(api.current));
	next.extensions[0].failure = null;
	next.extensions[0].registrations.push({ kind: 'linkPresentationProvider', registrationId: 'pulls', uriPattern: '^https://example\\.com/pulls/', presentationKind: 'pullRequest' });
	api.current = normalizeExtensionHostSnapshot(next);
	using services = servicesFor(api);
	const links = services.get(ILinkPresentationService);
	const observed: number[] = [];
	using listener = links.onDidChangeLinkPresentationRules(() => observed.push(links.linkPresentationRules.length));
	using bridge = services.createInstance(MainThreadDataChannels, 1_000);
	await bridge.start();
	assert.deepEqual(observed, [2, 2]);
});

test('link results from a retired extension cannot update the next watcher', async () => {
	using api = new ExtensionHost();
	using services = servicesFor(api);
	using bridge = services.createInstance(MainThreadDataChannels, 1_000);
	await bridge.start();
	const links = services.get(ILinkPresentationService);
	const resource = URI.parse('https://example.com/issues/1');
	const pending = new DeferredPromise<JsonValue>();
	api.invokeResult = () => pending.p;
	using first = links.createLinkPresentationWatcher(links.getLinkPresentationRule(resource)!.id, resource)!;
	await until(() => api.requests.length === 1);
	api.change(2);
	await until(() => api.signals[0]!.aborted);
	await pending.complete({ kind: 'issue', title: 'Stale' });
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(first.presentation.get(), undefined);
	api.invokeResult = async () => ({ kind: 'issue', title: 'Fresh', changes: { insertions: 2, deletions: 1 } });
	using second = links.createLinkPresentationWatcher(links.getLinkPresentationRule(resource)!.id, resource)!;
	await until(() => second.presentation.get()?.title === 'Fresh');
	assert.equal(api.requests.at(-1)!.incarnation, 2);
	api.connect('restarting');
	assert.deepEqual({ rules: links.linkPresentationRules, value: second.presentation.get(), aborted: api.signals.at(-1)!.aborted }, { rules: [], value: undefined, aborted: true });
	api.connect('ready');
	await until(() => links.linkPresentationRules.length === 1);
	bridge.dispose();
	assert.deepEqual(links.linkPresentationRules, []);
});

test('channel subscriptions bound pending delivery and abort it when their connection closes', async () => {
	using api = new ExtensionHost();
	using services = servicesFor(api);
	using bridge = services.createInstance(MainThreadDataChannels, 1_000);
	const pending = new DeferredPromise<JsonValue>();
	api.invokeResult = () => pending.p;
	await bridge.start();
	const channel = services.get(IDataChannelService).getDataChannel('editTelemetry');
	for (let value = 0; value < 100; value++) { channel.sendData(value); }
	assert.equal(api.requests.length, 1);
	api.invokeResult = async () => null;
	await pending.complete(null);
	await until(() => api.requests.length === 33);
	assert.deepEqual(api.requests.map(request => (request.payload as { data: JsonValue; }).data), Array.from({ length: 33 }, (_, index) => index));
	api.connect('stopped');
	assert.ok(api.signals.every(signal => signal.aborted));
	channel.sendData('after close');
	assert.equal(api.requests.length, 33);
});

test('extension registration boundaries reject unknown fields and invalid URI expressions', () => {
	const original = JSON.parse(JSON.stringify(snapshot(1, 1)));
	delete original.extensions[0].failure;
	original.extensions[0].failure = null;
	const invalid = structuredClone(original);
	invalid.extensions[0].registrations[1].uriPattern = '[';
	assert.throws(() => normalizeExtensionHostSnapshot(invalid), SyntaxError);
	const unknown = structuredClone(original);
	unknown.extensions[0].registrations[0].untrusted = true;
	assert.throws(() => normalizeExtensionHostSnapshot(unknown), TypeError);
});
