import { registerTerminalActions } from './terminalActions.js';
import { setupTerminalMenus } from './terminalMenus.js';
import '../../terminalContrib/voice/browser/terminal.voice.contribution.js';
import '../../terminalContrib/links/browser/terminal.links.contribution.js';
import '../../terminalContrib/find/browser/terminal.find.contribution.js';
import '../../terminalContrib/accessibility/browser/terminal.accessibility.contribution.js';
import '../../terminalContrib/clipboard/browser/terminal.clipboard.contribution.js';
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, WorkbenchViewContainerId, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { TERMINAL_VIEW_ID } from "../common/terminal.js";
import { TerminalViewPane } from "./terminalView.js";
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { ITerminalConfigurationService } from './terminal.js';
import { ITerminalService } from '../../../services/terminal/browser/terminal.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../../services/terminal/common/terminal.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { BrowserTerminalProfileResolverService } from './terminalProfileResolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TerminalConfigurationService } from './terminalConfigurationService.js';
import { TerminalProfileService } from './terminalProfileService.js';
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

registerWorkbenchServiceContribution({
	service: ITerminalConfigurationService,
	dependencies: [IConfigurationService],
	install: context => context.register(context.container.createInstance(TerminalConfigurationService)),
});

registerWorkbenchServiceContribution({
	service: ITerminalProfileService,
	dependencies: [ITerminalService, ITerminalProcessService, IConfigurationService, IWorkspaceContextService, IExtensionService],
	install: context => context.register(context.container.createInstance(TerminalProfileService)),
});

registerWorkbenchServiceContribution({
	service: ITerminalProfileResolverService,
	dependencies: [ITerminalProfileService, ITerminalProcessService, IConfigurationService, IConfigurationResolverService, IWorkspaceContextService],
	install: context => context.register(context.container.createInstance(BrowserTerminalProfileResolverService)),
});

export { TERMINAL_VIEW_ID } from "../common/terminal.js";

registerTerminalActions();
setupTerminalMenus();

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
