import { localizedString } from "../../../../platform/action/common/action.js";
import { Action2, IMenuService, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { ServiceConstructionDescriptor, type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ViewContainerLocation, WorkbenchViewContainerId, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { ITerminalService } from "../../../services/terminal/common/terminal.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { TERMINAL_VIEW_ID } from "../common/terminal.js";
import { TerminalViewPane } from "./terminalView.js";

export { TERMINAL_VIEW_ID } from "../common/terminal.js";

registerAction2(class FocusTerminalAction extends Action2 {
	constructor() {
		super({
			id: "workbench.action.terminal.focus",
			title: localizedString("ash", "workbench.focusTerminal", "Focus Terminal"),
			f1: true,
			menu: { id: MenuId.MenubarTerminalMenu, group: "1_terminal", order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IViewsService).focusView(TERMINAL_VIEW_ID);
	}
});

/** Registers the integrated terminal in the Workbench panel. */
export function registerTerminalView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Terminal,
		title: "Terminal",
		localizationKey: { bundle: "ash.views", key: "terminal" },
		location: ViewContainerLocation.Panel,
		order: 3,
		isDefault: true,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Terminal, [{
		id: TERMINAL_VIEW_ID,
		title: "Terminal",
		localizationKey: { bundle: "ash.views", key: "terminal" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(TerminalViewPane, {
			serviceDependencies: [ITerminalService, IThemeService, IMenuService, IContextMenuService, IContextKeyService, IWorkbenchLayoutService, IWorkspaceContextService],
		}),
	}]);
}
