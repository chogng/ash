import { ViewContainerLocation } from '../../workbench/common/views.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../nls.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { MenusRegistry, MenuId, Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { RawContextKey, type IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { SideBarVisibleContext, PanelVisibleContext } from '../../workbench/common/contextkeys.js';
import { Keybinding, logicalKey } from '../../base/common/keybindings.js';
import type { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import type { IAgentWorkbenchLayoutService } from './workbench.js';
import { Menus } from './menus.js';
import { CanGoBackContext, CanGoForwardContext } from '../common/contextkeys.js';

const sessionTools = new RawContextKey<boolean>('sessions.toolsAvailable', false);

/** Registers window-local commands and derives their menu state from the layout and session owners. */
export function registerLayoutActions(layout: IAgentWorkbenchLayoutService, sessions: ISessionsService, contextKeys: IContextKeyService): IDisposable {
	const disposables = new DisposableStore();
	const sidebarVisible = SideBarVisibleContext.bindTo(contextKeys);
	const backEnabled = CanGoBackContext.bindTo(contextKeys);
	const forwardEnabled = CanGoForwardContext.bindTo(contextKeys);
	const codeAvailable = sessionTools.bindTo(contextKeys);
	const panelVisible = PanelVisibleContext.bindTo(contextKeys);
	const updateContext = (): void => contextKeys.bufferChangeEvents(() => {
		sidebarVisible.set(layout.isPartVisible('sidebar'));
		backEnabled.set(sessions.canNavigateBack);
		forwardEnabled.set(sessions.canNavigateForward);
		codeAvailable.set(layout.isPartVisible('sessions') && layout.isPartAvailable('panel'));
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
				title: localize2({ bundle: 'ash', key: 'sessions.layout.togglePanel' }, 'Toggle Code panel'),
				icon: Lxicon.layoutPanel1,
				f1: true,
				precondition: sessionTools.isEqualTo(true),
				keybinding: { primary: new Keybinding([logicalKey('`', { ctrlKey: true })]), when: sessionTools.isEqualTo(true) },
				menu: [
					{ id: Menus.TitleBarLeftLayout, group: 'navigation', order: 3, when: sessionTools.isEqualTo(true) },
					{ id: MenuId.MenubarViewMenu, group: '2_code_layout', order: 3, when: sessionTools.isEqualTo(true) },
					{ id: MenuId.PanelTitle, group: 'navigation', order: 100, when: sessionTools.isEqualTo(true) },
				],
				toggled: PanelVisibleContext.isEqualTo(true),
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			if (!layout.isPartVisible('sessions') || !layout.isPartAvailable('panel')) {
				return;
			}
			if (layout.isPartVisible('panel')) {
				accessor.get(IPaneCompositePartService).hideActivePaneComposite(ViewContainerLocation.Panel);
			} else {
				await accessor.get(IPaneCompositePartService).openPaneComposite(undefined, ViewContainerLocation.Panel);
			}
		}
	}));
	disposables.add(MenusRegistry.appendMenuItems([
		{
			id: Menus.TitleBarLeftLayout,
			item: {
				command: {
					id: 'ash.sessions.toggleSidebar',
					title: localize2({ bundle: 'ash', key: 'sessions.navigation.showSidebar' }, 'Show sidebar'),
					icon: Lxicon.layoutSidebarLeftOff2,
					toggled: {
						condition: SideBarVisibleContext.isEqualTo(true),
						title: localize2({ bundle: 'ash', key: 'sessions.navigation.hideSidebar' }, 'Hide sidebar'),
						tooltip: localize2({ bundle: 'ash', key: 'sessions.navigation.hideSidebar' }, 'Hide sidebar'),
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
					title: localize2({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back'),
					icon: Lxicon.arrowLeft,
					precondition: CanGoBackContext.isEqualTo(true),
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
					title: localize2({ bundle: 'ash', key: 'sessions.navigation.forward' }, 'Forward'),
					icon: Lxicon.arrowRight,
					precondition: CanGoForwardContext.isEqualTo(true),
				},
				group: 'navigation',
				order: 2,
			},
		},
	]));
	return disposables;
}
