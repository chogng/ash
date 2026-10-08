import { localize2 } from '../../../../nls.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { AuxiliaryBarVisibleContext, SideBarVisibleContext } from "../../../common/contextkeys.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

export const ToggleSideBarCommandId = "workbench.action.toggleSideBar";
export const ToggleAuxiliaryBarCommandId = "workbench.action.toggleAuxiliaryBar";

registerAction2(class ToggleSideBarAction extends Action2 {
	constructor() {
		super({
			id: ToggleSideBarCommandId,
			title: localize2({ bundle: "ash.actions", key: "showPrimarySidebar" }, "Show Primary Side Bar"),
			tooltip: localize2({ bundle: "ash.actions", key: "showPrimarySidebar" }, "Show Primary Side Bar"),
			icon: Lxicon.layoutSidebarLeftOff1,
			toggled: {
				condition: SideBarVisibleContext.isEqualTo(true),
				title: localize2({ bundle: "ash.actions", key: "hidePrimarySidebar" }, "Hide Primary Side Bar"),
				tooltip: localize2({ bundle: "ash.actions", key: "hidePrimarySidebar" }, "Hide Primary Side Bar"),
				icon: Lxicon.layoutSidebarLeft1,
			},
			menu: [
				{
					id: MenuId.TitleBarLeft,
					group: "navigation",
					order: 10,
				},
				{
					id: MenuId.MenubarViewMenu,
					group: "2_appearance",
					order: 9,
				},
				{
					id: MenuId.ViewContainerTitleContext,
					when: ContextKeyExpr.and(SideBarVisibleContext.isEqualTo(true), ContextKeyExpr.equals('viewContainerLocation', 'sidebar')),
					group: '2_visibility',
					order: 1,
				},
			],
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible("sidebar")) {
			layout.hidePart("sidebar");
		} else {
			layout.showPart("sidebar");
		}
	}
});

registerAction2(class ToggleAuxiliaryBarAction extends Action2 {
	constructor() {
		super({
			id: ToggleAuxiliaryBarCommandId,
			title: localize2({ bundle: "ash.actions", key: "showSecondarySidebar" }, "Show Secondary Side Bar"),
			tooltip: localize2({ bundle: "ash.actions", key: "showSecondarySidebar" }, "Show Secondary Side Bar"),
			icon: Lxicon.layoutSidebarRightOff1,
			toggled: {
				condition: AuxiliaryBarVisibleContext.isEqualTo(true),
				title: localize2({ bundle: "ash.actions", key: "hideSecondarySidebar" }, "Hide Secondary Side Bar"),
				tooltip: localize2({ bundle: "ash.actions", key: "hideSecondarySidebar" }, "Hide Secondary Side Bar"),
				icon: Lxicon.layoutSidebarRight1,
			},
			menu: [
				{
					id: MenuId.TitleBar,
					group: "navigation",
					order: 10,
				},
				{
					id: MenuId.MenubarViewMenu,
					group: "2_appearance",
					order: 10,
				},
			],
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible("auxiliarybar")) {
			layout.hidePart("auxiliarybar");
		} else {
			layout.showPart("auxiliarybar");
		}
	}
});
