import type { WorkspaceTrustPermission } from '../../../platform/workspace/common/workspaceTrust.js';
import type { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import type { IWorkspaceTrustApi } from '../../../platform/workspace/common/workspaceTrust.js';
import type { IAgentExecutionSettingsService, ExecutionSettings } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAgentCapabilitiesService } from '../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import type { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { IAppServerRemoteAgentService } from '../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { ExecutionSettingsModel } from '../../contrib/preferences/browser/executionSettingsModel.js';
import { createDisconnectedRendererApi } from '../../../workbench/browser/rendererApi.js';
import type { ISessionProviderScope, ISessionProviderScopeService, SessionProviderServices } from '../../browser/agentHost/sessionProviderScopeService.js';

function createModel(
	execution: IAgentExecutionSettingsService,
	workspaceTrust: IWorkspaceTrustApi,
	agentCapabilities: IAgentCapabilitiesService,
	_remote: IAppServerRemoteAgentService,
	dialogs: IDialogService,
	localization: ILocalizationService,
): ExecutionSettingsModel {
	const base = createDisconnectedRendererApi();
	const host = {
		...base,
		executionSettings: execution,
		workspaceTrust,
		agentCapabilities,
		appServer: { ...base.appServer, getConnectionState: async () => 'ready' as const },
	};
	const scope = {
		providerId: 'primary',
		services: { host } as unknown as SessionProviderServices,
		thread: host.thread,
		assertCurrent: () => {},
		identity: value => value,
		backendIdentity: value => value,
	} satisfies ISessionProviderScope;
	return new ExecutionSettingsModel(
		{
			getScope: () => scope,
			onDidChange: Event.None,
			onDidChangeScopes: Event.None,
		} as unknown as ISessionProviderScopeService,
		dialogs,
		localization,
	);
}

function field(model: ExecutionSettingsModel, id: string) {
	return model.fields.find(field => field.id === id)!;
}
function ready(model: ExecutionSettingsModel): Promise<void> {
	return new Promise(resolve => {
		const listener = model.onDidChange(() => {
			const approval = field(model, 'approval');
			if (approval.kind === 'select' && approval.enabled) {
				listener.dispose();
				resolve();
			}
		});
	});
}

test('execution settings preserve an unsaved default while saving an aliased directory and retain discovery capabilities', async () => {
	let settings: ExecutionSettings = {
		approvalMode: 'manual',
		commandFileAccess: 'directoryWrite',
		commandNetworkAccess: 'denied',
	};
	const execution: IAgentExecutionSettingsService = {
		onDidChange: Event.None,
		read: async () => ({ revision: 1, settings }),
		configure: async draft => {
			settings = draft;
		},
	};
	let permissions: readonly WorkspaceTrustPermission[] = ['readFiles', 'loadInstructions', 'discoverSkills'];
	let forgotten = false;
	const directories: IWorkspaceTrustApi = {
		readWorkspaceDirectory: async () => {
			throw new Error('Settings manage profile grants, not active directory permissions');
		},
		onDidChangeTrust: Event.None,
		createGrant: async () => {
			throw new Error('Unexpected grant preparation');
		},
		persistGrant: async () => {
			throw new Error('Unexpected host grant write');
		},
		listDirectories: async () => ({
			revision: 1,
			entries: forgotten ? [] : [{ dir: 'same-directory', path: '/canonical', permissions }],
		}),
		readDirectory: async () => ({ dir: 'same-directory', permissions }),
		setDirectoryPermissions: async (_path, granted, revision) => {
			assert.equal(revision, 1);
			permissions = granted;
			return { revision: 2, generation: 2, disposition: 'updated' };
		},
		forgetDirectory: async dir => {
			assert.equal(dir, 'same-directory');
			forgotten = true;
			return { revision: 3, generation: 3, disposition: 'updated' };
		},
	};
	const capabilities: IAgentCapabilitiesService = {
		isAvailable: true,
		onDidChange: Event.None,
		read: async () => ({
			directoryGrantsReadable: true,
			sandboxBackends: [],
			sandboxDiagnostics: [],
			localProcessSandboxConfigured: true,
		}),
	};
	const remote = {
		connectionState: 'connected',
		onDidChangeConnection: Event.None,
		onDidChangeConnectionState: Event.None,
	} as IAppServerRemoteAgentService;
	using model = createModel(execution, directories, capabilities, remote, {} as IDialogService, { translate: (_bundle, _key, fallback) => fallback } as ILocalizationService);
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	const approval = field(model, 'approval');
	assert.equal(approval.kind, 'select');
	if (approval.kind === 'select') approval.setValue('auto');
	const path = field(model, 'directory');
	if (path.kind === 'text') path.setValue('/alias');
	const access = field(model, 'directory-access');
	if (access.kind === 'select') access.setValue('commands');
	const saveDirectory = field(model, 'save-directory');
	assert.equal(saveDirectory.kind, 'action');
	if (saveDirectory.kind === 'action') {
		assert.ok(saveDirectory.enabled);
		await saveDirectory.run();
	}
	assert.ok(permissions.includes('executeCommands'));
	assert.ok(permissions.includes('loadInstructions'));
	assert.ok(permissions.includes('discoverSkills'));
	const canonical = field(model, 'directory');
	assert.ok(canonical.kind === 'text' && canonical.value === '/canonical');
	const savedApproval = field(model, 'approval');
	assert.ok(savedApproval.kind === 'select' && savedApproval.value === 'auto');
	const save = field(model, 'save');
	if (save.kind === 'action') {
		assert.ok(save.enabled);
		await save.run();
	}
	assert.equal(settings.approvalMode, 'auto');
	const revoke = field(model, 'revoke-directory');
	if (revoke.kind === 'action') {
		assert.ok(revoke.enabled);
		await revoke.run();
	}
	assert.ok(forgotten);
});

function executionFixture(execution: IAgentExecutionSettingsService) {
	return createModel(
		execution,
		{ onDidChangeTrust: Event.None } as IWorkspaceTrustApi,
		{ read: async () => ({ directoryGrantsReadable: false }) } as IAgentCapabilitiesService,
		{
			connectionState: 'connected',
			onDidChangeConnection: Event.None,
			onDidChangeConnectionState: Event.None,
		} as IAppServerRemoteAgentService,
		{} as IDialogService,
		{ translate: (_bundle, _key, fallback) => fallback } as ILocalizationService,
	);
}
const manualDefaults: ExecutionSettings = {
	approvalMode: 'manual',
	commandFileAccess: 'readOnly',
	commandNetworkAccess: 'denied',
};

test('a directory revision conflict preserves the draft and never silently retries its grant', async () => {
	const precise = Object.freeze(['readFiles', 'discoverSkills', 'useLanguageServices'] as const);
	const writes: unknown[] = [];
	const trust: IWorkspaceTrustApi = {
		readWorkspaceDirectory: async () => {
			throw new Error('Settings manage profile grants, not active directory permissions');
		},
		onDidChangeTrust: Event.None,
		readDirectory: async () => ({ dir: 'canonical', permissions: precise }),
		listDirectories: async () => ({
			revision: 7,
			entries: [{ dir: 'canonical', path: '/canonical', permissions: precise }],
		}),
		setDirectoryPermissions: async (path, permissions, revision) => {
			writes.push({ path, permissions, revision });
			throw new Error('directory revision conflict');
		},
		forgetDirectory: async () => {
			throw new Error('Unexpected revocation');
		},
		createGrant: async () => {
			throw new Error('Unexpected host grant');
		},
		persistGrant: async () => {
			throw new Error('Unexpected host write');
		},
	};
	using model = createModel(
		{
			onDidChange: Event.None,
			read: async () => ({ revision: 3, settings: manualDefaults }),
			configure: async () => {},
		},
		trust,
		{
			isAvailable: true,
			onDidChange: Event.None,
			read: async () => ({
				directoryGrantsReadable: true,
				tools: [],
				sourceGroups: [],
				sandboxBackends: [],
				sandboxDiagnostics: [],
				localProcessSandboxConfigured: true,
			}),
		},
		{
			connectionState: 'connected',
			onDidChangeConnection: Event.None,
			onDidChangeConnectionState: Event.None,
		} as IAppServerRemoteAgentService,
		{} as IDialogService,
		{ translate: (_bundle, _key, fallback) => fallback } as ILocalizationService,
	);
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	const path = field(model, 'directory');
	if (path.kind === 'text') path.setValue('/alias');
	const access = field(model, 'directory-access');
	if (access.kind === 'select') access.setValue('commands');
	const save = field(model, 'save-directory');
	assert.equal(save.kind, 'action');
	if (save.kind === 'action') {
		await save.run();
		await save.run();
	}
	assert.deepEqual(writes, [
		{
			path: '/alias',
			revision: 7,
			permissions: ['readFiles', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository', 'writeFiles', 'mutateRepository', 'executeCommands', 'discoverSkills', 'useLanguageServices'],
		},
	]);
	const retained = field(model, 'directory');
	assert.ok(retained.kind === 'text' && retained.value === '/alias');
	const unavailable = field(model, 'save-directory');
	assert.ok(unavailable.kind === 'action' && !unavailable.enabled);
	const message = field(model, 'status');
	assert.ok(message.kind === 'status' && message.text.includes('directory revision conflict'));
});

test('Execution defaults reject a failed save, retain its draft and require an explicit refresh', async () => {
	using model = executionFixture({
		onDidChange: Event.None,
		read: async () => ({ revision: 7, settings: manualDefaults }),
		configure: async () => {
			throw new Error('revision conflict');
		},
	});
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	const approval = field(model, 'approval');
	if (approval.kind === 'select') approval.setValue('auto');
	const save = field(model, 'save');
	if (save.kind === 'action') await save.run();
	assert.ok(field(model, 'save').kind === 'action');
	const failedSave = field(model, 'save');
	assert.ok(failedSave.kind === 'action' && !failedSave.enabled);
	const draft = field(model, 'approval');
	assert.ok(draft.kind === 'select' && draft.value === 'auto');
	const message = field(model, 'status');
	assert.ok(message.kind === 'status' && message.text.includes('revision conflict'));
	const refresh = field(model, 'refresh');
	if (refresh.kind === 'action') await refresh.run();
	const refreshed = field(model, 'approval');
	assert.ok(refreshed.kind === 'select' && refreshed.value === 'manual');
});

test('Execution settings ignore a late read from the previously hidden page', async () => {
	const old = new DeferredPromise<{ revision: number; settings: ExecutionSettings }>();
	let reads = 0;
	using model = executionFixture({
		onDidChange: Event.None,
		read: () => (++reads === 1 ? old.p : Promise.resolve({ revision: 2, settings: { ...manualDefaults, approvalMode: 'auto' } })),
		configure: async () => {},
	});
	model.setVisible(true);
	await Promise.resolve();
	model.setVisible(false);
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	await old.complete({ revision: 1, settings: manualDefaults });
	await Promise.resolve();
	await Promise.resolve();
	const current = field(model, 'approval');
	assert.ok(current.kind === 'select' && current.value === 'auto');
});

test('A backend change received during execution-default loading is reread before edits use its revision', async () => {
	using updates = new Emitter<void>();
	const old = new DeferredPromise<{ revision: number; settings: ExecutionSettings }>();
	let reads = 0;
	using model = executionFixture({
		onDidChange: updates.event,
		read: () => (++reads === 1 ? old.p : Promise.resolve({ revision: 2, settings: { ...manualDefaults, approvalMode: 'auto' } })),
		configure: async () => {},
	});
	model.setVisible(true);
	await Promise.resolve();
	updates.fire();
	await old.complete({ revision: 1, settings: manualDefaults });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(reads, 2);
	const current = field(model, 'approval');
	assert.ok(current.kind === 'select' && current.value === 'auto' && current.enabled);
});

test('switching hosts retires an in-flight directory edit before a same-id grant can be written', async () => {
	using selection = new Emitter<void>();
	const base = createDisconnectedRendererApi();
	const oldDirectory = new DeferredPromise<{ dir: string; permissions: readonly WorkspaceTrustPermission[] }>();
	const writes: string[] = [];
	const host = (name: string, pending: boolean) => ({
		...base,
		appServer: { ...base.appServer, getConnectionState: async () => 'ready' as const },
		executionSettings: {
			onDidChange: Event.None,
			read: async () => ({ revision: 7, settings: manualDefaults }),
			configure: async () => {
				writes.push(`${name}:defaults`);
			},
		},
		agentCapabilities: {
			isAvailable: true,
			onDidChange: Event.None,
			read: async () => ({
				directoryGrantsReadable: true,
				localProcessSandboxConfigured: true,
				sandboxBackends: [],
				sandboxDiagnostics: [],
			}),
		},
		workspaceTrust: {
			...base.workspaceTrust,
			onDidChangeTrust: Event.None,
			listDirectories: async () => ({
				revision: 7,
				entries: [{ dir: 'same-id', path: '/same', permissions: ['readFiles'] as const }],
			}),
			readDirectory: async () => (pending ? oldDirectory.p : { dir: 'same-id', permissions: ['readFiles'] as const }),
			setDirectoryPermissions: async () => {
				writes.push(`${name}:grant`);
				return { revision: 8, generation: 1, disposition: 'updated' as const };
			},
		},
	});
	const scope = (name: string, pending: boolean): ISessionProviderScope => ({
		providerId: name,
		services: { host: host(name, pending) } as unknown as SessionProviderServices,
		thread: base.thread,
		identity: value => value,
		backendIdentity: value => value,
		assertCurrent: () => {},
	});
	let selected = scope('first', true);
	using model = new ExecutionSettingsModel(
		{
			getScope: () => selected,
			onDidChange: selection.event,
			onDidChangeScopes: Event.None,
		} as unknown as ISessionProviderScopeService,
		{} as IDialogService,
		{ translate: (_bundle, _key, fallback) => fallback } as ILocalizationService,
	);
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	const path = field(model, 'directory');
	if (path.kind === 'text') path.setValue('/same');
	const save = field(model, 'save-directory');
	assert.equal(save.kind, 'action');
	const saving = save.kind === 'action' ? save.run() : undefined;
	selected = scope('second', false);
	const rebound = ready(model);
	selection.fire();
	await rebound;
	await oldDirectory.complete({ dir: 'same-id', permissions: ['readFiles'] });
	await saving;
	assert.deepEqual(writes, []);
	const resetPath = field(model, 'directory');
	assert.ok(resetPath.kind === 'text' && resetPath.value === '');
	if (resetPath.kind === 'text') resetPath.setValue('/same');
	const saveSecond = field(model, 'save-directory');
	if (saveSecond.kind === 'action') await saveSecond.run();
	assert.deepEqual(writes, ['second:grant']);
});

test('a host switch during confirmation cannot apply the old defaults to either host', async () => {
	using selection = new Emitter<void>();
	const base = createDisconnectedRendererApi();
	const confirmation = new DeferredPromise<{ confirmed: boolean }>();
	const writes: string[] = [];
	const scope = (name: string): ISessionProviderScope => ({
		providerId: name,
		services: {
			host: {
				...base,
				appServer: { ...base.appServer, getConnectionState: async () => 'ready' },
				executionSettings: {
					onDidChange: Event.None,
					read: async () => ({ revision: 1, settings: manualDefaults }),
					configure: async () => {
						writes.push(name);
					},
				},
				agentCapabilities: {
					isAvailable: true,
					onDidChange: Event.None,
					read: async () => ({ directoryGrantsReadable: false }),
				},
			},
		} as unknown as SessionProviderServices,
		thread: base.thread,
		identity: value => value,
		backendIdentity: value => value,
		assertCurrent: () => {},
	});
	let selected = scope('first');
	using model = new ExecutionSettingsModel(
		{
			getScope: () => selected,
			onDidChange: selection.event,
			onDidChangeScopes: Event.None,
		} as unknown as ISessionProviderScopeService,
		{ confirm: () => confirmation.p } as unknown as IDialogService,
		{ translate: (_bundle, _key, fallback) => fallback } as ILocalizationService,
	);
	const initialized = ready(model);
	model.setVisible(true);
	await initialized;
	const approval = field(model, 'approval');
	if (approval.kind === 'select') approval.setValue('bypassPermissions');
	const save = field(model, 'save');
	const saving = save.kind === 'action' ? save.run() : undefined;
	selected = scope('second');
	const rebound = ready(model);
	selection.fire();
	await rebound;
	await confirmation.complete({ confirmed: true });
	await saving;
	assert.deepEqual(writes, []);
	const current = field(model, 'approval');
	assert.ok(current.kind === 'select' && current.value === 'manual');
});

test('execution accessibility help explains host changes in Chinese', async () => {
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { resetNlsResolver, setNlsMessages } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		using model = executionFixture({
			onDidChange: Event.None,
			read: async () => ({ revision: 1, settings: manualDefaults }),
			configure: async () => {},
		});
		assert.ok(model.help.includes('切换会话宿主会丢弃草稿'));
	} finally {
		resetNlsResolver();
	}
});
