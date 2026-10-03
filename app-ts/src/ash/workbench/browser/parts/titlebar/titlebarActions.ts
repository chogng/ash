import { localize2 } from '../../../../nls.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { Action2, MenuId, MenusRegistry, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { AuxiliaryBarVisibleContext, PanelMaximizedContext, PanelVisibleContext, SideBarVisibleContext } from "../../../common/contextkeys.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";

export const ToggleSideBarCommandId = "workbench.action.toggleSideBar";
export const ToggleAuxiliaryBarCommandId = "workbench.action.toggleAuxiliaryBar";
export const TogglePanelCommandId = "workbench.action.togglePanel";
export const ToggleMaximizedPanelCommandId = "workbench.action.toggleMaximizedPanel";

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
					id: MenuId.SidebarTitle,
					when: SideBarVisibleContext.isEqualTo(true),
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

registerAction2(class TogglePanelAction extends Action2 {
	constructor() {
		super({
			id: TogglePanelCommandId,
			title: localize2({ bundle: "ash.actions", key: "showPanel" }, "Show Panel"),
			tooltip: localize2({ bundle: "ash.actions", key: "showPanel" }, "Show Panel"),
			icon: Lxicon.layoutPanelOff1,
			toggled: {
				condition: PanelVisibleContext.isEqualTo(true),
				title: localize2({ bundle: "ash.actions", key: "hidePanel" }, "Hide Panel"),
				tooltip: localize2({ bundle: "ash.actions", key: "hidePanel" }, "Hide Panel"),
				icon: Lxicon.layoutPanel1,
			},
			menu: [
				{
					id: MenuId.TitleBar,
					group: "navigation",
					order: 9,
				},
				{
					id: MenuId.MenubarViewMenu,
					group: "2_appearance",
					order: 11,
				},
			],
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible("panel")) {
			layout.hidePart("panel");
		} else {
			layout.showPart("panel");
		}
	}
});

registerAction2(class ToggleMaximizedPanelAction extends Action2 {
	constructor() {
		super({
			id: ToggleMaximizedPanelCommandId,
			title: localize2({ bundle: "ash.actions", key: "maximizePanel" }, "Maximize Panel"),
			tooltip: localize2({ bundle: "ash.actions", key: "maximizePanel" }, "Maximize Panel"),
			icon: Lxicon.screenFull,
			toggled: {
				condition: PanelMaximizedContext.isEqualTo(true),
				title: localize2({ bundle: "ash.actions", key: "restoreEditorArea" }, "Restore Editor Area"),
				tooltip: localize2({ bundle: "ash.actions", key: "restoreEditorArea" }, "Restore Editor Area"),
				icon: Lxicon.screenNormal,
			},
			menu: {
				id: MenuId.PanelTitle,
				group: "navigation",
				order: 40,
			},
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchLayoutService).toggleMaximizedPanel();
	}
});

MenusRegistry.appendMenuItem(MenuId.PanelTitle, {
	command: {
		id: TogglePanelCommandId,
		title: localize2({ bundle: "ash.actions", key: "closePanel" }, "Close Panel"),
		tooltip: localize2({ bundle: "ash.actions", key: "closePanel" }, "Close Panel"),
		icon: Lxicon.close,
	},
	group: "navigation",
	order: 50,
});
