import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, IWorkspaceTrustApi, READ_DIR_PERMISSIONS, RESTRICTED_DIR_PERMISSIONS, type WorkspaceTrustPermission } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { createDisconnectedWorkspaceTrustApi } from '../../../../../platform/workspace/browser/workspaceTrustApi.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { WorkspaceTrustManagementService } from '../../common/workspaceTrust.js';
import { IRemoteAuthorityResolverService, WebSocketRemoteConnection } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { RemoteAuthorityResolverService as DesktopRemoteAuthorityResolverService } from '../../../../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { WorkspaceTrustRequestService } from '../../common/workspaceTrust.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../notification/test/common/testNotificationService.js';
import { NativeExtensionService } from '../../../extensions/electron-browser/nativeExtensionService.js';

test('Workspace Trust reads current Rust permissions for each workspace folder', async () => {
	using changes = new Emitter<void>();
	using workspace = new TestWorkspaceService({ id: 'empty' });
	const allowed = new Map<string, readonly WorkspaceTrustPermission[]>();
	const reads: string[] = [];
	const permissions: IWorkspaceTrustApi = {
		onDidChangeTrust: changes.event,
		listDirectories: async () => { throw new Error('Unexpected directory management'); },
		setDirectoryPermissions: async () => { throw new Error('Unexpected directory management'); },
		forgetDirectory: async () => { throw new Error('Unexpected directory management'); },
		readWorkspaceDirectory: async id => { const path = workspace.getWorkspace().folders.find(folder => folder.id === id)!.uri.fsPath; reads.push(path); return allowed.get(path); },
		readDirectory: async () => { throw new Error('Current workspace trust must use effective permissions'); },
		createGrant: async () => { throw new Error('Unexpected grant creation'); },
		persistGrant: async () => { throw new Error('Unexpected grant persistence'); },
	};
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkspaceTrustApi, permissions);
	using resolver = services.createInstance(RemoteAuthorityResolverService);
	services.registerInstance(IRemoteAuthorityResolverService, resolver);
	using recovered = new Emitter<void>();
	let recoveryStatus: 'recovering' | 'idle' = 'recovering';
	services.registerInstance(IAppServerApi, { connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None, getSlashCommands: async () => [], recovery: { get status() { return recoveryStatus; }, error: undefined, onDidChange: recovered.event, reconnect: async () => { } } });
	using trust = services.createInstance(WorkspaceTrustManagementService);
	let notifications = 0;
	using listener = trust.onDidChangeTrustedFolders(() => notifications += 1);
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);

	const first = URI.file('/workspaces/first');
	workspace.updateWorkspace({ id: 'first', uri: first });
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);
	allowed.set(first.fsPath, READ_DIR_PERMISSIONS);
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: true });
	assert.deepEqual(reads, [first.fsPath, first.fsPath]);
	allowed.set(first.fsPath, []);
	assert.deepEqual(await trust.getUriTrustInfo(first), { uri: first, trusted: false, permissions: [] });
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });

	allowed.set(first.fsPath, [...READ_DIR_PERMISSIONS, 'executeCommands']);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	assert.deepEqual(await trust.getUriTrustInfo(first), {
		uri: first, trusted: false, permissions: [...READ_DIR_PERMISSIONS, 'executeCommands'],
	});
	allowed.set(first.fsPath, [...READ_DIR_PERMISSIONS, 'writeFiles']);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	allowed.set(first.fsPath, DEVELOPMENT_DIR_PERMISSIONS);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: true, isReadOnly: false });

	const second = URI.file('/workspaces/second');
	allowed.set(second.fsPath, READ_DIR_PERMISSIONS);
	workspace.updateWorkspace({
		id: 'both',
		folders: [
			{ id: 'first', uri: first, name: 'first', index: 0 },
			{ id: 'second', uri: second, name: 'second', index: 1 },
		],
	});
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	assert.equal(notifications, 5);
	assert.deepEqual(reads.slice(-2), [first.fsPath, second.fsPath]);
	const beforeUnsupported = reads.length;
	const unsupported = URI.parse('https://example.test/folder');
	assert.deepEqual(await trust.getUriTrustInfo(unsupported), { uri: unsupported, trusted: false, permissions: undefined });
	assert.equal(reads.length, beforeUnsupported);
	recovered.fire();
	assert.equal(notifications, 6);
	recoveryStatus = 'idle';
	recovered.fire();
	assert.equal(notifications, 7, 'effective permissions are invalidated after directory recovery');
	trust.dispose();
	changes.fire();
	recovered.fire();
	assert.equal(notifications, 7);
});

for (const prefix of ['ssh', 'team']) {
	test(`remote trust uses ${prefix} resolver canonical identity without turning its hint into a directory grant`, async () => {
		using changes = new Emitter<void>();
		using fleetChanges = new Emitter<number>();
		using workspace = new TestWorkspaceService({ id: 'remote', uri: URI.parse(`ash-remote://${prefix}+build/alias`) });
		using services = new InstantiationService();
		services.registerInstance(IAppServerApi, { connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None, getSlashCommands: async () => [] });
		using resolver = services.createInstance(DesktopRemoteAuthorityResolverService);
		services.registerInstance(IRemoteAuthorityResolverService, resolver);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		let trustHint = true;
		let canonical = URI.parse(`ash-remote://${prefix}+build/canonical`);
		let allowed: readonly WorkspaceTrustPermission[] = READ_DIR_PERMISSIONS;
		const reads: string[] = [];
		services.registerInstance(IWorkspaceTrustApi, {
			onDidChangeTrust: changes.event,
			listDirectories: async () => { throw new Error('Unexpected directory management'); },
			setDirectoryPermissions: async () => { throw new Error('Unexpected directory management'); },
			forgetDirectory: async () => { throw new Error('Unexpected directory management'); },
			readWorkspaceDirectory: async id => { reads.push(id); return allowed; },
			readDirectory: async () => { throw new Error('Saved remote grants cannot establish effective workspace trust'); },
			createGrant: async () => { throw new Error('Resolver must not grant permissions'); },
			persistGrant: async () => { throw new Error('Resolver must not persist permissions'); },
		});
		const fleet: ExtensionHostFleetSnapshot = { generation: 1, extensions: [{ id: 'local.resolver', version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1, lifecycle: 'ready', incarnation: 1, activationGeneration: 1, failure: undefined, stderr: '', outputEvents: [], registrations: [{ kind: 'remoteAuthorityResolver', registrationId: 'resolve', authorityPrefix: prefix }] }] };
		services.registerInstance(IExtensionHostApi, {
			start: async () => { throw new Error('Startup is outside this fixture'); }, registerClientHandler: () => Disposable.None, isAvailable: async () => true, list: async () => fleet, reconcile: async () => fleet, activateByEvent: async () => fleet,
			getConnectionState: async () => 'ready', onDidChange: fleetChanges.event, onConnectionState: () => Disposable.None,
			invoke: async (request): Promise<JsonValue> => request.operation === 'resolveAuthority'
				? { type: 'webSocket', host: 'localhost', port: 5000, connectionToken: null, options: { isTrusted: trustHint } }
				: { scheme: canonical.scheme, authority: canonical.authority, path: canonical.path, query: canonical.query, fragment: canonical.fragment, external: canonical.toString() },
		});
		using extensions = services.createInstance(NativeExtensionService);
		using trust = services.createInstance(WorkspaceTrustManagementService);
		await extensions.resolveAuthority(`${prefix}+build`, 1);
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: true });
		assert.ok(reads.length > 0);
		assert.deepEqual(new Set(reads), new Set(['remote']));
		assert.deepEqual(await trust.getUriTrustInfo(workspace.getWorkspace().folders[0]!.uri), {
			uri: canonical, trusted: false, permissions: READ_DIR_PERMISSIONS,
		});
		allowed = DEVELOPMENT_DIR_PERMISSIONS;
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: true, isReadOnly: false });
		trustHint = false;
		await extensions.resolveAuthority(`${prefix}+build`, 2);
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
		canonical = URI.file('/local/canonical');
		await extensions.resolveAuthority(`${prefix}+build`, 3);
		const before = reads.length;
		assert.equal(await trust.getWorkspaceTrustInfo(), undefined);
		assert.equal(reads.length, before);
		workspace.updateWorkspace({ id: 'empty-remote', remoteAuthority: `${prefix}+build` });
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
		trustHint = true;
		canonical = URI.parse(`ash-remote://${prefix}+build/canonical`);
		await extensions.resolveAuthority(`${prefix}+build`, 4);
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: true, isReadOnly: false });
		canonical = URI.parse(`ash-remote://${prefix}+other-host/canonical`);
		await extensions.resolveAuthority(`${prefix}+build`, 5);
		assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
		assert.equal(reads.length, before);
		resolver._clearResolvedAuthority(`${prefix}+build`);
		assert.equal(await trust.getWorkspaceTrustInfo(), undefined);
	});

}

for (const source of ['permissions', 'workspace', 'resolver', 'recovery', 'disposal'] as const) {
	test(`Workspace Trust discards pending permissions after ${source} changes`, async () => {
		using changes = new Emitter<void>();
		using recovered = new Emitter<void>();
		const folder = URI.file('/workspaces/first');
		using workspace = new TestWorkspaceService({ id: 'first', uri: folder });
		using services = new InstantiationService();
		services.registerInstance(IWorkspaceContextService, workspace);
		const started = new DeferredPromise<void>();
		const pending = new DeferredPromise<readonly WorkspaceTrustPermission[]>();
		services.registerInstance(IWorkspaceTrustApi, {
			onDidChangeTrust: changes.event,
			readWorkspaceDirectory: async () => { await started.complete(); return pending.p; },
			readDirectory: async () => { throw new Error('Unexpected saved grant read'); },
			listDirectories: async () => { throw new Error('Unexpected directory management'); },
			setDirectoryPermissions: async () => { throw new Error('Unexpected directory management'); },
			forgetDirectory: async () => { throw new Error('Unexpected directory management'); },
			createGrant: async () => { throw new Error('Unexpected grant creation'); },
			persistGrant: async () => { throw new Error('Unexpected grant persistence'); },
		});
		using resolver = services.createInstance(RemoteAuthorityResolverService);
		services.registerInstance(IRemoteAuthorityResolverService, resolver);
		services.registerInstance(IAppServerApi, {
			connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None, getSlashCommands: async () => [],
			recovery: { status: 'idle', error: undefined, onDidChange: recovered.event, reconnect: async () => { } },
		});
		using trust = services.createInstance(WorkspaceTrustManagementService);
		const uriResult = trust.getUriTrustInfo(folder);
		const workspaceResult = trust.getWorkspaceTrustInfo();
		await started.p;
		switch (source) {
			case 'permissions': changes.fire(); break;
			case 'workspace': workspace.updateWorkspace({ id: 'second', uri: URI.file('/workspaces/second') }); break;
			case 'resolver': resolver._clearResolvedAuthority('ssh+build'); break;
			case 'recovery': recovered.fire(); break;
			case 'disposal': trust.dispose(); break;
		}
		await pending.complete(DEVELOPMENT_DIR_PERMISSIONS);
		assert.deepEqual(await uriResult, { uri: folder, trusted: false, permissions: undefined });
		assert.equal(await workspaceResult, undefined);
	});
}

test('empty remote Workspace Trust discards a resolver hint changed during canonical lookup', async () => {
	const authority = 'team+build';
	using workspace = new TestWorkspaceService({ id: 'remote', remoteAuthority: authority });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkspaceTrustApi, createDisconnectedWorkspaceTrustApi(async () => { throw new Error('An empty window must not read directory grants'); }));
	services.registerInstance(IAppServerApi, { connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None, getSlashCommands: async () => [] });
	using resolver = services.createInstance(DesktopRemoteAuthorityResolverService);
	services.registerInstance(IRemoteAuthorityResolverService, resolver);
	const address = { authority, connectTo: new WebSocketRemoteConnection('localhost', 5000), connectionToken: undefined };
	resolver._setResolvedAuthority(address, { isTrusted: true });
	const started = new DeferredPromise<void>();
	const canonical = new DeferredPromise<URI>();
	resolver._setCanonicalURIProvider(async () => { await started.complete(); return canonical.p; });
	using trust = services.createInstance(WorkspaceTrustManagementService);
	const result = trust.getWorkspaceTrustInfo();
	await started.p;
	resolver._setResolvedAuthority(address, { isTrusted: false });
	await canonical.complete(URI.from({ scheme: 'ash-remote', authority, path: '/' }));
	assert.equal(await result, undefined);
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
});

test('initialization waits for directory recovery, effective permissions and transition participants', async () => {
	using f = createTrustFixture(true);
	const read = new DeferredPromise<void>();
	f.readGate = read;
	let initialized = false;
	void f.trust.workspaceTrustInitialized.then(() => { initialized = true; });
	const participantStarted = new DeferredPromise<void>();
	const participantFinished = new DeferredPromise<void>();
	using participant = f.trust.addWorkspaceTrustTransitionParticipant({ participate: async () => { await participantStarted.complete(); await participantFinished.p; } });
	f.saved.set('first', DEVELOPMENT_DIR_PERMISSIONS);
	f.active.set('first', DEVELOPMENT_DIR_PERMISSIONS);
	const response = f.requests.requestWorkspaceTrust();
	let prompts = 0;
	using listener = f.requests.onDidInitiateWorkspaceTrustRequest(() => prompts++);
	await f.trust.resolveWorkspaceTrust();
	assert.equal(initialized, false);
	f.status = 'idle';
	f.recovered.fire();
	await read.complete();
	await participantStarted.p;
	await f.trust.workspaceResolved;
	assert.equal(f.trust.isWorkspaceTrusted(), true);
	assert.equal(initialized, false);
	assert.equal(prompts, 0);
	await participantFinished.complete();
	await f.trust.workspaceTrustInitialized;
	assert.equal(await response, true);
	assert.equal(prompts, 0, 'an already trusted workspace does not prompt after initialization');
});

test('coalesced trust requests finish only after persistence, recovery and participants, then publish trust', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const initiated = new DeferredPromise<void>();
	const events: unknown[] = [];
	using requestListener = f.requests.onDidInitiateWorkspaceTrustRequest(options => { events.push(options); void initiated.complete(); });
	using trustListener = f.trust.onDidChangeTrust(trusted => f.effects.push(`trusted:${trusted}`));
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	using participant = f.trust.addWorkspaceTrustTransitionParticipant({
		participate: async trusted => {
			assert.equal(f.trust.isWorkspaceTrusted(), trusted);
			f.effects.push('participant');
			await entered.complete();
			await release.p;
		}
	});
	const first = f.requests.requestWorkspaceTrust({ message: 'Run workspace code?' });
	const second = f.requests.requestWorkspaceTrust({ message: 'Second caller' });
	assert.equal(first, second);
	await initiated.p;
	let completed = false;
	void first.then(() => { completed = true; });
	const completing = f.requests.completeWorkspaceTrustRequest(true);
	await entered.p;
	assert.deepEqual(events, [{ message: 'Run workspace code?' }]);
	assert.equal(completed, false);
	assert.deepEqual(f.effects, [`save:${URI.file('/first').fsPath}`, 'reconnect', 'participant']);
	await release.complete();
	await completing;
	assert.equal(await first, true);
	assert.equal(await second, true);
	assert.deepEqual(f.effects, [`save:${URI.file('/first').fsPath}`, 'reconnect', 'participant', 'trusted:true']);
	assert.equal(await f.requests.requestWorkspaceTrust(), true);
});

test('declining, canceling, startup and disposal release pending trust requests without granting capabilities', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const declined = f.requests.requestWorkspaceTrust();
	await f.requests.completeWorkspaceTrustRequest(false);
	assert.equal(await declined, false);
	const canceled = f.requests.requestWorkspaceTrust();
	f.requests.cancelWorkspaceTrustRequest();
	assert.equal(await canceled, undefined);
	const startup = new DeferredPromise<void>();
	using listener = f.requests.onDidInitiateWorkspaceTrustRequestOnStartup(() => { void startup.complete(); });
	f.requests.requestWorkspaceTrustOnStartup();
	const joined = f.requests.requestWorkspaceTrust();
	await startup.p;
	f.requests.dispose();
	assert.equal(await joined, undefined);
	assert.deepEqual(f.effects, []);
});

test('an old trust completion cannot resolve a replacement workspace request', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	using participant = f.trust.addWorkspaceTrustTransitionParticipant({ participate: async () => { await entered.complete(); await release.p; } });
	const old = f.requests.requestWorkspaceTrust();
	const completing = f.requests.completeWorkspaceTrustRequest(true);
	await entered.p;
	f.workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
	assert.equal(await old, undefined);
	const replacement = f.requests.requestWorkspaceTrust();
	let replacementCompleted = false;
	void replacement.then(() => { replacementCompleted = true; });
	await release.complete();
	await completing;
	assert.equal(replacementCompleted, false);
	f.requests.cancelWorkspaceTrustRequest();
	assert.equal(await replacement, undefined);
});

test('save failures cancel the trust request, notify once and allow a fresh request', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	f.failPath = URI.file('/first').fsPath;
	const failed = f.requests.requestWorkspaceTrust();
	await f.requests.completeWorkspaceTrustRequest(true);
	assert.equal(await failed, undefined);
	assert.equal(f.trust.isWorkspaceTrusted(), false);
	assert.equal(f.notifications.model.getNotifications().length, 1);
	assert.deepEqual(f.effects, []);
	f.failPath = undefined;
	const retry = f.requests.requestWorkspaceTrust();
	await f.requests.completeWorkspaceTrustRequest(true);
	assert.equal(await retry, true);
});

test('revoking workspace trust retains file editing and saving without command execution', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	await f.trust.setWorkspaceTrust(true);
	await f.trust.setWorkspaceTrust(false);
	assert.deepEqual(f.active.get('first'), RESTRICTED_DIR_PERMISSIONS);
	assert.deepEqual(await f.trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
	assert.equal(RESTRICTED_DIR_PERMISSIONS.includes('writeFiles'), true);
	assert.equal(RESTRICTED_DIR_PERMISSIONS.includes('executeCommands'), false);
});

test('a partially saved multi-root grant recovers effective permissions without reporting full trust', async () => {
	using f = createTrustFixture(false, true);
	await f.trust.workspaceTrustInitialized;
	f.failPath = URI.file('/second').fsPath;
	await assert.rejects(f.trust.setWorkspaceTrust(true), /Revision conflict/);
	assert.deepEqual(f.effects, [`save:${URI.file('/first').fsPath}`, 'reconnect']);
	assert.deepEqual(f.active.get('first'), DEVELOPMENT_DIR_PERMISSIONS);
	assert.deepEqual(f.active.get('second'), READ_DIR_PERMISSIONS);
	assert.equal(f.trust.isWorkspaceTrusted(), false);
});

test('the permission editor revision and removed participants remain authoritative during transitions', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const participant = f.trust.addWorkspaceTrustTransitionParticipant({ participate: async () => { throw new Error('Removed participant was called'); } });
	participant.dispose();
	await assert.rejects(f.trust.setUrisTrust([URI.file('/first')], true, 0), /Refresh before saving/);
	assert.deepEqual(f.effects, []);
	await f.trust.setUrisTrust([URI.file('/first')], true, 1);
	assert.equal(f.trust.isWorkspaceTrusted(), true);
});

test('a request joining an editor transition cannot return trust before its participants finish', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	using participant = f.trust.addWorkspaceTrustTransitionParticipant({ participate: async () => { await entered.complete(); await release.p; } });
	const transition = f.trust.setWorkspaceTrust(true);
	await entered.p;
	let finished = false;
	const request = f.requests.requestWorkspaceTrust();
	void request.then(() => { finished = true; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(finished, false);
	await release.complete();
	await transition;
	assert.equal(await request, true);
});

test('a failed participant does not publish trust and can be retried after removal', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const events: boolean[] = [];
	using listener = f.trust.onDidChangeTrust(trusted => events.push(trusted));
	const participant = f.trust.addWorkspaceTrustTransitionParticipant({ participate: async () => { throw new Error('Integration failed'); } });
	await assert.rejects(f.trust.setWorkspaceTrust(true), /Integration failed/);
	assert.equal(f.trust.isWorkspaceTrusted(), false);
	assert.deepEqual(events, []);
	participant.dispose();
	await f.trust.resolveWorkspaceTrust();
	assert.equal(f.trust.isWorkspaceTrusted(), true);
	assert.deepEqual(events, [true]);
});

for (const destination of ['local', 'other-host', 'replaced-provider'] as const) {
	test(`trust mutations reject a ${destination} remote canonical identity before saving`, async () => {
		using f = createTrustFixture();
		await f.trust.workspaceTrustInitialized;
		const authority = 'team+build';
		const uri = URI.parse(`ash-remote://${authority}/first`);
		f.workspace.updateWorkspace({ id: 'remote', uri });
		const address = { authority, connectTo: new WebSocketRemoteConnection('localhost', 5000), connectionToken: undefined };
		f.resolver._setResolvedAuthority(address, { isTrusted: true });
		const entered = new DeferredPromise<void>();
		const canonical = new DeferredPromise<URI>();
		f.resolver._setCanonicalURIProvider(async () => { await entered.complete(); return canonical.p; });
		const mutation = f.trust.setUrisTrust([uri], true);
		await entered.p;
		if (destination === 'replaced-provider') f.resolver._setResolvedAuthority(address, { isTrusted: false });
		await canonical.complete(destination === 'local' ? URI.file('/first') : destination === 'other-host' ? uri.with({ authority: 'team+other' }) : uri);
		await assert.rejects(mutation, destination === 'replaced-provider' ? isCancellationError : /cannot manage directory permissions/);
		assert.deepEqual(f.effects, []);
	});
}

test('terminal recovery failure releases initialization as restricted and a later refresh remains usable', async () => {
	using f = createTrustFixture(true);
	f.status = 'failed';
	f.recovered.fire();
	await f.trust.workspaceResolved;
	await f.trust.workspaceTrustInitialized;
	assert.equal(f.trust.isWorkspaceTrusted(), false);
	f.status = 'idle';
	f.recovered.fire();
	await f.trust.resolveWorkspaceTrust();
	await f.trust.setWorkspaceTrust(true);
	assert.equal(f.trust.isWorkspaceTrusted(), true);
});

test('explicit trust resolution waits for the replacement read when its original snapshot is invalidated', async () => {
	using f = createTrustFixture();
	await f.trust.workspaceTrustInitialized;
	const gate = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	f.readGate = gate;
	f.readStarted = started;
	f.active.set('first', DEVELOPMENT_DIR_PERMISSIONS);
	const resolving = f.trust.resolveWorkspaceTrust();
	await started.p;
	f.recovered.fire();
	f.readGate = undefined;
	await gate.complete();
	await resolving;
	assert.equal(f.trust.isWorkspaceTrusted(), true);
});

function createTrustFixture(recovering = false, multiRoot = false) {
	const resources = new DisposableStore();
	const first = { id: 'first', name: 'first', uri: URI.file('/first'), index: 0 };
	const folders = multiRoot ? [first, { id: 'second', name: 'second', uri: URI.file('/second'), index: 1 }] : [first];
	const workspace = resources.add(new TestWorkspaceService({ id: 'workspace', folders }));
	const changed = resources.add(new Emitter<void>());
	const recovered = resources.add(new Emitter<void>());
	const state = {
		status: recovering ? 'recovering' as 'recovering' | 'idle' | 'failed' : 'idle' as 'recovering' | 'idle' | 'failed',
		readGate: undefined as DeferredPromise<void> | undefined,
		readStarted: undefined as DeferredPromise<void> | undefined,
		failPath: undefined as string | undefined,
		effects: [] as string[],
		saved: new Map(folders.map(folder => [folder.id, READ_DIR_PERMISSIONS])),
		active: new Map(folders.map(folder => [folder.id, READ_DIR_PERMISSIONS])),
	};
	let revision = 1;
	const services = resources.add(new InstantiationService());
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkspaceTrustApi, {
		onDidChangeTrust: changed.event,
		readWorkspaceDirectory: async id => { await state.readStarted?.complete(); await state.readGate?.p; return state.active.get(id) ?? READ_DIR_PERMISSIONS; },
		readDirectory: async path => ({ dir: path.slice(1), permissions: state.saved.get(path.slice(1)) }),
		listDirectories: async () => ({ revision, entries: [...state.saved].map(([dir, permissions]) => ({ dir, path: `/${dir}`, permissions })) }),
		setDirectoryPermissions: async (path, permissions, expectedRevision) => {
			if (path === state.failPath || expectedRevision !== revision) throw new Error('Revision conflict');
			state.effects.push(`save:${path}`);
			state.saved.set(path.slice(1), permissions);
			changed.fire();
			return { revision: ++revision, generation: 1, disposition: 'updated' };
		},
		forgetDirectory: async () => { throw new Error('Unexpected forget'); },
		createGrant: async () => { throw new Error('Unexpected grant creation'); },
		persistGrant: async () => { throw new Error('Unexpected startup grant'); },
	});
	const resolver = resources.add(services.createInstance(RemoteAuthorityResolverService));
	services.registerInstance(IRemoteAuthorityResolverService, resolver);
	services.registerInstance(IAppServerApi, {
		connectionGeneration: 1, getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None, getSlashCommands: async () => [],
		recovery: {
			get status() { return state.status; }, error: undefined, onDidChange: recovered.event,
			reconnect: async () => {
				state.effects.push('reconnect'); state.status = 'recovering'; recovered.fire();
				state.active = new Map(state.saved); state.status = 'idle'; recovered.fire();
			},
		},
	});
	const notifications = resources.add(new TestNotificationService());
	services.registerInstance(INotificationService, notifications);
	const trust = resources.add(services.createInstance(WorkspaceTrustManagementService));
	services.registerInstance(IWorkspaceTrustManagementService, trust);
	const requests = resources.add(services.createInstance(WorkspaceTrustRequestService));
	return Object.assign(state, { trust, requests, workspace, resolver, recovered, notifications, [Symbol.dispose]: () => resources.dispose() });
}
