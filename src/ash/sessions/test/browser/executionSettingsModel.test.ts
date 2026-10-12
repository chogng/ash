import type { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import type { IDirPermissionsService, DirPermission } from '../../../platform/dirPermissions/common/dirPermissionsService.js';
import type { IAgentExecutionSettingsService, ExecutionSettings } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import type { IAgentCapabilitiesService } from '../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import type { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { IAppServerRemoteAgentService } from '../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { ExecutionSettingsModel } from '../../contrib/preferences/browser/executionSettingsModel.js';

function field(model: ExecutionSettingsModel, id: string) { return model.fields.find(field => field.id === id)!; }
function ready(model: ExecutionSettingsModel): Promise<void> {
	return new Promise(resolve => {
		const listener = model.onDidChange(() => {
			const approval = field(model, 'approval');
			if (approval.kind === 'select' && approval.enabled) { listener.dispose(); resolve(); }
		});
	});
}

test('execution settings preserve an unsaved default while saving an aliased directory and retain discovery capabilities', async () => {
	let settings: ExecutionSettings = { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' };
	const execution: IAgentExecutionSettingsService = { onDidChange: Event.None, read: async () => ({ revision: 1, settings }), configure: async draft => { settings = draft; } };
	let permissions: readonly DirPermission[] = ['readFiles', 'loadInstructions', 'discoverSkills'];
	let forgotten = false;
	const directories: IDirPermissionsService = {
		onDidChangePermissions: Event.None,
		list: async () => ({ revision: 1, entries: forgotten ? [] : [{ dir: 'same-directory', path: '/canonical', permissions }] }),
		read: async () => permissions,
		resolve: async () => ({ dir: 'same-directory', permissions }),
		set: async (_path, granted, revision) => { assert.equal(revision, 1); permissions = granted; return { revision: 2, generation: 2, disposition: 'updated' }; },
		forget: async dir => { assert.equal(dir, 'same-directory'); forgotten = true; return { revision: 3, generation: 3, disposition: 'updated' }; },
	};
	const capabilities: IAgentCapabilitiesService = { isAvailable: true, read: async () => ({ directoryGrantsReadable: true, tools: [], toolSets: [], sandboxBackends: [], sandboxDiagnostics: [], localProcessSandboxConfigured: true }) };
	const remote = { connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService;
	using model = new ExecutionSettingsModel(execution, directories, capabilities, remote, {} as IDialogService, { translate: (_bundle, _key, fallback) => fallback } as ILocalizationService);
	const initialized = ready(model); model.setVisible(true); await initialized;
	const approval = field(model, 'approval'); assert.equal(approval.kind, 'select'); if (approval.kind === 'select') approval.setValue('auto');
	const path = field(model, 'directory'); if (path.kind === 'text') path.setValue('/alias');
	const access = field(model, 'directory-access'); if (access.kind === 'select') access.setValue('commands');
	const saveDirectory = field(model, 'save-directory'); assert.equal(saveDirectory.kind, 'action'); if (saveDirectory.kind === 'action') { assert.ok(saveDirectory.enabled); await saveDirectory.run(); }
	assert.ok(permissions.includes('executeCommands')); assert.ok(permissions.includes('loadInstructions')); assert.ok(permissions.includes('discoverSkills'));
	const canonical = field(model, 'directory'); assert.ok(canonical.kind === 'text' && canonical.value === '/canonical');
	const savedApproval = field(model, 'approval'); assert.ok(savedApproval.kind === 'select' && savedApproval.value === 'auto');
	const save = field(model, 'save'); if (save.kind === 'action') { assert.ok(save.enabled); await save.run(); }
	assert.equal(settings.approvalMode, 'auto');
	const revoke = field(model, 'revoke-directory'); if (revoke.kind === 'action') { assert.ok(revoke.enabled); await revoke.run(); }
	assert.ok(forgotten);
});


function executionFixture(execution: IAgentExecutionSettingsService) {
	return new ExecutionSettingsModel(execution,
		{ onDidChangePermissions: Event.None } as IDirPermissionsService,
		{ read: async () => ({ directoryGrantsReadable: false }) } as IAgentCapabilitiesService,
		{ connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService,
		{} as IDialogService, { translate: (_bundle, _key, fallback) => fallback } as ILocalizationService);
}
const manualDefaults: ExecutionSettings = { approvalMode: 'manual', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' };

test('Execution defaults reject a failed save, retain its draft and require an explicit refresh', async () => {
	using model = executionFixture({ onDidChange: Event.None, read: async () => ({ revision: 7, settings: manualDefaults }), configure: async () => { throw new Error('revision conflict'); } });
	const initialized = ready(model); model.setVisible(true); await initialized;
	const approval = field(model, 'approval'); if (approval.kind === 'select') approval.setValue('auto');
	const save = field(model, 'save'); if (save.kind === 'action') await save.run();
	assert.ok(field(model, 'save').kind === 'action');
	const failedSave = field(model, 'save'); assert.ok(failedSave.kind === 'action' && !failedSave.enabled);
	const draft = field(model, 'approval'); assert.ok(draft.kind === 'select' && draft.value === 'auto');
	const message = field(model, 'status'); assert.ok(message.kind === 'status' && message.text.includes('revision conflict'));
	const refresh = field(model, 'refresh'); if (refresh.kind === 'action') await refresh.run();
	const refreshed = field(model, 'approval'); assert.ok(refreshed.kind === 'select' && refreshed.value === 'manual');
});

test('Execution settings ignore a late read from the previously hidden page', async () => {
	const old = new DeferredPromise<{ revision: number; settings: ExecutionSettings; }>();
	let reads = 0;
	using model = executionFixture({ onDidChange: Event.None, read: () => ++reads === 1 ? old.p : Promise.resolve({ revision: 2, settings: { ...manualDefaults, approvalMode: 'auto' } }), configure: async () => { } });
	model.setVisible(true); model.setVisible(false);
	const initialized = ready(model); model.setVisible(true); await initialized;
	await old.complete({ revision: 1, settings: manualDefaults });
	await Promise.resolve(); await Promise.resolve();
	const current = field(model, 'approval'); assert.ok(current.kind === 'select' && current.value === 'auto');
});


test('A backend change received during execution-default loading is reread before edits use its revision', async () => {
	using updates = new Emitter<void>();
	const old = new DeferredPromise<{ revision: number; settings: ExecutionSettings; }>();
	let reads = 0;
	using model = executionFixture({ onDidChange: updates.event, read: () => ++reads === 1 ? old.p : Promise.resolve({ revision: 2, settings: { ...manualDefaults, approvalMode: 'auto' } }), configure: async () => { } });
	model.setVisible(true);
	updates.fire();
	await old.complete({ revision: 1, settings: manualDefaults });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(reads, 2);
	const current = field(model, 'approval');
	assert.ok(current.kind === 'select' && current.value === 'auto' && current.enabled);
});
