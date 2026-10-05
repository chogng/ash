import { localize2 } from '../../../../nls.js';
import '../../terminalContrib/voice/browser/terminal.voice.contribution.js';
import '../../terminalContrib/links/browser/terminal.links.contribution.js';
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, WorkbenchViewContainerId, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";
import { TERMINAL_VIEW_ID } from "../common/terminal.js";
import { TerminalViewPane } from "./terminalView.js";
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalService } from './terminal.js';
import { TerminalService } from './terminalService.js';
import { TerminalMainContribution } from './terminalMainContribution.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

// Ash creates its view services with the Parts; host terminal requests need both owners ready.
registerWorkbenchContribution(TerminalMainContribution.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(TerminalMainContribution));

registerWorkbenchServiceContribution({
	service: ITerminalService,
	dependencies: [ITerminalProcessService, IWorkspaceContextService],
	install: context => context.register(context.container.createInstance(TerminalService)),
});

export { TERMINAL_VIEW_ID } from "../common/terminal.js";

registerAction2(class FocusTerminalAction extends Action2 {
	constructor() {
		super({
			id: "workbench.action.terminal.focus",
			title: localize2({ bundle: "ash", key: "workbench.focusTerminal" }, "Focus Terminal"),
			f1: true,
			menu: { id: MenuId.MenubarTerminalMenu, group: "1_terminal", order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(IViewsService).focusView(TERMINAL_VIEW_ID);
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
		ctorDescriptor: new SyncDescriptor(TerminalViewPane),
	}]);
}
