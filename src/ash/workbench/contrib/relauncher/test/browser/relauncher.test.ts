import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ConfigurationTarget, type IConfigurationChangeEvent, type IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IConfirmationDialogOptions, IConfirmationDialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { parseMenuStyle, parseTitleBarStyle, resolveContextMenuStyle, type TitleBarStyleConfiguration } from '../../../../../platform/window/common/window.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IHostService } from '../../../../services/host/browser/host.js';
import { SettingsChangeRelauncher } from '../../browser/relauncher.contribution.js';

function fixture(confirm: () => Promise<IConfirmationDialogResult> = async () => ({ confirmed: true }), titleBarStyle: TitleBarStyleConfiguration = 'custom', startup?: { titleBarStyle?: TitleBarStyleConfiguration; menuStyle?: 'custom' | 'system'; titleBarStyleRead?: Promise<TitleBarStyleConfiguration>; }) {
	const store = new DisposableStore();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'window.titleBarStyle', defaultValue: titleBarStyle, parse: parseTitleBarStyle });
	registry.registerConfiguration({ key: 'window.menuStyle', defaultValue: 'inherit', parse: parseMenuStyle });
	const configuration = store.add(new InMemoryConfigurationService(registry));
	const changes = store.add(new Emitter<IConfigurationChangeEvent>());
	let source = ConfigurationTarget.USER;
	store.add(configuration.onDidChangeConfiguration(event => changes.fire({ ...event, source })));
	const observedConfiguration = { getValue: configuration.getValue.bind(configuration), onDidChangeConfiguration: changes.event } as IConfigurationService;
	const prompts: IConfirmationDialogOptions[] = [];
	let focused = true;
	let restarts = 0;
	const host = { get hasFocus() { return focused; }, restart: async () => { restarts++; } } as IHostService;
	const dialogs = { confirm: (options: IConfirmationDialogOptions) => { prompts.push(options); return confirm(); } } as IDialogService;
	const windowHost = { getTitleBarStyle: () => startup?.titleBarStyleRead ?? Promise.resolve(startup?.titleBarStyle ?? titleBarStyle) } as INativeHostApi;
	const contextMenus = { contextMenuStyle: startup?.menuStyle ?? resolveContextMenuStyle('inherit', titleBarStyle, isMacintosh ? 'macos' : 'desktop') } as IContextMenuService;
	const relauncher = store.add(new SettingsChangeRelauncher(observedConfiguration, dialogs, host, windowHost, contextMenus));
	return {
		configuration, prompts, relauncher,
		get restarts() { return restarts; },
		set focused(value: boolean) { focused = value; },
		set source(value: ConfigurationTarget) { source = value; },
		[Symbol.dispose]: () => store.dispose(),
	};
}

suite('SettingsChangeRelauncher', () => {
	test('initialization is quiet; changing title bar restarts only after confirmation', async () => {
		using f = fixture();
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, 0);
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		assert.equal(f.prompts.length, 1);
		assert.equal(f.restarts, 1);
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		assert.equal(f.prompts.length, 1);
	});

	test('declining confirmation keeps the app running', async () => {
		using f = fixture(async () => ({ confirmed: false }));
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		assert.equal(f.prompts.length, 1);
		assert.equal(f.restarts, 0);
	});

	test('default changes and background windows do not prompt', async () => {
		using f = fixture();
		await f.relauncher.onWorkspaceRestored();
		f.source = ConfigurationTarget.DEFAULT;
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		f.source = ConfigurationTarget.USER;
		f.focused = false;
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		assert.equal(f.prompts.length, 0);
		assert.equal(f.restarts, 0);
	});

	test('equivalent menu preferences do not prompt', async () => {
		using f = fixture();
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.menuStyle', 'system');
		assert.equal(f.prompts.length, 0);
		assert.equal(f.restarts, 0);
	});

	test('menu implementation changes prompt only outside macOS; restoring it is quiet', async () => {
		using f = fixture(async () => ({ confirmed: false }), 'system');
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.menuStyle', 'custom');
		assert.equal(f.prompts.length, isMacintosh ? 0 : 1);
		await f.configuration.updateValue('window.menuStyle', 'inherit');
		assert.equal(f.prompts.length, isMacintosh ? 0 : 1);
		assert.equal(f.restarts, 0);
	});

	test('restoring the startup title bar after deferring restart does not prompt again', async () => {
		using f = fixture(async () => ({ confirmed: false }));
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		assert.equal(f.prompts.length, 1);
		assert.equal(f.restarts, 0);
	});

	test('confirmation cannot restart after the title bar is restored', async () => {
		let finish!: (result: IConfirmationDialogResult) => void;
		using f = fixture(() => new Promise(resolve => { finish = resolve; }));
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		finish({ confirmed: true });
		await Promise.resolve();
		assert.equal(f.prompts.length, 1);
		assert.equal(f.restarts, 0);
	});

	test('confirmation restarts if another changed setting still requires it', async () => {
		let finish!: (result: IConfirmationDialogResult) => void;
		using f = fixture(() => new Promise(resolve => { finish = resolve; }), 'system');
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		await f.configuration.updateValue('window.menuStyle', 'custom');
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		finish({ confirmed: true });
		await Promise.resolve();
		assert.equal(f.prompts.length, 1);
		assert.equal(f.restarts, isMacintosh ? 0 : 1);
	});

	test('settings changed before restoration do not replace the actual window and menu baseline', async () => {
		using f = fixture(async () => ({ confirmed: false }), 'system', { titleBarStyle: 'custom', menuStyle: 'custom' });
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, 1, 'the saved style has not taken effect in this window');
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		assert.equal(f.prompts.length, 1, 'restoring the real window style does not need another prompt');
		assert.equal(f.restarts, 0);
	});

	test('menu changes before restoration compare against the selected implementation', async () => {
		using f = fixture(async () => ({ confirmed: false }), 'system', { titleBarStyle: 'system', menuStyle: 'custom' });
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, isMacintosh ? 0 : 1);
		await f.configuration.updateValue('window.menuStyle', 'custom');
		assert.equal(f.prompts.length, isMacintosh ? 0 : 1);
		assert.equal(f.restarts, 0);
	});

	test('configuration changes while Main reads the frame are checked when it answers', async () => {
		let finish!: (style: TitleBarStyleConfiguration) => void;
		const read = new Promise<TitleBarStyleConfiguration>(resolve => { finish = resolve; });
		using f = fixture(async () => ({ confirmed: false }), 'custom', { titleBarStyleRead: read });
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		assert.equal(f.prompts.length, 0);
		finish('custom');
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, 1);
		await f.configuration.updateValue('window.titleBarStyle', 'custom');
		assert.equal(f.prompts.length, 1);
	});

	test('default changes while Main reads the frame do not prompt', async () => {
		let finish!: (style: TitleBarStyleConfiguration) => void;
		const read = new Promise<TitleBarStyleConfiguration>(resolve => { finish = resolve; });
		using f = fixture(undefined, 'custom', { titleBarStyleRead: read });
		f.source = ConfigurationTarget.DEFAULT;
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		finish('custom');
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, 0);
		assert.equal(f.restarts, 0);
	});

	test('disposing while Main reads the frame cannot prompt later', async () => {
		let finish!: (style: TitleBarStyleConfiguration) => void;
		const read = new Promise<TitleBarStyleConfiguration>(resolve => { finish = resolve; });
		using f = fixture(undefined, 'system', { titleBarStyleRead: read });
		f.relauncher.dispose();
		finish('custom');
		await f.relauncher.onWorkspaceRestored();
		assert.equal(f.prompts.length, 0);
		assert.equal(f.restarts, 0);
	});

	test('restart confirmation uses the Chinese language pack', async () => {
		const bundles = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'));
		setNlsMessages('zh-CN', bundles);
		try {
			using f = fixture();
			await f.relauncher.onWorkspaceRestored();
			await f.configuration.updateValue('window.titleBarStyle', 'system');
			assert.deepEqual(f.prompts, [{
				message: '某项设置已更改，需要重启才能生效。',
				detail: '重启 Ash 以应用新的窗口外观。',
				primaryButton: '立即重启',
				cancelButton: '稍后',
			}]);
		} finally {
			resetNlsResolver();
		}
	});

	test('pending confirmation is not duplicated and cannot restart a disposed window', async () => {
		let finish!: (result: IConfirmationDialogResult) => void;
		using f = fixture(() => new Promise(resolve => { finish = resolve; }));
		await f.relauncher.onWorkspaceRestored();
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		await f.configuration.updateValue('window.menuStyle', 'system');
		assert.equal(f.prompts.length, 1);
		f.relauncher.dispose();
		finish({ confirmed: true });
		await Promise.resolve();
		assert.equal(f.restarts, 0);
		await f.configuration.updateValue('window.titleBarStyle', 'system');
		assert.equal(f.prompts.length, 1);
	});
});
