import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ITelemetryService, type ITelemetryData } from '../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { PosixShellType, TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../common/contributions.js';
import { ILifecycleService, type IWillShutdownEvent } from '../../../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalTelemetryContribution } from '../../browser/terminalTelemetry.js';
import { TerminalProfileConfigurationTelemetry } from '../../browser/terminalProfileConfigurationTelemetry.js';
import '../../../../terminal/common/terminalConfiguration.js';
import '../../browser/terminal.telemetry.contribution.js';

class CapturingTelemetry extends NullTelemetryServiceShape {
	readonly events: { name: string; data?: ITelemetryData; }[] = [];
	override publicLog(name: string, data?: ITelemetryData): void { this.events.push({ name, data }); }
}

function fixture(owner: DisposableStore) {
	const services = owner.add(new InstantiationService());
	const created = owner.add(new Emitter<ITerminalInstance>());
	const disposed = owner.add(new Emitter<ITerminalInstance>());
	const exit = owner.add(new Emitter<number | undefined>());
	const shutdown = owner.add(new Emitter<IWillShutdownEvent>());
	const telemetry = new CapturingTelemetry();
	const configuration = owner.add(new InMemoryConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ITelemetryService, telemetry);
	services.registerInstance(ILifecycleService, { onWillShutdown: shutdown.event } as ILifecycleService);
	services.registerInstance(ITerminalService, { instances: [], onDidCreateInstance: created.event, onDidDisposeInstance: disposed.event } as unknown as ITerminalService);
	const instance = { onDidExit: exit.event, target: TerminalLocation.Panel, shellType: PosixShellType.Zsh, shellLaunchConfig: { executable: '/private/path', env: { SECRET: 'private' }, name: 'private-name' } } as unknown as ITerminalInstance;
	return { services, telemetry, configuration, instance, created, disposed, exit, shutdown };
}

test('terminal telemetry production contribution reports once on disposal and cancels its deferred observer with the window', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using owner = new DisposableStore();
		const f = fixture(owner);
		const failures: unknown[] = [];
		const host = owner.add(WorkbenchContributionsRegistry.createHost(f.services, error => { failures.push(error); }, [TerminalTelemetryContribution.ID]));
		host.advance(WorkbenchPhase.AfterRestored);
		assert.deepEqual(failures, []);
		f.created.fire(f.instance);
		f.disposed.fire(f.instance);
		assert.deepEqual(f.telemetry.events, [{ name: 'terminal/createInstance', data: { location: 'view', shellType: 'zsh', isCustomPtyImplementation: false, shellIntegrationQuality: 0 } }]);
		mock.timers.tick(10000);
		assert.equal(f.telemetry.events.length, 1);
		f.created.fire(f.instance);
		host.dispose();
		mock.timers.tick(10000);
		assert.equal(f.telemetry.events.length, 1);
		assert.equal(f.exit.hasListeners(), false);
	} finally { mock.timers.reset(); }
});

test('terminal telemetry observes current domain state after the integration grace period and flushes pending observations during shutdown', () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using owner = new DisposableStore();
		const f = fixture(owner);
		owner.add(f.services.createInstance(TerminalTelemetryContribution));
		f.created.fire(f.instance);
		mock.timers.tick(9999);
		assert.deepEqual(f.telemetry.events, []);
		mock.timers.tick(1);
		assert.equal(f.telemetry.events.length, 1);
		f.created.fire(f.instance);
		f.shutdown.fire({ reason: 'windowClose', join: () => { } });
		assert.equal(f.telemetry.events.length, 2);
		assert.equal(JSON.stringify(f.telemetry.events).includes('private'), false);
	} finally { mock.timers.reset(); }
});

test('terminal profile telemetry reports setting presence and kind without profile names, shell paths, arguments or environment', async () => {
	using owner = new DisposableStore();
	const f = fixture(owner);
	const contribution = owner.add(f.services.createInstance(TerminalProfileConfigurationTelemetry));
	const key = 'terminal.integrated.automationProfile.linux';
	await f.configuration.updateValue(key, { path: '/private/bin/shell', args: ['secret'], env: { PRIVATE: 'value' } });
	await f.configuration.updateValue(key, { path: '/other/shell' });
	await f.configuration.updateValue(key, undefined);
	assert.deepEqual(f.telemetry.events, ['added', 'changed', 'removed'].map(changeType => ({
		name: 'terminal/profileSettingChanged', data: { settingId: key, profileType: 'automation', os: 'linux', configured: changeType !== 'removed', changeType, source: 'MEMORY' },
	})));
	assert.equal(JSON.stringify(f.telemetry.events).includes('private'), false);
	contribution.dispose();
	await f.configuration.updateValue(key, { path: '/ignored' });
	assert.equal(f.telemetry.events.length, 3);
});
