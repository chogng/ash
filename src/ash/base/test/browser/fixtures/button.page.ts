import { ButtonWithDropdown } from '../../../browser/ui/button/button.js';
import { ToolBar } from '../../../browser/ui/toolbar/toolbar.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { Disposable, DisposableStore } from '../../../common/lifecycle.js';
import { Event } from '../../../common/event.js';
import { Lxicon } from '../../../common/lxicons.js';
import { localize, setNlsMessages } from '../../../../nls.js';
import chinese from '../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import chineseSessions from '../../../../../../extensions/language-pack-zh-cn/translations/sessions.json' with { type: 'json' };
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../platform/actions/common/menuService.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../../../workbench/services/commands/common/commandService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';
import { ContextMenuHandler } from '../../../../platform/contextview/browser/contextMenuHandler.js';
import { BrowserContextViewService } from '../../../../platform/contextview/browser/contextViewService.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { TestNotificationService } from '../../../../workbench/services/notification/test/common/testNotificationService.js';
import '../../../browser/ui/styles.css';

declare global {
	interface Window {
		ashButtonIntegration: {
			theme(id: string): void;
			disable(): void;
			refreshToolbarDropdown(): void;
		};
	}
}

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', { ...chinese, ...chineseSessions, ash: { ...chinese.ash, ...chineseSessions.ash } });
}
const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const keybindings: IKeybindingService = {
	inChordMode: false, onDidUpdateKeybindings: Event.None,
	getKeybindings: () => [], enableKeybindingHoldMode: () => undefined, registerSchemaContribution: () => Disposable.None,
	resolveKeybinding() { throw new Error('No keybinding in this fixture'); },
	resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
};
const menus = resources.add(new ContextMenuHandler(resources.add(new BrowserContextViewService(document.body)), keybindings, resources.add(new TestNotificationService())));
const button = resources.add(new ButtonWithDropdown(document.querySelector('#buttons')!, {
	...defaultButtonStyles,
	label: 'Save and Apply', icon: Lxicon.check, presentation: 'primary', contentAlignment: 'labelCentered',
	contextMenuProvider: menus, addPrimaryActionToDropdown: false,
	actions: [{ id: 'saveAs', label: 'Save as…', tooltip: '', enabled: true, run: () => { document.querySelector('output')!.textContent = 'saveAs'; } }],
	onClick: () => { document.querySelector('output')!.textContent = 'primary'; },
}));
resources.add(new ButtonWithDropdown(document.querySelector('#small-buttons')!, {
	...defaultButtonStyles,
	label: 'Compact action', size: 'small', presentation: 'primary',
	contextMenuProvider: menus, addPrimaryActionToDropdown: false,
	actions: [{ id: 'compact.other', label: 'Other compact action', tooltip: '', enabled: true, run: () => { } }],
}));
let primaryItem: DropdownWithPrimaryActionViewItem;
const themeMenu = { id: 'theme.actions', label: 'Theme actions', tooltip: '', enabled: true, run: () => { } };
const themeActions = [{ id: 'theme.save', label: 'Save theme', tooltip: '', enabled: true, run: () => { } }];
const primaryToolbar = resources.add(new ToolBar(document.querySelector('#primary-toolbar')!, {
	contextMenuProvider: menus,
	actionViewItemProvider: action => primaryItem = new DropdownWithPrimaryActionViewItem(action, themeMenu, themeActions, menus, { buttonPresentation: 'primary' }),
}));
primaryToolbar.setActions([{ id: 'theme.apply', label: 'Apply theme', tooltip: '', icon: Lxicon.check, enabled: true, run: () => { } }]);
const quietToolbar = resources.add(new ToolBar(document.querySelector('#quiet-toolbar')!, {
	contextMenuProvider: menus,
	actionViewItemProvider: action => action.id === 'run' ? new DropdownWithPrimaryActionViewItem(action,
		{ id: 'run.actions', label: 'Run actions', tooltip: '', enabled: true, run: () => { } }, [], menus) : undefined,
}));
quietToolbar.setActions([
	{ id: 'run', label: 'Run', tooltip: '', icon: Lxicon.play, enabled: true, run: () => { } },
	{ id: 'pin', label: 'Pin', tooltip: '', icon: Lxicon.pin, enabled: true, run: () => { } },
]);
const services = resources.add(new InstantiationService());
const keys = resources.add(new ContextKeyService());
const commands = resources.add(new CommandService(services));
const menuService = new MenuService(commands, keys);
const titleMenu = MenuId.for('test.button.default.title');
const newMenu = MenuId.for('test.button.default.new');
const newLabel = localize({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat');
resources.add(CommandsRegistry.register('test.button.default.new', () => { document.querySelector('output')!.textContent = 'new'; }));
resources.add(CommandsRegistry.register('test.button.default.other', () => { document.querySelector('output')!.textContent = 'other'; }));
resources.add(MenusRegistry.appendMenuItem(titleMenu, {
	title: newLabel, submenu: newMenu, isSplitButton: true, group: 'navigation',
}));
resources.add(MenusRegistry.appendMenuItem(newMenu, {
	command: { id: 'test.button.default.new', title: newLabel, icon: Lxicon.add }, group: '1_new',
}));
resources.add(MenusRegistry.appendMenuItem(newMenu, {
	command: { id: 'test.button.default.other', title: 'Other action' }, group: '2_other',
}));
resources.add(new MenuWorkbenchToolBar(document.querySelector('#default-toolbar')!, menuService, menus, titleMenu));
window.ashButtonIntegration = {
	theme: id => theme.setColorTheme(themes[id as keyof typeof themes]),
	disable: () => { button.enabled = false; },
	refreshToolbarDropdown: () => primaryItem.update(themeMenu, themeActions),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
