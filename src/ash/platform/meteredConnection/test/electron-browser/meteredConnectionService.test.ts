import type { NetworkInformation } from '../../browser/networkInformation.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ConfigurationRegistry } from '../../../configuration/common/configurationRegistry.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { IMeteredConnectionService } from '../../common/meteredConnection.js';
import { METERED_CONNECTION_CHANNEL, MeteredConnectionCommand } from '../../common/meteredConnectionIpc.js';
import { ElectronMeteredConnectionService } from '../../electron-browser/meteredConnectionService.js';
import { MeteredConnectionChannel } from '../../electron-main/meteredConnectionChannel.js';
import { MeteredConnectionMainService } from '../../electron-main/meteredConnectionMainService.js';
import { ElectronUpdateService } from '../../../update/electron-browser/updateService.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import '../../../update/common/update.config.contribution.js';
import { mock } from 'node:test';
import { IUpdateService } from '../../../update/common/updateService.js';
import { INotificationService } from '../../../notification/common/notification.js';
import { NotificationService } from '../../../../workbench/services/notification/common/notificationService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import '../../../../workbench/contrib/update/electron-browser/update.contribution.js';

class BrowserConnection extends EventTarget implements NetworkInformation {
	saveData = false;
	metered = false;
	effectiveType = '2g';
}

suite('Desktop metered connection renderer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports explicit browser signals, shares overrides across windows, and removes listeners on disposal', async () => {
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({ key: 'network.meteredConnection', defaultValue: 'auto', parse: value => value as string });
		using configuration = new InMemoryConfigurationService(registry);
		using mainServices = new InstantiationService();
		mainServices.registerInstance(IConfigurationService, configuration);
		using main = mainServices.createInstance(MeteredConnectionMainService);
		const channel = new MeteredConnectionChannel(main);
		using rendererServices = new InstantiationService();
		const reports: unknown[] = [];
		rendererServices.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel(name) {
				assert.equal(name, METERED_CONNECTION_CHANNEL);
				return {
					call(command, arg) {
						if (command === MeteredConnectionCommand.SetIsBrowserConnectionMetered) reports.push(arg);
						return channel.call('window:1', command, arg);
					},
					listen: (event, arg) => channel.listen('window:1', event, arg),
				};
			},
			registerChannel() { throw new Error('Unexpected renderer channel'); },
		});
		const connection = new BrowserConnection();
		using first = rendererServices.createInstance(ElectronMeteredConnectionService, () => connection);
		using second = rendererServices.createInstance(ElectronMeteredConnectionService, () => connection);
		await Promise.all([first.whenConnectionStateInitialized, second.whenConnectionStateInitialized]);
		assert.deepEqual([first.isConnectionMetered, second.isConnectionMetered], [false, false]);
		const changed = new DeferredPromise<boolean>();
		using subscription = second.onDidChangeIsConnectionMetered(value => { void changed.complete(value); });
		connection.saveData = true;
		connection.dispatchEvent(new Event('change'));
		assert.equal(await changed.p, true);
		await configuration.updateValue('network.meteredConnection', 'off');
		assert.deepEqual([first.isConnectionMetered, second.isConnectionMetered], [false, false]);
		first.dispose();
		second.dispose();
		await Promise.resolve();
		const reportCount = reports.length;
		connection.dispatchEvent(new Event('change'));
		await Promise.resolve();
		assert.equal(reports.length, reportCount);
	});

	test('an old initial snapshot cannot overwrite a pushed state', async () => {
		using changes = new Emitter<unknown>();
		const snapshot = new DeferredPromise<unknown>();
		const queried = new DeferredPromise<void>();
		using services = new InstantiationService();
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({
				async call<T>(command: string): Promise<T> {
					if (command === MeteredConnectionCommand.IsConnectionMetered) {
						void queried.complete();
						return await snapshot.p as T;
					}
					return undefined as T;
				},
				listen: <T>() => changes.event as import('../../../../base/common/event.js').Event<T>,
			}),
			registerChannel() { },
		});
		using renderer = services.createInstance(ElectronMeteredConnectionService, () => undefined);
		await queried.p;
		changes.fire(false);
		changes.fire(true);
		await snapshot.complete(false);
		await renderer.whenConnectionStateInitialized;
		assert.equal(renderer.isConnectionMetered, true);
	});

	test('disposal before initialization cancels queued reports and the initial query', async () => {
		using changes = new Emitter<unknown>();
		using services = new InstantiationService();
		const calls: string[] = [];
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({
				async call<T>(command: string): Promise<T> { calls.push(command); return false as T; },
				listen: <T>() => changes.event as import('../../../../base/common/event.js').Event<T>,
			}),
			registerChannel() { },
		});
		using renderer = services.createInstance(ElectronMeteredConnectionService, () => undefined);
		renderer.dispose();
		await renderer.whenConnectionStateInitialized;
		assert.deepEqual(calls, []);
	});

	test('manual checks and downloads bypass initialization while automatic checks wait', async () => {
		using services = new InstantiationService();
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		const ready = new DeferredPromise<void>();
		using changes = new Emitter<boolean>();
		services.registerInstance(IMeteredConnectionService, {
			_serviceBrand: undefined, isConnectionMetered: true,
			whenConnectionStateInitialized: ready.p, onDidChangeIsConnectionMetered: changes.event,
		});
		const calls: string[] = [];
		services.registerInstance(IMainProcessService, {
			_serviceBrand: undefined,
			getChannel: () => ({
				async call<T>(command: string): Promise<T> {
					calls.push(command);
					return undefined as T;
				},
				listen: () => { throw new Error('Unexpected update event'); },
			}),
			registerChannel() { },
		});
		const update = services.createInstance(ElectronUpdateService);
		const automatic = update.checkAutomatically();
		await update.checkForUpdates();
		await update.downloadUpdate();
		assert.deepEqual(calls, ['checkForUpdates', 'downloadUpdate']);
		await ready.complete();
		await automatic;
		assert.deepEqual(calls, ['checkForUpdates', 'downloadUpdate', 'checkAutomatically']);
	});

	test('the production contribution retries on unmetered transitions and releases timers and subscriptions', async () => {
		mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
		try {
			using services = new InstantiationService();
			using networkChanges = new Emitter<boolean>();
			using notifications = new NotificationService();
			services.registerInstance(INotificationService, notifications);
			services.registerInstance(IMeteredConnectionService, {
				_serviceBrand: undefined, isConnectionMetered: true,
				onDidChangeIsConnectionMetered: networkChanges.event,
			});
			let attempts = 0;
			services.registerInstance(IUpdateService, {
				async checkAutomatically() { attempts++; return undefined; },
				async checkForUpdates() { throw new Error('Unexpected manual check'); },
				async downloadUpdate() { throw new Error('Unexpected download'); },
				async installUpdate() { throw new Error('Unexpected install'); },
			});
			using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.desktopAutomaticUpdate']);
			host.advance(WorkbenchPhase.AfterRestored);
			networkChanges.fire(false);
			assert.equal(attempts, 0);
			mock.timers.tick(60_000);
			await Promise.resolve();
			assert.equal(attempts, 1);
			networkChanges.fire(true);
			assert.equal(attempts, 1);
			networkChanges.fire(false);
			await Promise.resolve();
			assert.equal(attempts, 2);
			host.dispose();
			networkChanges.fire(false);
			mock.timers.tick(24 * 60 * 60 * 1000);
			assert.equal(attempts, 2);
		} finally {
			mock.timers.reset();
		}
	});
});
