import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../base/common/actions.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { localize, resetNlsResolver, setNlsMessages } from '../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { SessionsAccountMenu } from '../../contrib/accounts/browser/sessionsAccountMenu.js';
import type { SessionsPreferences } from '../../contrib/preferences/browser/sessionsPreferences.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../../common/sessionCommands.js';

for (const locale of ['en', 'zh-CN']) test(`Sessions account menu opens settings, account management, IDE and shortcuts (${locale})`, async () => {
	setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
	const browser = new JSDOM('<!doctype html><button></button>');
	try {
		using resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		const commands = resources.add(services.createInstance(CommandService));
		services.registerInstance(ICommandService, commands);
		const invoked: string[] = [];
		for (const id of ['workbench.action.manageAccounts', OPEN_ASH_WINDOW_COMMAND_ID, 'workbench.action.openKeyboardShortcuts']) {
			resources.add(CommandsRegistry.register(id, () => { invoked.push(id); }));
		}
		const anchor = browser.window.document.querySelector('button')!;
		let actions: readonly IAction[] = [];
		let hide: (() => void) | undefined;
		services.registerInstance(IContextMenuService, {
			contextMenuStyle: 'custom',
			onDidShowContextMenu: Event.None,
			onDidHideContextMenu: Event.None,
			showContextMenu(delegate) {
				assert.equal(delegate.getAnchor(), anchor);
				assert.equal(delegate.getMenuClassName?.(), 'ash-sessions-account-menu');
				actions = delegate.getActions?.() ?? [];
				hide = () => delegate.onHide?.(false);
			},
			hideContextMenu() { },
		});
		const preferences = { open: async () => { invoked.push('settings'); } } as SessionsPreferences;
		const menu = services.createInstance(SessionsAccountMenu, preferences);
		menu.show(anchor);
		assert.deepEqual(actions.map(action => action.label), locale === 'zh-CN'
			? ['设置', '账号', '打开 IDE', '快捷键']
			: ['Settings', 'Account', 'Open IDE', 'Keyboard Shortcuts']);
		assert.ok(actions.every(action => action.enabled));
		assert.match(localize('sessions.activity.help', ''), locale === 'zh-CN' ? /保留 Agent 窗口及其中未发送的草稿/u : /keeping the Agents window and its unsent drafts open/u);
		assert.match(localize('sessions.activity.help', ''), locale === 'zh-CN' ? /关闭最后一个文档会收起编辑器，文件树保持可见/u : /closing the last document hides it and keeps Files visible/u);
		assert.equal(anchor.getAttribute('aria-expanded'), 'true');
		for (const action of actions) { await action.run(); }
		assert.deepEqual(invoked, ['settings', 'workbench.action.manageAccounts', OPEN_ASH_WINDOW_COMMAND_ID, 'workbench.action.openKeyboardShortcuts']);
		hide?.();
		assert.equal(anchor.getAttribute('aria-expanded'), 'false');
	} finally {
		browser.window.close();
		resetNlsResolver();
	}
});
