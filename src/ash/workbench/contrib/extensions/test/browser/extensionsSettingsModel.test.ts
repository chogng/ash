import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IExtensionManagementService, type ExtensionUpdatePolicy, type ExtensionUpdatesSnapshot } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { SettingsSectionField } from '../../../../services/preferences/common/preferences.js';
import { ExtensionsSettingsModel } from '../../browser/extensionsSettingsModel.js';

function field<K extends SettingsSectionField['kind']>(model: ExtensionsSettingsModel, id: string, kind: K): Extract<SettingsSectionField, { kind: K; }> {
	const result = model.fields.find(field => field.id === id);
	assert.equal(result?.kind, kind);
	return result as Extract<SettingsSectionField, { kind: K; }>;
}

function changed(model: ExtensionsSettingsModel, predicate: () => boolean = () => true): Promise<void> {
	return new Promise(resolve => {
		const listener = model.onDidChange(() => { if (predicate()) { listener.dispose(); resolve(); } });
	});
}

test('Extension settings read the backend policy, save revisions and reuse source and notification commands', async () => {
	using services = new InstantiationService();
	using changes = new Emitter<void>();
	let snapshot: ExtensionUpdatesSnapshot = { revision: 3, policy: { autoCheckUpdates: true, autoUpdate: false }, canManage: true, checking: false, lastCheckedAt: undefined, available: [], updated: [], failures: [] };
	const writes: unknown[] = [];
	const commands: string[] = [];
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: changes.event,
		updates: async () => snapshot,
		sources: async () => ({ revision: 0, sources: [{ id: 'example', kind: 'ash', enabled: true, productOwned: false }] }),
		setUpdatePolicy: async (policy: ExtensionUpdatePolicy, expectedRevision: number) => {
			writes.push({ policy, expectedRevision });
			snapshot = { ...snapshot, policy, revision: snapshot.revision + 1 };
			return snapshot;
		},
		checkForUpdates: async () => {
			snapshot = { ...snapshot, lastCheckedAt: 1000 };
			return snapshot;
		},
	} as unknown as IExtensionManagementService);
	services.registerInstance(ICommandService, { executeCommand: async (id: string) => { commands.push(id); } } as unknown as ICommandService);
	using model = services.createInstance(ExtensionsSettingsModel);
	const loaded = changed(model);
	model.setVisible(true);
	await loaded;
	assert.equal(field(model, 'auto-check-updates', 'boolean').value, true);
	assert.match(field(model, 'sources-status', 'status').text, /example: Enabled/);
	const updated = changed(model, () => field(model, 'auto-update', 'boolean').enabled && field(model, 'auto-update', 'boolean').value);
	field(model, 'auto-update', 'boolean').setValue(true);
	await updated;
	assert.deepEqual(writes, [{ policy: { autoCheckUpdates: true, autoUpdate: true }, expectedRevision: 3 }]);
	const disabled = changed(model, () => field(model, 'auto-check-updates', 'boolean').enabled && !field(model, 'auto-check-updates', 'boolean').value);
	field(model, 'auto-check-updates', 'boolean').setValue(false);
	await disabled;
	assert.deepEqual(writes[1], { policy: { autoCheckUpdates: false, autoUpdate: false }, expectedRevision: 4 });
	await field(model, 'check-updates', 'action').run();
	assert.match(field(model, 'update-status', 'status').text, /Last checked:/);
	await field(model, 'manage-sources', 'action').run();
	await field(model, 'restore-notifications', 'action').run();
	assert.deepEqual(commands, ['ash.extensions.manageSources', 'ash.extensions.resetRecommendationNotifications']);
	assert.match(field(model, 'update-status', 'status').text, /were restored/);
	snapshot = { ...snapshot, canManage: false };
	const readOnly = changed(model);
	changes.fire();
	await readOnly;
	assert.equal(field(model, 'auto-update', 'boolean').enabled, false);
	assert.equal(field(model, 'manage-sources', 'action').enabled, false);
	assert.equal(field(model, 'restore-notifications', 'action').enabled, true);
});

test('Extension settings ignore reads completed after disposal and retain policy after a rejected save', async () => {
	using services = new InstantiationService();
	let resolveRead: ((value: ExtensionUpdatesSnapshot) => void) | undefined;
	const snapshot: ExtensionUpdatesSnapshot = { revision: 1, policy: { autoCheckUpdates: true, autoUpdate: false }, canManage: true, checking: false, lastCheckedAt: undefined, available: [], updated: [], failures: [] };
	let updates = async () => snapshot;
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: Event.None, updates: () => updates(), sources: async () => ({ revision: 0, sources: [] }),
		setUpdatePolicy: async () => { throw new Error('Revision conflict'); },
	} as unknown as IExtensionManagementService);
	services.registerInstance(ICommandService, { executeCommand: async () => { } } as unknown as ICommandService);
	using model = services.createInstance(ExtensionsSettingsModel);
	const loaded = changed(model);
	model.setVisible(true);
	await loaded;
	const failed = changed(model, () => field(model, 'auto-update', 'boolean').enabled && field(model, 'update-status', 'status').text.includes('Could not complete'));
	field(model, 'auto-update', 'boolean').setValue(true);
	await failed;
	assert.equal(field(model, 'auto-update', 'boolean').value, false);
	updates = () => new Promise(resolve => { resolveRead = resolve; });
	const stale = services.createInstance(ExtensionsSettingsModel);
	let events = 0;
	stale.onDidChange(() => { events++; });
	stale.setVisible(true);
	stale.dispose();
	resolveRead!(snapshot);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(events, 0);
});
