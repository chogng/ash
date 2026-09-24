import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { localizedString } from "../../../../platform/action/common/action.js";
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
			title: localizedString("ash.actions", "showPrimarySidebar", "Show Primary Side Bar"),
			tooltip: localizedString("ash.actions", "showPrimarySidebar", "Show Primary Side Bar"),
			icon: lxiconsLibrary.layoutSidebarLeftOff,
			toggled: {
				condition: SideBarVisibleContext.isEqualTo(true),
				title: localizedString("ash.actions", "hidePrimarySidebar", "Hide Primary Side Bar"),
				tooltip: localizedString("ash.actions", "hidePrimarySidebar", "Hide Primary Side Bar"),
				icon: lxiconsLibrary.layoutSidebarLeft,
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
			title: localizedString("ash.actions", "showSecondarySidebar", "Show Secondary Side Bar"),
			tooltip: localizedString("ash.actions", "showSecondarySidebar", "Show Secondary Side Bar"),
			icon: lxiconsLibrary.layoutSidebarRightOff,
			toggled: {
				condition: AuxiliaryBarVisibleContext.isEqualTo(true),
				title: localizedString("ash.actions", "hideSecondarySidebar", "Hide Secondary Side Bar"),
				tooltip: localizedString("ash.actions", "hideSecondarySidebar", "Hide Secondary Side Bar"),
				icon: lxiconsLibrary.layoutSidebarRight,
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
			title: localizedString("ash.actions", "showPanel", "Show Panel"),
			tooltip: localizedString("ash.actions", "showPanel", "Show Panel"),
			icon: lxiconsLibrary.layoutPanelOff,
			toggled: {
				condition: PanelVisibleContext.isEqualTo(true),
				title: localizedString("ash.actions", "hidePanel", "Hide Panel"),
				tooltip: localizedString("ash.actions", "hidePanel", "Hide Panel"),
				icon: lxiconsLibrary.layoutPanel,
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
			if (!layout.isPartVisible("editor")) {
				layout.showPart("editor");
			}
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
			title: localizedString("ash.actions", "maximizePanel", "Maximize Panel"),
			tooltip: localizedString("ash.actions", "maximizePanel", "Maximize Panel"),
			icon: lxiconsLibrary.screenFull,
			toggled: {
				condition: PanelMaximizedContext.isEqualTo(true),
				title: localizedString("ash.actions", "restoreEditorArea", "Restore Editor Area"),
				tooltip: localizedString("ash.actions", "restoreEditorArea", "Restore Editor Area"),
				icon: lxiconsLibrary.screenNormal,
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
		const layout = accessor.get(IWorkbenchLayoutService);
		if (layout.isPartVisible("editor")) {
			layout.showPart("panel");
			layout.hidePart("editor");
		} else {
			layout.showPart("editor");
		}
	}
});

MenusRegistry.appendMenuItem(MenuId.PanelTitle, {
	command: {
		id: TogglePanelCommandId,
		title: localizedString("ash.actions", "closePanel", "Close Panel"),
		tooltip: localizedString("ash.actions", "closePanel", "Close Panel"),
		icon: lxiconsLibrary.close,
	},
	group: "navigation",
	order: 50,
});
