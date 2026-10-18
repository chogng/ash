import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAppServerApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { INotificationService, type NotificationHandle } from '../../../../platform/notification/common/notification.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerRecoveryAvailableContext, ReconnectAppServerCommandId } from './remoteActions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IExtensionService } from "../../../services/extensions/common/extensionService.js";
import { IAppServerRemoteAgentService } from "../../../services/remote/common/appServerRemoteAgentService.js";
import { IRemoteConnectionService } from "../../../../platform/remote/common/remoteConnectionService.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import "./remoteActions.js";
import { RemoteContextKeys } from "./remoteContextKeys.js";
import { RemoteExtensionRecoveryContribution } from "./remoteExtensionRecovery.js";
import { RemoteStatusIndicator } from "./remoteIndicator.js";
import { TunnelPanel } from "./tunnelView.js";

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
		ctorDescriptor: new SyncDescriptor(TunnelPanel),
	}]);
}

registerWorkbenchContribution(RemoteContextKeys.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteContextKeys({
	contextKeyService: accessor.get(IContextKeyService),
	remoteAgentService: accessor.get(IAppServerRemoteAgentService),
	remoteConnectionService: accessor.get(IRemoteConnectionService),
}));

registerWorkbenchContribution(RemoteStatusIndicator.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteStatusIndicator({
	remoteAgentService: accessor.get(IAppServerRemoteAgentService),
	runCommand: id => accessor.get(ICommandService).executeCommand(id),
	statusbarService: accessor.get(IStatusbarService),
}));

registerWorkbenchContribution(RemoteExtensionRecoveryContribution.ID, WorkbenchPhase.BlockStartup, accessor => new RemoteExtensionRecoveryContribution({
	extensionService: accessor.get(IExtensionService),
	remoteAgentService: accessor.get(IAppServerRemoteAgentService),
}));

/** Presents recovery owned by this window's active connection, using ordinary notifications. */
class AppServerRecoveryContribution extends Disposable {
	private notification: NotificationHandle | undefined;

	constructor(
		@IAppServerApi api: IAppServerApi,
		@INotificationService notifications: INotificationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		const available = AppServerRecoveryAvailableContext.bindTo(contextKeys);
		this._register(toDisposable(() => { this.notification?.close(); available.reset(); }));
		const recovery = api.recovery;
		if (!recovery) return;
		const update = (): void => {
			available.set(recovery.status === 'failed' || recovery.status === 'recovering');
			this.notification?.close();
			this.notification = undefined;
			if (recovery.status === 'failed') {
				this.notification = notifications.error(localize('appServer.recoveryFailed', 'Could not reconnect to the Agent Host. Check the connection and try again.'), [{
					id: ReconnectAppServerCommandId,
					label: localize('appServer.reconnect', 'Reconnect'),
					run: () => recovery.reconnect().catch(() => { }),
				}]);
			} else if (recovery.status === 'unavailable') {
				this.notification = notifications.error(localize('appServer.recoveryUnavailable', 'The Agent Host connection cannot be restored. {0}', recovery.error ?? ''));
			}
		};
		this._register(recovery.onDidChange(update));
		update();
	}
}

registerWorkbenchContribution('workbench.contrib.appServerRecovery', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(AppServerRecoveryContribution));
