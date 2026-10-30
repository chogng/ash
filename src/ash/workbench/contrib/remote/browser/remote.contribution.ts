import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAppServerApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerRecoveryAvailableContext, ReconnectAppServerCommandId } from './remoteActions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import { IRemoteConnectionService } from '../../../../platform/remote/common/remoteConnectionService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import './remoteActions.js';
import { RemoteContextKeys } from './remoteContextKeys.js';
import { RemoteExtensionRecoveryContribution } from './remoteExtensionRecovery.js';
import { RemoteStatusIndicator } from './remoteIndicator.js';
import { TunnelPanel } from './tunnelView.js';

export const REMOTE_PORTS_VIEW_ID = 'ash.ports';

/** Contributes the host-owned SSH tunnel catalog as a Workbench panel. */
export function registerRemoteViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Ports,
		title: 'Ports',
		localizationKey: { bundle: 'ash.views', key: 'ports' },
		location: ViewContainerLocation.Panel,
		order: 4,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Ports, [{
		id: REMOTE_PORTS_VIEW_ID,
		title: 'Ports',
		localizationKey: { bundle: 'ash.views', key: 'ports' },
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

/** Projects this window's connection-owned recovery into one persistent notice. */
class AppServerRecoveryContribution extends Disposable {
	constructor(
		@IAppServerApi api: IAppServerApi,
		@IBannerService banners: IBannerService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		const id = 'workbench.banner.appServerRecovery';
		const available = AppServerRecoveryAvailableContext.bindTo(contextKeys);
		this._register(toDisposable(() => { banners.hide(id); available.reset(); }));
		const recovery = api.recovery;
		if (!recovery) return;
		const update = (): void => {
			available.set(recovery.status === 'failed' || recovery.status === 'recovering');
			if (recovery.status === 'failed') {
				banners.show({
					id, icon: Lxicon.warning, priority: 100,
					message: localize('appServer.recoveryFailed', 'Could not restore the Agent Host connection or workspace. Try again.'),
					actions: [{ label: localize('appServer.reconnect', 'Reconnect'), href: `command:${ReconnectAppServerCommandId}` }],
				});
			} else if (recovery.status === 'recovering') {
				banners.show({ id, icon: Lxicon.info, priority: 100, message: localize('appServer.recovering', 'Reconnecting to the Agent Host…') });
			} else if (recovery.status === 'unavailable') {
				banners.show({ id, icon: Lxicon.warning, priority: 100, message: localize('appServer.recoveryUnavailable', 'The Agent Host connection cannot be restored. {0}', recovery.error ?? '') });
			} else {
				// Intentional suspension and a healthy connection both clear this producer only.
				banners.hide(id);
			}
		};
		this._register(recovery.onDidChange(update));
		update();
	}
}

registerWorkbenchContribution('workbench.contrib.appServerRecovery', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(AppServerRecoveryContribution));
