import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import {
	IAppServerApi,
	type IAppServerConnectionRecovery,
} from '../../../../platform/agentHost/common/appServerApi.js';
import { MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	AppServerRecoveryAvailableContext,
	ReconnectAppServerCommandId,
} from '../../../../workbench/contrib/remote/browser/remoteActions.js';
import { MANAGE_TRUST_COMMAND_ID } from '../../../../workbench/contrib/workspace/common/workspace.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';

const connectionRecoveryState = new RawContextKey<IAppServerConnectionRecovery['status']>(
	'sessions.connectionRecoveryState',
	'idle',
);

/** Window chrome projects connection and workspace permissions without reserving a notice row. */
class WorkspaceStatusContribution extends Disposable {
	private readonly permissionEntry = this._register(new MutableDisposable<IDisposable>());
	private readonly recoveryNotification = this._register(new MutableDisposable<IDisposable>());
	private permissionGeneration = 0;
	private workspaceId: string;
	private recoveryStatus: IAppServerConnectionRecovery['status'] | undefined;
	private recoveryError: string | undefined;

	constructor(
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IAppServerApi api: IAppServerApi,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.workspaceId = workspace.getWorkspace().id;
		this._register(
			trust.onDidChangeTrustedFolders(() => {
				void this.refreshPermissions();
			}),
		);
		this._register(
			workspace.onDidChangeWorkspace(() => {
				void this.refreshPermissions();
			}),
		);
		void this.refreshPermissions();

		const available = AppServerRecoveryAvailableContext.bindTo(contextKeys);
		const connectionState = connectionRecoveryState.bindTo(contextKeys);
		this._register(
			toDisposable(() => {
				available.reset();
				connectionState.reset();
			}),
		);
		const recovery = api.recovery;
		if (!recovery) return;
		const reloadLabel = localize('sessions.workspaceStatus.reload', 'Reload Agent Window');
		const reload: IAction = {
			id: 'workbench.action.reloadWindow',
			label: reloadLabel,
			tooltip: reloadLabel,
			enabled: true,
			run: () => commands.executeCommand('workbench.action.reloadWindow'),
		};
		for (const [state, command, title, tooltip, icon] of [
			[
				'recovering',
				ReconnectAppServerCommandId,
				localize('appServer.recovering', 'Reconnecting to the Agent Host…'),
				localize('appServer.recovering', 'Reconnecting to the Agent Host…'),
				Lxicon.refresh,
			],
			[
				'failed',
				ReconnectAppServerCommandId,
				localize('sessions.workspaceStatus.reconnect', 'Reconnect Agent Host'),
				localize(
					'appServer.recoveryFailed',
					'Could not restore the Agent Host connection or workspace. Try again.',
				),
				Lxicon.warning,
			],
			['unavailable', 'workbench.action.reloadWindow', reload.label, reload.label, Lxicon.warning],
		] as const) {
			this._register(
				MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
					group: 'navigation',
					order: 0,
					when: connectionRecoveryState.isEqualTo(state),
					command: { id: command, title, tooltip, icon },
				}),
			);
		}
		const updateConnection = (): void => {
			const next = recovery.status;
			if (next === this.recoveryStatus && recovery.error === this.recoveryError) return;
			contextKeys.bufferChangeEvents(() => {
				available.set(next === 'failed' || next === 'recovering');
				connectionState.set(next);
			});
			const previous = this.recoveryStatus;
			this.recoveryStatus = next;
			this.recoveryError = recovery.error;
			if (next === 'idle' || next === 'suspended') {
				this.recoveryNotification.clear();
				if (next === 'idle' && previous && previous !== 'idle' && previous !== 'suspended') {
					status(localize('sessions.workspaceStatus.connected', 'Agent Host connection restored.'));
				}
				return;
			}
			const recovering = next === 'recovering';
			const unavailable = next === 'unavailable';
			const title = recovering
				? localize('appServer.recovering', 'Reconnecting to the Agent Host…')
				: unavailable
					? reload.label
					: localize('sessions.workspaceStatus.reconnect', 'Reconnect Agent Host');
			const message = recovering
				? title
				: unavailable
					? localize(
							'appServer.recoveryUnavailable',
							'The Agent Host connection cannot be restored. {0}',
							recovery.error ?? '',
						)
					: localize(
							'appServer.recoveryFailed',
							'Could not restore the Agent Host connection or workspace. Try again.',
						);
			if (next !== previous) status(message);
			if (unavailable && previous !== 'unavailable') {
				// A terminal connection failure needs a global recovery action; ordinary reconnects do not.
				const notification = notifications.notify({
					severity: Severity.Error,
					message,
					sticky: true,
					actions: { primary: [reload] },
				});
				this.recoveryNotification.value = toDisposable(() => notification.close());
			} else if (!unavailable) {
				this.recoveryNotification.clear();
			}
		};
		this._register(recovery.onDidChange(updateConnection));
		updateConnection();
	}

	private async refreshPermissions(): Promise<void> {
		const generation = ++this.permissionGeneration;
		const workspace = this.workspace.getWorkspace();
		if (workspace.id !== this.workspaceId) {
			this.workspaceId = workspace.id;
			this.permissionEntry.clear();
		}
		try {
			await this.trust.workspaceTrustInitialized;
			await this.trust.resolveWorkspaceTrust();
			const info = await this.trust.getWorkspaceTrustInfo();
			if (this.isDisposed || generation !== this.permissionGeneration) return;
			this.permissionEntry.clear();
			if (!info || info.isTrusted || workspace.folders.length === 0) return;
			const name = workspace.folders.map(folder => folder.name).join(', ');
			this.permissionEntry.value = MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
				group: 'navigation',
				order: 1,
				when: SessionsWorkspaceModeContext.isEqualTo('code'),
				command: {
					id: MANAGE_TRUST_COMMAND_ID,
					title: info.isReadOnly
						? localize('sessions.workspaceStatus.readOnly', 'Read-only workspace: {0}', name)
						: localize('sessions.workspaceStatus.restricted', 'Restricted workspace: {0}', name),
					tooltip: localize(
						'sessions.workspaceStatus.manage',
						'Manage permissions for workspace: {0}',
						workspace.folders.map(folder => folder.uri.toString(true)).join(', '),
					),
					icon: Lxicon.lock,
				},
			});
		} catch (error) {
			if (this.isDisposed || generation !== this.permissionGeneration) return;
			this.permissionEntry.clear();
			console.error('Failed to read workspace permission status', error);
		}
	}
}

registerWorkbenchContribution('sessions.contrib.workspaceStatus', WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(WorkspaceStatusContribution),
);

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'sessionsWorkspaceStatus',
	getProvider: accessor => {
		const layout = accessor.get(ILayoutService);
		const focused = layout.mainContainer.ownerDocument.activeElement;
		if (!isHTMLElement(focused)) return undefined;
		const action = focused.closest<HTMLElement>('.ash-sessions-titlebar [data-action-id]');
		if (
			!action ||
			![MANAGE_TRUST_COMMAND_ID, ReconnectAppServerCommandId, 'workbench.action.reloadWindow'].includes(
				action.dataset.actionId ?? '',
			)
		)
			return undefined;
		// These controls belong to the existing Agents window help and verbosity scope.
		return new AccessibleContentProvider(
			AccessibleViewProviderId.AgentSessions,
			{ type: AccessibleViewType.Help },
			() =>
				localize(
					'sessions.workspaceStatus.help',
					"Agent window status\nThe title bar shows Agent Host recovery in every workspace. Use Tab and Shift+Tab to reach the status actions, and Enter or Space to activate them. Reconnect Agent Host retries the connection without resending unfinished messages. Agent Host: Reconnect is also available in the Command Palette. Reload Agent Window is offered when the connection cannot be restored. In Code, Read-only workspace or Restricted workspace names this window's workspace. Activate it to open Workspace Trust and review or change that workspace's directory permissions. Other conversations and hosts keep their own permissions. Escape closes this help and returns focus.",
				),
			() => {
				if (focused.isConnected) focused.focus();
				else layout.focus();
			},
			AccessibilityVerbositySettingId.AgentSessions,
		);
	},
});
