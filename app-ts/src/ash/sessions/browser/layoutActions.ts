import { Lxicon } from '../../base/common/lxicons.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { localizedString } from '../../platform/action/common/action.js';
import { MenusRegistry, MenuId, Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { RawContextKey, type IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { SideBarVisibleContext, PanelVisibleContext } from '../../workbench/common/contextkeys.js';
import { Keybinding, logicalKey } from '../../base/common/keybindings.js';
import type { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import type { IAgentWorkbenchLayoutService } from './workbench.js';
import { Menus } from './menus.js';

const canNavigateBack = new RawContextKey<boolean>('sessions.canNavigateBack', false);
const canNavigateForward = new RawContextKey<boolean>('sessions.canNavigateForward', false);
const codePage = new RawContextKey<boolean>('sessions.codePage', false);

/** Registers window-local commands and derives their menu state from the layout and session owners. */
export function registerLayoutActions(layout: IAgentWorkbenchLayoutService, sessions: ISessionsService, contextKeys: IContextKeyService): IDisposable {
	const disposables = new DisposableStore();
	const sidebarVisible = SideBarVisibleContext.bindTo(contextKeys);
	const backEnabled = canNavigateBack.bindTo(contextKeys);
	const forwardEnabled = canNavigateForward.bindTo(contextKeys);
	const codeAvailable = codePage.bindTo(contextKeys);
	const panelVisible = PanelVisibleContext.bindTo(contextKeys);
	const updateContext = (): void => contextKeys.bufferChangeEvents(() => {
		sidebarVisible.set(layout.isPartVisible('sidebar'));
		backEnabled.set(sessions.canNavigateBack);
		forwardEnabled.set(sessions.canNavigateForward);
		codeAvailable.set(sessions.page.get() === 'code' && layout.isPartAvailable('panel'));
		panelVisible.set(layout.isPartVisible('panel'));
	});
	updateContext();
	disposables.add(layout.onDidChangePartVisibility(updateContext));
	disposables.add(sessions.onDidChange(updateContext));
	disposables.add(layout.onDidLayoutMainContainer(updateContext));
	disposables.add(toDisposable(() => contextKeys.bufferChangeEvents(() => {
		sidebarVisible.reset();
		backEnabled.reset();
		forwardEnabled.reset();
		codeAvailable.reset();
		panelVisible.reset();
	})));
	disposables.add(CommandsRegistry.register('ash.sessions.toggleSidebar', () => {
		if (layout.isPartVisible('sidebar')) {
			layout.hidePart('sidebar');
		} else {
			layout.showPart('sidebar');
		}
	}));
	disposables.add(CommandsRegistry.register('ash.sessions.back', () => sessions.navigateBack()));
	disposables.add(CommandsRegistry.register('ash.sessions.forward', () => sessions.navigateForward()));
	disposables.add(registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'ash.sessions.togglePanel',
				title: localizedString('ash', 'sessions.layout.togglePanel', 'Toggle Code panel'),
				icon: Lxicon.layoutPanel1,
				f1: true,
				precondition: codePage.isEqualTo(true),
				keybinding: { primary: new Keybinding([logicalKey('`', { ctrlKey: true })]), when: codePage.isEqualTo(true) },
				menu: [
					{ id: Menus.TitleBarLeftLayout, group: 'navigation', order: 3, when: codePage.isEqualTo(true) },
					{ id: MenuId.PanelTitle, group: 'navigation', order: 100, when: codePage.isEqualTo(true) },
				],
				toggled: PanelVisibleContext.isEqualTo(true),
			});
		}
		override run(): void {
			if (sessions.page.get() !== 'code' || !layout.isPartAvailable('panel')) {
				return;
			}
			if (layout.isPartVisible('panel')) {
				layout.hidePart('panel');
			} else {
				layout.showPart('panel');
			}
		}
	}));
	disposables.add(MenusRegistry.appendMenuItems([
		{
			id: Menus.TitleBarLeftLayout,
			item: {
				command: {
					id: 'ash.sessions.toggleSidebar',
					title: localizedString('ash', 'sessions.navigation.showSidebar', 'Show sidebar'),
					icon: Lxicon.layoutSidebarLeftOff2,
					toggled: {
						condition: SideBarVisibleContext.isEqualTo(true),
						title: localizedString('ash', 'sessions.navigation.hideSidebar', 'Hide sidebar'),
						tooltip: localizedString('ash', 'sessions.navigation.hideSidebar', 'Hide sidebar'),
						icon: Lxicon.layoutSidebarLeft2,
					},
				},
				group: 'navigation',
				order: 0,
			},
		},
		{
			id: Menus.TitleBarLeftLayout,
			item: {
				command: {
					id: 'ash.sessions.back',
					title: localizedString('ash', 'sessions.navigation.back', 'Back'),
					icon: Lxicon.arrowLeft,
					precondition: canNavigateBack.isEqualTo(true),
				},
				group: 'navigation',
				order: 1,
			},
		},
		{
			id: Menus.TitleBarLeftLayout,
			item: {
				command: {
					id: 'ash.sessions.forward',
					title: localizedString('ash', 'sessions.navigation.forward', 'Forward'),
					icon: Lxicon.arrowRight,
					precondition: canNavigateForward.isEqualTo(true),
				},
				group: 'navigation',
				order: 2,
			},
		},
	]));
	return disposables;
}
