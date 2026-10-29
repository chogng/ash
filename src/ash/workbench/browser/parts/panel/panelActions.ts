import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { PanelMaximizedContext, PanelPositionContext, PanelVisibleContext } from '../../../common/contextkeys.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Position, positionToString } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

export class TogglePanelAction extends Action2 {
	public static readonly ID = 'workbench.action.togglePanel';
	public static readonly LABEL = localize2(
		{ bundle: 'ash.actions', key: 'togglePanelVisibility' },
		'Toggle Panel Visibility',
	);
	constructor() {
		super({
			id: TogglePanelAction.ID,
			title: TogglePanelAction.LABEL,
			tooltip: localize2({ bundle: 'ash.actions', key: 'showPanel' }, 'Show Panel'),
			icon: Lxicon.layoutPanelOff1,
			toggled: {
				condition: PanelVisibleContext.isEqualTo(true),
				title: localize2({ bundle: 'ash.actions', key: 'hidePanel' }, 'Hide Panel'),
				tooltip: localize2({ bundle: 'ash.actions', key: 'hidePanel' }, 'Hide Panel'),
				icon: Lxicon.layoutPanel1,
			},
			menu: [
				{ id: MenuId.TitleBar, when: IsAuxiliaryWindowContext.isEqualTo(false), group: 'navigation', order: 9 },
				{ id: MenuId.MenubarViewMenu, group: '2_appearance', order: 11 },
			],
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible('panel')) {
			layout.hidePart('panel');
		} else {
			const panes = accessor.get(IPaneCompositePartService);
			// User-initiated reopening returns input to the retained active view.
			const panel = await panes.openPaneComposite(
				panes.getLastActivePaneCompositeId(ViewContainerLocation.Panel),
				ViewContainerLocation.Panel,
				true,
			);
			if (!panel) layout.showPart('panel');
		}
	}
}

registerAction2(TogglePanelAction);

registerAction2(
	class ClosePanelAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.closePanel',
				title: localize2({ bundle: 'ash.actions', key: 'hidePanel' }, 'Hide Panel'),
				precondition: PanelVisibleContext.isEqualTo(true),
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			accessor.get(IWorkbenchLayoutService).hidePart('panel');
		}
	},
);

registerAction2(
	class FocusPanelAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.focusPanel',
				title: localize2({ bundle: 'ash.actions', key: 'focusPanel' }, 'Focus into Panel'),
				f1: true,
			});
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const panes = accessor.get(IPaneCompositePartService);
			await panes.openPaneComposite(
				panes.getLastActivePaneCompositeId(ViewContainerLocation.Panel),
				ViewContainerLocation.Panel,
				true,
			);
		}
	},
);

registerAction2(
	class ToggleMaximizedPanelAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.toggleMaximizedPanel',
				title: localize2({ bundle: 'ash.actions', key: 'maximizePanel' }, 'Maximize Panel'),
				tooltip: localize2({ bundle: 'ash.actions', key: 'maximizePanel' }, 'Maximize Panel'),
				icon: Lxicon.screenFull,
				toggled: {
					condition: PanelMaximizedContext.isEqualTo(true),
					title: localize2({ bundle: 'ash.actions', key: 'restoreEditorArea' }, 'Restore Editor Area'),
					tooltip: localize2({ bundle: 'ash.actions', key: 'restoreEditorArea' }, 'Restore Editor Area'),
					icon: Lxicon.screenNormal,
				},
				menu: { id: MenuId.PanelTitle, group: 'navigation', order: 40 },
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			accessor.get(IWorkbenchLayoutService).toggleMaximizedPanel();
		}
	},
);

MenusRegistry.appendMenuItem(MenuId.PanelTitle, {
	command: {
		id: 'workbench.action.closePanel',
		title: localize2({ bundle: 'ash.actions', key: 'closePanel' }, 'Close Panel'),
		tooltip: localize2({ bundle: 'ash.actions', key: 'closePanel' }, 'Close Panel'),
		icon: Lxicon.close,
	},
	group: 'navigation',
	order: 50,
});

// All entry points mutate the window layout owner; terminal panes follow its position event.
const panelPositionMenu = MenuId.for('PanelPositionMenu');
MenusRegistry.appendMenuItem(MenuId.ViewContainerTitleContext, {
	submenu: panelPositionMenu,
	title: localize2('positionPanel', 'Panel Position'),
	when: ContextKeyExpr.equals('viewContainerLocation', 'panel'),
	group: '3_layout',
});
for (const [position, suffix, title] of [
	[Position.LEFT, 'Left', localize2('positionPanelLeft', 'Move Panel Left')],
	[Position.RIGHT, 'Right', localize2('positionPanelRight', 'Move Panel Right')],
	[Position.TOP, 'Top', localize2('positionPanelTop', 'Move Panel to Top')],
	[Position.BOTTOM, 'Bottom', localize2('positionPanelBottom', 'Move Panel to Bottom')],
] as const) {
	registerAction2(
		class extends Action2 {
			constructor() {
				super({
					id: `workbench.action.positionPanel${suffix}`,
					title,
					f1: true,
					toggled: PanelPositionContext.isEqualTo(positionToString(position)),
					menu: { id: panelPositionMenu, group: 'position', order: position },
				});
			}
			override run(accessor: ServicesAccessor): void {
				accessor.get(IWorkbenchLayoutService).setPanelPosition(position);
			}
		},
	);
}
