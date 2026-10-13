import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationResourceService, type IConfigurationResourceSnapshot } from '../../../configuration/common/configurationResourceService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMeteredConnectionService } from '../../common/meteredConnection.js';
import { MeteredConnectionCommand } from '../../common/meteredConnectionIpc.js';
import { MeteredConnectionChannel } from '../../electron-main/meteredConnectionChannel.js';
import { MeteredConnectionMainService } from '../../electron-main/meteredConnectionMainService.js';
import { UpdateMainService } from '../../../update/electron-main/updateMainService.js';
import { Registry } from '../../../registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../configuration/common/configurationRegistry.js';
import { setNlsMessages, resetNlsResolver } from '../../../../nls.js';
import chineseMessages from '../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import { DefaultSettings } from '../../../../workbench/services/preferences/common/settingsModels.js';
import { createSettingsLayout } from '../../../../workbench/contrib/preferences/browser/settingsLayout.js';

suite('Desktop metered connection policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for browser state, broadcasts overrides, and rejects invalid IPC input', async () => {
		using changes = new Emitter<IConfigurationResourceSnapshot>();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationResourceService, {
			onDidChangeResource: changes.event,
			read: async () => ({ source: '{}', revision: 0 }),
			write: async () => { throw new Error('Unexpected configuration write'); },
		});
		using main = services.createInstance(MeteredConnectionMainService);
		const channel = new MeteredConnectionChannel(main);
		const observed: boolean[] = [];
		using subscription = channel.listen<boolean>('window:2', MeteredConnectionCommand.OnDidChangeIsConnectionMetered)(value => observed.push(value));
		let initialized = false;
		const initialState = channel.call('window:2', MeteredConnectionCommand.IsConnectionMetered).then(value => { initialized = true; return value; });
		await Promise.resolve();
		assert.equal(initialized, false);
		await assert.rejects(channel.call('window:1', MeteredConnectionCommand.SetIsBrowserConnectionMetered, 'true'), /boolean/);
		await assert.rejects(channel.call('window:1', MeteredConnectionCommand.IsConnectionMetered, {}), /no arguments/);
		assert.throws(() => channel.listen('window:1', MeteredConnectionCommand.OnDidChangeIsConnectionMetered, {}), /no arguments/);
		await channel.call('window:1', MeteredConnectionCommand.SetIsBrowserConnectionMetered, true);
		assert.equal(await initialState, true);
		changes.fire({ revision: 1, source: '{"network.meteredConnection":"off"}' });
		assert.equal(main.isConnectionMetered, false);
		changes.fire({ revision: 2, source: '{"network.meteredConnection":"on"}' });
		await channel.call('window:1', MeteredConnectionCommand.SetIsBrowserConnectionMetered, false);
		assert.equal(main.isConnectionMetered, true);
		changes.fire({ revision: 3, source: '{}' });
		assert.deepEqual({ state: main.isConnectionMetered, observed }, { state: false, observed: [true, false, true, false] });
	});

	test('a delayed configuration read cannot overwrite a newer setting', async () => {
		using changes = new Emitter<IConfigurationResourceSnapshot>();
		const initial = new DeferredPromise<IConfigurationResourceSnapshot>();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationResourceService, {
			onDidChangeResource: changes.event,
			read: () => initial.p,
			write: async () => { throw new Error('Unexpected configuration write'); },
		});
		using main = services.createInstance(MeteredConnectionMainService);
		main.setIsBrowserConnectionMetered(false);
		changes.fire({ revision: 2, source: '{"network.meteredConnection":"on"}' });
		await initial.complete({ revision: 1, source: '{}' });
		await main.whenConnectionStateInitialized;
		assert.equal(main.isConnectionMetered, true);
	});

	test('automatic checks wait, skip metered networks without consuming cooldown, and share cooldown across windows', async () => {
		using changes = new Emitter<IConfigurationResourceSnapshot>();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationResourceService, {
			onDidChangeResource: changes.event,
			read: async () => ({ source: '{}', revision: 0 }),
			write: async () => { throw new Error('Unexpected configuration write'); },
		});
		using main = services.createInstance(MeteredConnectionMainService);
		services.registerInstance(IMeteredConnectionService, main);
		const calls: string[] = [];
		class RecordingUpdateService extends UpdateMainService {
			override async checkForUpdates(policy: 'latest' | 'stable') {
				calls.push(policy);
				return { status: 'current' as const, version: '1' };
			}
		}
		// Host callbacks are injected so the real automatic-check gate runs
		// without launching an updater or requiring an Electron process.
		using update = services.createInstance(RecordingUpdateService, async () => { }, {
			isPackaged: true,
			getPath: () => '', getVersion: () => '1', getAppPath: () => '',
			quit() { }, relaunch() { },
		});
		const channel = new MeteredConnectionChannel(main);
		const automatic = update.checkAutomatically('latest');
		assert.deepEqual(await update.checkForUpdates('stable'), { status: 'current', version: '1' });
		await channel.call('window:1', MeteredConnectionCommand.SetIsBrowserConnectionMetered, true);
		assert.equal(await automatic, undefined);
		assert.equal(await update.checkAutomatically('latest'), undefined);
		assert.deepEqual(calls, ['stable']);
		await channel.call('window:2', MeteredConnectionCommand.SetIsBrowserConnectionMetered, false);
		assert.deepEqual(await Promise.all([update.checkAutomatically('latest'), update.checkAutomatically('latest')]), [
			{ status: 'current', version: '1' }, undefined,
		]);
		assert.deepEqual(calls, ['stable', 'latest']);
		changes.fire({ revision: 1, source: '{"network.meteredConnection":"on"}' });
		assert.deepEqual(await update.checkForUpdates('stable'), { status: 'current', version: '1' });
	});

	test('required configuration and network dependencies fail during service creation', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(MeteredConnectionMainService), /configurationResourceService/);
		assert.throws(() => services.createInstance(UpdateMainService, async () => { }, { isPackaged: false }), /meteredConnectionService/);
	});

	test('the application setting validates values and presents its Chinese labels', async () => {
		setNlsMessages('zh-CN', chineseMessages);
		try {
			await import('../../common/meteredConnection.config.contribution.js');
			const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration('network.meteredConnection')!;
			assert.equal(configuration.scope, ConfigurationScope.APPLICATION);
			assert.equal(configuration.defaultValue, 'auto');
			assert.equal(configuration.setting?.title, '按流量计费的网络');
			assert.ok(configuration.setting?.description.includes('手动检查、下载和刷新语言包仍可使用'));
			assert.equal(configuration.setting?.valueType, 'select');
			if (configuration.setting?.valueType === 'select') {
				assert.deepEqual(configuration.setting.options.map(option => option.label), ['自动检测', '始终视为按流量计费', '从不视为按流量计费']);
			}
			assert.deepEqual(['auto', 'on', 'off'].map(value => configuration.parse(value)), ['auto', 'on', 'off']);
			for (const value of ['sometimes', null, false]) assert.throws(() => configuration.parse(value), /Invalid/);
			const setting = new DefaultSettings().all.find(setting => setting.id === 'network.meteredConnection')!;
			const updates = createSettingsLayout([setting]).find(category => category.id === 'general')?.groups.find(group => group.id === 'updates');
			assert.deepEqual(updates?.settings.map(setting => setting.id), ['network.meteredConnection']);
		} finally {
			resetNlsResolver();
		}
	});
});
