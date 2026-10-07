import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../agentHost/common/appServerApi.js';
import { BrowserExtensionHostApi } from '../../browser/extensionHostApi.js';
import { normalizeExtensionHostSnapshot, type ExtensionHostFleetSnapshot, type IExtensionHostApi } from '../../common/extensionHostApi.js';

class RemoteHost extends Disposable implements IExtensionHostApi {
	readonly instantiation = this._register(new InstantiationService());
	private readonly changes = this._register(new Emitter<number>());
	private readonly connection = this._register(new Emitter<AppServerConnectionState>());
	readonly activation = new DeferredPromise<ExtensionHostFleetSnapshot>();
	readonly read = new DeferredPromise<ExtensionHostFleetSnapshot>();
	readonly readStarted = new DeferredPromise<void>();
	registerClientHandler(): { dispose(): void; } { throw new Error('Client calls are outside this fixture'); }
	isAvailable(): Promise<boolean> { return Promise.resolve(true); }
	getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve('ready'); }
	list(): Promise<ExtensionHostFleetSnapshot> { void this.readStarted.complete(); return this.read.p; }
	reconcile(): Promise<ExtensionHostFleetSnapshot> { return Promise.resolve(snapshot(1, 'dormant')); }
	activateByEvent(): Promise<ExtensionHostFleetSnapshot> { return this.activation.p; }
	invoke(): Promise<never> { throw new Error('Provider calls are outside this fixture'); }
	onDidChange(listener: (generation: number) => void) { return this.changes.event(listener); }
	onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.connection.event(listener); }
	notify(): void { this.changes.fire(2); }
	disconnect(): void { this.connection.fire('stopped'); }
}

function snapshot(generation: number, lifecycle: 'dormant' | 'ready'): ExtensionHostFleetSnapshot {
	return normalizeExtensionHostSnapshot({
		generation, extensions: [{
			id: 'lazy', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 7, incarnation: lifecycle === 'ready' ? 1 : null, lifecycle,
			failure: null, stderr: '', outputEvents: [],
			...(lifecycle === 'dormant' ? { activation: { events: ['onCommand:lazy.run'], commands: [{ command: 'lazy.run', title: 'Run' }] } } : {}),
			registrations: lifecycle === 'ready' ? [{ kind: 'command', registrationId: 'callback', command: 'lazy.run', title: 'Run' }] : [],
		}]
	});
}

function browser(remote: RemoteHost): BrowserExtensionHostApi {
	return new BrowserExtensionHostApi({
		list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
		readResource: async () => { throw new Error('Bundled resources are outside this fixture'); },
	}, remote, remote.instantiation);
}

const request = { extensionId: 'lazy', activationGeneration: 7, event: { type: 'command' as const, command: 'lazy.run' } };

test('first-use activation returns ready even while a notification refresh is pending', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.notify();
	await remote.readStarted.p;
	await remote.activation.complete(snapshot(2, 'ready'));
	assert.equal((await activation).extensions[0]!.lifecycle, 'ready');
	await remote.read.complete(snapshot(1, 'dormant'));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal((await api.list()).extensions[0]!.lifecycle, 'ready');
});

test('a completed newer refresh cannot be replaced by an older activation reply', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.notify();
	await remote.readStarted.p;
	const applied = new DeferredPromise<void>();
	const registration = api.onDidChange(() => { void applied.complete(); });
	using subscription = toDisposable(() => registration.dispose());
	await remote.read.complete(snapshot(3, 'ready'));
	await applied.p;
	await remote.activation.complete(snapshot(2, 'dormant'));
	assert.equal((await activation).extensions[0]!.lifecycle, 'ready');
});

test('activation replies from a disconnected backend cannot restore remote contributions', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.disconnect();
	await remote.activation.complete(snapshot(2, 'ready'));
	await assert.rejects(activation, /retired activation/);
	assert.deepEqual((await api.list()).extensions, []);
});
