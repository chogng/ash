import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IDirPermissionsService, type DirPermission } from '../../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceContextService } from '../../browser/workspaceContextService.js';
import { WorkspaceTrustManagementService } from '../../common/workspaceTrust.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { RemoteAuthorityResolverService as DesktopRemoteAuthorityResolverService } from '../../../../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../../platform/extensionHost/common/extensionHostApi.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { NativeExtensionService } from '../../../extensions/electron-browser/nativeExtensionService.js';

test('Workspace Trust reads current Rust permissions for each workspace folder', async () => {
	using changes = new Emitter<void>();
	using workspace = new WorkspaceContextService({ id: 'empty' });
	const allowed = new Map<string, readonly DirPermission[]>();
	const reads: string[] = [];
	const permissions: IDirPermissionsService = {
		onDidChangePermissions: changes.event,
		list: async () => ({ revision: 0, entries: [] }),
		read: async path => { reads.push(path); return allowed.get(path); },
		set: async () => { throw new Error('Unexpected permission write'); },
		resolve: async () => { throw new Error('Unexpected permission identity resolution'); },
		forget: async () => { throw new Error('Unexpected permission deletion'); },
	};
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IDirPermissionsService, permissions);
	using resolver = services.createInstance(RemoteAuthorityResolverService);
	services.registerInstance(IRemoteAuthorityResolverService, resolver);
	using trust = services.createInstance(WorkspaceTrustManagementService);
	let notifications = 0;
	using listener = trust.onDidChangeTrust(() => notifications += 1);
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);

	const first = URI.file('/workspaces/first');
	workspace.updateWorkspace({ id: 'first', uri: first });
	assert.equal(await trust.getWorkspaceTrustInfo(), undefined);
	allowed.set(first.fsPath, READ_DIR_PERMISSIONS);
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: true });
	assert.deepEqual(reads, [first.fsPath, first.fsPath]);

	allowed.set(first.fsPath, [...READ_DIR_PERMISSIONS, 'executeCommands']);
	changes.fire();
	assert.deepEqual(await trust.getWorkspaceTrustInfo(), { isTrusted: false, isReadOnly: false });
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
});

for (const prefix of ['ssh', 'team']) {
	test(`remote trust uses ${prefix} resolver canonical identity without turning its hint into a directory grant`, async () => {
		using changes = new Emitter<void>();
		using fleetChanges = new Emitter<number>();
		using workspace = new WorkspaceContextService({ id: 'remote', uri: URI.parse(`ash-remote://${prefix}+build/alias`) });
		using services = new InstantiationService();
		using resolver = services.createInstance(DesktopRemoteAuthorityResolverService);
		services.registerInstance(IRemoteAuthorityResolverService, resolver);
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerSingleton(IRemoteSocketFactoryService, () => services.createInstance(RemoteSocketFactoryService));
		let trustHint = true;
		let canonical = URI.parse(`ash-remote://${prefix}+build/canonical`);
		let allowed: readonly DirPermission[] = READ_DIR_PERMISSIONS;
		const reads: string[] = [];
		services.registerInstance(IDirPermissionsService, {
			onDidChangePermissions: changes.event, list: async () => ({ revision: 0, entries: [] }),
			read: async path => { reads.push(path); return allowed; },
			set: async () => { throw new Error('Resolver must not grant permissions'); },
			resolve: async () => { throw new Error('Resolver must not replace Rust identity ownership'); },
			forget: async () => { throw new Error('Unexpected permission deletion'); },
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
		assert.deepEqual(reads, ['/canonical']);
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
