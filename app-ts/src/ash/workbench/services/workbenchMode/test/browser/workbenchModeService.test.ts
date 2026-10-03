import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { LifecyclePhase, StartupKind, type ILifecycleService, type ShutdownReason } from '../../../lifecycle/common/lifecycle.js';
import { WorkbenchModeId } from '../../../../common/workbenchMode.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { WorkbenchModeService } from '../../browser/workbenchModeService.js';

test('selecting Code keeps the current window and configuration', async () => {
	using configuration = new WorkbenchConfigurationService();
	const actions: string[] = [];
	const lifecycle = lifecycleService(reason => actions.push(`shutdown:${reason}`));
	using service = new WorkbenchModeService({
		currentModeId: WorkbenchModeId.Code,
		configurationService: configuration,
		lifecycleService: lifecycle,
		switchHostMode: async modeId => { actions.push(`host:${modeId}`); },
	});

	await service.switchMode(WorkbenchModeId.Code);

	assert.equal(configuration.getValue(WorkbenchConfiguration.mode), WorkbenchModeId.Code);
	assert.deepEqual(actions, []);
});

test('Workbench mode options come from the canonical registry', () => {
	using configuration = new WorkbenchConfigurationService();
	using service = new WorkbenchModeService({
		currentModeId: WorkbenchModeId.Code,
		configurationService: configuration,
		lifecycleService: lifecycleService(() => undefined),
		switchHostMode: async () => undefined,
	});

	assert.deepEqual(service.availableModes, [
		{ id: WorkbenchModeId.Code, label: 'Code' },
	]);
});

test('selecting the active Workbench mode is a no-op', async () => {
	using configuration = new WorkbenchConfigurationService();
	const actions: string[] = [];
	using service = new WorkbenchModeService({
		currentModeId: WorkbenchModeId.Code,
		configurationService: configuration,
		lifecycleService: lifecycleService(reason => actions.push(`shutdown:${reason}`)),
		switchHostMode: async modeId => { actions.push(`host:${modeId}`); },
	});

	await service.switchMode(WorkbenchModeId.Code);

	assert.deepEqual(actions, []);
});

test('resetting the only mode removes its override without reloading', async () => {
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(WorkbenchConfiguration.mode, WorkbenchModeId.Code);
	const actions: string[] = [];
	using service = new WorkbenchModeService({
		currentModeId: WorkbenchModeId.Code,
		configurationService: configuration,
		lifecycleService: lifecycleService(reason => actions.push(`shutdown:${reason}`)),
		switchHostMode: async modeId => { actions.push(`host:${modeId}`); },
	});

	await service.resetMode();

	assert.equal(configuration.getValue(WorkbenchConfiguration.mode), WorkbenchModeId.Code);
	assert.deepEqual(actions, []);
});

function lifecycleService(onShutdown: (reason: ShutdownReason) => void): ILifecycleService {
	return {
		phase: LifecyclePhase.Ready,
		startupKind: StartupKind.NewWindow,
		willShutdown: false,
		async when(): Promise<void> {},
		onBeforeShutdown: Event.None,
		onBeforeShutdownError: Event.None,
		onShutdownVeto: Event.None,
		onWillShutdown: Event.None,
		onDidShutdown: Event.None,
		async shutdown(reason): Promise<void> { onShutdown(reason); },
	};
}
