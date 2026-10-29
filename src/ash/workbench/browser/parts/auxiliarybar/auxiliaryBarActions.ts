import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	AuxiliaryBarMaximizedContext,
	AuxiliaryBarVisibleContext,
	IsAuxiliaryWindowContext,
} from '../../../common/contextkeys.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';

export class ToggleAuxiliaryBarAction extends Action2 {
	public static readonly ID = 'workbench.action.toggleAuxiliaryBar';
	constructor() {
		super({
			id: ToggleAuxiliaryBarAction.ID,
			title: localize2({ bundle: 'ash.actions', key: 'showSecondarySidebar' }, 'Show Secondary Side Bar'),
			tooltip: localize2({ bundle: 'ash.actions', key: 'showSecondarySidebar' }, 'Show Secondary Side Bar'),
			icon: Lxicon.layoutSidebarRightOff1,
			toggled: {
				condition: AuxiliaryBarVisibleContext.isEqualTo(true),
				title: localize2({ bundle: 'ash.actions', key: 'hideSecondarySidebar' }, 'Hide Secondary Side Bar'),
				tooltip: localize2({ bundle: 'ash.actions', key: 'hideSecondarySidebar' }, 'Hide Secondary Side Bar'),
				icon: Lxicon.layoutSidebarRight1,
			},
			menu: [
				{
					id: MenuId.TitleBar,
					when: IsAuxiliaryWindowContext.isEqualTo(false),
					group: 'navigation',
					order: 10,
				},
				{ id: MenuId.MenubarViewMenu, group: '2_appearance', order: 10 },
			],
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible('auxiliarybar')) {
			hideAuxiliaryBar(accessor);
		} else {
			layout.showPart('auxiliarybar');
		}
	}
}

registerAction2(ToggleAuxiliaryBarAction);

registerAction2(
	class CloseAuxiliaryBarAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.closeAuxiliaryBar',
				title: localize2({ bundle: 'ash.actions', key: 'hideSecondarySidebar' }, 'Hide Secondary Side Bar'),
				icon: Lxicon.close,
				precondition: AuxiliaryBarVisibleContext.isEqualTo(true),
				menu: { id: MenuId.AuxiliaryBarTitle, group: 'navigation', order: 50 },
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			hideAuxiliaryBar(accessor);
		}
	},
);

registerAction2(
	class ToggleMaximizedAuxiliaryBar extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.toggleMaximizedAuxiliaryBar',
				title: localize2({ bundle: 'ash.actions', key: 'maximizeAuxiliaryBar' }, 'Maximize Secondary Side Bar'),
				tooltip: localize2(
					{ bundle: 'ash.actions', key: 'maximizeAuxiliaryBar' },
					'Maximize Secondary Side Bar',
				),
				icon: Lxicon.screenFull,
				toggled: {
					condition: AuxiliaryBarMaximizedContext.isEqualTo(true),
					title: localize2(
						{ bundle: 'ash.actions', key: 'restoreAuxiliaryBar' },
						'Restore Secondary Side Bar',
					),
					tooltip: localize2(
						{ bundle: 'ash.actions', key: 'restoreAuxiliaryBar' },
						'Restore Secondary Side Bar',
					),
					icon: Lxicon.screenNormal,
				},
				menu: { id: MenuId.AuxiliaryBarTitle, group: 'navigation', order: 40 },
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			const layout = accessor.get(IWorkbenchLayoutService);
			layout.toggleMaximizedAuxiliaryBar();
			// Commands can originate in the editor or Command Palette; keep input in the visible Part.
			if (!layout.hasFocus('auxiliarybar')) {
				accessor
					.get(IPaneCompositePartService)
					.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)
					?.focus();
			}
		}
	},
);

/** Closing a retained view must move keyboard focus out of the newly hidden Part. */
function hideAuxiliaryBar(accessor: ServicesAccessor): void {
	const layout = accessor.get(IWorkbenchLayoutService);
	const hadFocus = layout.hasFocus('auxiliarybar');
	layout.hidePart('auxiliarybar');
	if (!hadFocus) return;
	if (layout.isPartVisible('editor')) {
		accessor.get(IEditorGroupsService).activeGroup.focus();
	} else {
		accessor.get(IPaneCompositePartService).getActivePaneComposite(ViewContainerLocation.Panel)?.focus();
	}
}
