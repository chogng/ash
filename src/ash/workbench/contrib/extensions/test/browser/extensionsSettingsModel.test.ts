import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
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

test('Extension settings show only update preferences, save revisions and enforce read-only connections', async () => {
	using services = new InstantiationService();
	using changes = new Emitter<void>();
	let snapshot: ExtensionUpdatesSnapshot = { revision: 3, policy: { autoCheckUpdates: true, autoUpdate: false }, canManage: true, checking: false, lastCheckedAt: 1000, available: [], updated: [], failures: [] };
	const writes: unknown[] = [];
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: changes.event,
		updates: async () => snapshot,
		setUpdatePolicy: async (policy: ExtensionUpdatePolicy, expectedRevision: number) => {
			writes.push({ policy, expectedRevision });
			snapshot = { ...snapshot, policy, revision: snapshot.revision + 1 };
			return snapshot;
		},
	} as unknown as IExtensionManagementService);
	using model = services.createInstance(ExtensionsSettingsModel);
	const loaded = changed(model);
	model.setVisible(true);
	await loaded;
	assert.equal(field(model, 'auto-check-updates', 'boolean').value, true);
	assert.deepEqual(model.fields.filter(field => field.kind !== 'status').map(field => field.id), ['auto-check-updates', 'auto-update']);
	assert.equal(field(model, 'update-status', 'status').text, '');
	const updated = changed(model, () => field(model, 'auto-update', 'boolean').enabled && field(model, 'auto-update', 'boolean').value);
	field(model, 'auto-update', 'boolean').setValue(true);
	await updated;
	assert.deepEqual(writes, [{ policy: { autoCheckUpdates: true, autoUpdate: true }, expectedRevision: 3 }]);
	const disabled = changed(model, () => field(model, 'auto-check-updates', 'boolean').enabled && !field(model, 'auto-check-updates', 'boolean').value);
	field(model, 'auto-check-updates', 'boolean').setValue(false);
	await disabled;
	assert.deepEqual(writes[1], { policy: { autoCheckUpdates: false, autoUpdate: false }, expectedRevision: 4 });
	snapshot = { ...snapshot, canManage: false };
	const readOnly = changed(model);
	changes.fire();
	await readOnly;
	assert.equal(field(model, 'auto-update', 'boolean').enabled, false);
	assert.equal(field(model, 'auto-check-updates', 'boolean').enabled, false);
	assert.match(field(model, 'update-status', 'status').text, /authorized desktop or remote host/);
});

test('Extension settings ignore reads completed after disposal and retain policy after a rejected save', async () => {
	using services = new InstantiationService();
	let resolveRead: ((value: ExtensionUpdatesSnapshot) => void) | undefined;
	const snapshot: ExtensionUpdatesSnapshot = { revision: 1, policy: { autoCheckUpdates: true, autoUpdate: false }, canManage: true, checking: false, lastCheckedAt: undefined, available: [], updated: [], failures: [] };
	let updates = async () => snapshot;
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: Event.None, updates: () => updates(),
		setUpdatePolicy: async () => { throw new Error('Revision conflict'); },
	} as unknown as IExtensionManagementService);
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
