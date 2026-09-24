import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import { IRemoteAgentService } from "../../../services/remote/common/remoteAgentService.js";
import { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import { IRemoteTunnelService } from "../../../../platform/remote/common/remoteTunnelService.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import "./remoteActions.js";
import { RemoteContextKeys } from "./remoteContextKeys.js";
import { RemoteExtensionRecoveryContribution } from "./remoteExtensionRecovery.js";
import { RemoteStatusIndicator } from "./remoteIndicator.js";
import { RemotePortsViewPane } from "./remotePortsViewPane.js";

export const REMOTE_PORTS_VIEW_ID = "ash.ports";

/** Contributes the host-owned SSH tunnel catalog as a Workbench panel. */
export function registerRemoteViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Ports,
		title: "Ports",
		localizationKey: { bundle: "ash.views", key: "ports" },
		location: ViewContainerLocation.Panel,
		order: 4,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Ports, [{
		id: REMOTE_PORTS_VIEW_ID,
		title: "Ports",
		localizationKey: { bundle: "ash.views", key: "ports" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(RemotePortsViewPane, { serviceDependencies: [IRemoteTunnelService, IRemoteAgentService] }),
	}]);
}

registerWorkbenchContribution(RemoteContextKeys.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteContextKeys({
	contextKeyService: accessor.get(IContextKeyService),
	remoteAgentService: accessor.get(IRemoteAgentService),
	remoteConnectionService: accessor.get(IRemoteConnectionService),
}));

registerWorkbenchContribution(RemoteStatusIndicator.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteStatusIndicator({
	remoteAgentService: accessor.get(IRemoteAgentService),
	runCommand: id => accessor.get(ICommandService).executeCommand(id),
	statusbarService: accessor.get(IStatusbarService),
}));

registerWorkbenchContribution(RemoteExtensionRecoveryContribution.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteExtensionRecoveryContribution({
	extensionService: accessor.get(IExtensionService),
	remoteAgentService: accessor.get(IRemoteAgentService),
}));
