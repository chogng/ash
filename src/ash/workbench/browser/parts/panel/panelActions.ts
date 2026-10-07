import { localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { PanelMaximizedContext, PanelVisibleContext } from '../../../common/contextkeys.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

export class TogglePanelAction extends Action2 {
	public static readonly ID = 'workbench.action.togglePanel';
	public static readonly LABEL = localize2({ bundle: 'ash.actions', key: 'togglePanelVisibility' }, 'Toggle Panel Visibility');
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
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 9,
				},
				{
					id: MenuId.MenubarViewMenu,
					group: '2_appearance',
					order: 11,
				},
			],
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible('panel')) {
			layout.hidePart('panel');
		} else {
			layout.showPart('panel');
		}
	}
}

registerAction2(TogglePanelAction);

registerAction2(class ClosePanelAction extends Action2 {
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
});

registerAction2(class FocusPanelAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.focusPanel',
			title: localize2({ bundle: 'ash.actions', key: 'focusPanel' }, 'Focus into Panel'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const panes = accessor.get(IPaneCompositePartService);
		await panes.openPaneComposite(panes.getLastActivePaneCompositeId(ViewContainerLocation.Panel), ViewContainerLocation.Panel, true);
	}
});

registerAction2(class ToggleMaximizedPanelAction extends Action2 {
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
			menu: {
				id: MenuId.PanelTitle,
				group: 'navigation',
				order: 40,
			},
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchLayoutService).toggleMaximizedPanel();
	}
});

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
