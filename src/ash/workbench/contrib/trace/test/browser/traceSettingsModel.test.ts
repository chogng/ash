import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ITraceSettingsService, type TraceSettings, type TraceSettingsSnapshot } from '../../../../../platform/trace/common/traceSettingsService.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TraceSettingsModel } from '../../browser/traceSettingsModel.js';

function field(model: TraceSettingsModel, id: string) {
	const result = model.fields.find(candidate => candidate.id === id);
	assert.ok(result);
	return result;
}

async function run(model: TraceSettingsModel, id: string): Promise<void> {
	const action = field(model, id);
	assert.equal(action.kind, 'action');
	if (action.kind === 'action') { await action.run(); }
}

function set(model: TraceSettingsModel, id: string, value: string | boolean): void {
	const control = field(model, id);
	if (control.kind === 'text' && typeof value === 'string') { control.setValue(value); }
	else if (control.kind === 'boolean' && typeof value === 'boolean') { control.setValue(value); }
	else { assert.fail('Wrong field kind'); }
}

function services(trace: ITraceSettingsService): InstantiationService {
	const result = new InstantiationService();
	result.registerInstance(ITraceSettingsService, trace);
	result.registerInstance(IRemoteAgentService, { connectionState: 'connected', connection: { kind: 'local', generation: 1 }, onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
	result.registerInstance(IFileDialogService, { showOpenDialog: async () => [URI.file('/recordings')], showSaveDialog: async () => undefined, pickFileToSave: async () => undefined, showSaveConfirm: async () => 2 });
	return result;
}

suite('Execution trace settings model', () => {
	test('saves against the backend revision and keeps running state distinct until restart', async () => {
		let snapshot: TraceSettingsSnapshot = { revision: 7, configured: null, recording: { type: 'disabled' } };
		const updates: { settings: TraceSettings; revision: number; }[] = [];
		using service = services({ onDidChange: Event.None, read: async () => snapshot, configure: async (settings, revision) => { updates.push({ settings, revision }); snapshot = { ...snapshot, revision: 8, configured: settings }; } });
		using model = service.createInstance(TraceSettingsModel);
		model.setVisible(true);
		await run(model, 'refresh');
		set(model, 'enabled', true);
		await run(model, 'save');
		assert.deepEqual(updates, [], 'A missing directory must not be persisted');
		await run(model, 'choose');
		await run(model, 'save');
		assert.deepEqual(updates, [{ settings: { enabled: true, directory: URI.file('/recordings').fsPath }, revision: 7 }]);
		assert.match(JSON.stringify(field(model, 'current')), /recording is off/);
		assert.match(JSON.stringify(field(model, 'application')), /require restarting/);
		snapshot = { ...snapshot, recording: { type: 'enabled', directory: URI.file('/recordings').fsPath } };
		await run(model, 'refresh');
		assert.match(JSON.stringify(field(model, 'application')), /match the running backend/);
	});

	test('external changes block a dirty save and hiding rejects late reads', async () => {
		using changes = new Emitter<void>();
		const pending = new DeferredPromise<TraceSettingsSnapshot>();
		let held = false;
		using service = services({ onDidChange: changes.event, read: async () => held ? pending.p : { revision: 1, configured: null, recording: { type: 'disabled' } }, configure: async () => assert.fail('Stale settings must not save') });
		using model = service.createInstance(TraceSettingsModel);
		model.setVisible(true);
		await run(model, 'refresh');
		set(model, 'directory', '/draft');
		changes.fire();
		const save = field(model, 'save');
		assert.ok(save.kind === 'action' && !save.enabled);
		await run(model, 'save');
		held = true;
		const reading = run(model, 'refresh');
		model.setVisible(false);
		await pending.complete({ revision: 2, configured: { enabled: true, directory: '/late' }, recording: { type: 'enabled', directory: '/late' } });
		await reading;
		const directory = field(model, 'directory');
		assert.ok(directory.kind === 'text' && directory.value === '/draft');
	});
});
