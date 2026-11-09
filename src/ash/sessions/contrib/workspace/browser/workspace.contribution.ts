import './media/workspaceTrustDialog.css';
import { BrowserDialogHandler } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { DialogResult, type DialogRequest, type IDialogHandler, type IDialogOutcome } from '../../../../platform/dialogs/common/dialogs.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import {
	IAppServerApi,
	type IAppServerConnectionRecovery,
} from '../../../../platform/agentHost/common/appServerApi.js';
import { MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
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
import { IWorkspaceTrustManagementService, type DirectoryPermissionRequest, type IDirectoryPermissionRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	AppServerRecoveryAvailableContext,
	ReconnectAppServerCommandId,
} from '../../../../workbench/contrib/remote/browser/remoteActions.js';
import { MANAGE_TRUST_COMMAND_ID } from '../../../../workbench/contrib/workspace/common/workspace.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionFolderTrustRetryService, SessionFolderTrustRetryService } from '../../../services/workspace/browser/sessionFolderTrustRetryService.js';
import { WorkspaceFolderManagementContribution } from './workspaceFolderManagement.js';

const retryFolderTrustCommandId = 'sessions.workspace.retryFolderTrust';
const folderTrustRetryScope = new RawContextKey<string>('sessions.folderTrustRetryScope', '');
const noFolderTrustRetry = ContextKeyExpr.not(folderTrustRetryScope.key);

registerSingleton(ISessionFolderTrustRetryService, SessionFolderTrustRetryService, InstantiationType.Delayed);
CommandsRegistry.register(retryFolderTrustCommandId, accessor => accessor.get(ISessionFolderTrustRetryService).pending.get()?.run());

registerWorkbenchContribution(WorkspaceFolderManagementContribution.ID, WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(WorkspaceFolderManagementContribution),
);

export function createSessionFolderTrustRequestService(
	container: HTMLElement,
	showPrompt: (load: () => Promise<DialogRequest>, handler: IDialogHandler, signal?: AbortSignal) => Promise<IDialogOutcome>,
): IDirectoryPermissionRequestService & {
	confirmFolderTrust(request: DirectoryPermissionRequest, signal?: AbortSignal): Promise<boolean>;
} {
	const confirmFolderTrust = async (request: DirectoryPermissionRequest, signal?: AbortSignal): Promise<boolean> => {
		const document = container.ownerDocument;
		const detail = h(document, 'div', { className: 'ash-sessions-directory-permission-detail' });
		const explanation = h(document, 'div');
		explanation.textContent = localize(
			'sessions.workspace.trustDetail',
			'Trust allows Agents to read and edit files, run commands, and load project instructions and integrations in this folder.',
		);
		detail.append(explanation);
		if (request.remoteHostLabel) {
			const host = h(document, 'div');
			host.textContent = localize('sessions.workspace.remoteTrustHost', 'Remote environment: {0}', request.remoteHostLabel);
			detail.append(host);
		}
		const path = h(document, 'div', { className: 'ash-sessions-directory-permission-path' });
		path.textContent = request.path;
		detail.append(path);
		const handler = new BrowserDialogHandler(container, {
			messageAsTitle: true,
			layout: 'form',
			extraClasses: ['ash-sessions-directory-permission-dialog'],
			detailElement: detail,
			disableCloseButton: true,
			disableDefaultAction: true,
			focusCancelButton: true,
		});
		const outcome = await showPrompt(async () => ({
			kind: 'confirmation',
			message: localize('sessions.workspace.trustQuestion', 'Trust this workspace?'),
			primaryButton: localize('sessions.workspace.trustAndOpen', 'Trust and Open'),
		}), handler, signal);
		return outcome.button === DialogResult.Primary;
	};
	return {
		requiresDevelopmentTrust: true,
		confirmFolderTrust,
		async requestDirectoryPermissions(request, signal) {
			return await confirmFolderTrust(request, signal) ? 'development' : 'cancel';
		},
	};
}

type WorkspaceRecoveryState = IAppServerConnectionRecovery['status'] | 'workspaceTrust' | 'workspaceFailed' | 'workspacePreparing';

const connectionRecoveryState = new RawContextKey<WorkspaceRecoveryState>(
	'sessions.connectionRecoveryState',
	'idle',
);

/** Window chrome projects connection and workspace permissions without reserving a notice row. */
class WorkspaceStatusContribution extends Disposable {
	private readonly permissionEntry = this._register(new MutableDisposable<IDisposable>());
	private readonly folderTrustEntry = this._register(new MutableDisposable<IDisposable>());
	private readonly recoveryNotification = this._register(new MutableDisposable<IDisposable>());
	private permissionGeneration = 0;
	private workspaceId: string;
	private recoveryStatus: WorkspaceRecoveryState | undefined;

	constructor(
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IAppServerApi api: IAppServerApi,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@ISessionFolderTrustRetryService folderTrustRetry: ISessionFolderTrustRetryService,
	) {
		super();
		const scope = createUuid();
		const retryScope = folderTrustRetryScope.bindTo(contextKeys);
		this._register(toDisposable(() => retryScope.reset()));
		this._register(autorun(reader => {
			const retry = folderTrustRetry.pending.read(reader);
			this.folderTrustEntry.clear();
			if (!retry) {
				retryScope.reset();
				return;
			}
			const title = localize('sessions.workspaceStatus.retryFolderTrust', 'Retry trust for {0}', retry.path);
			this.folderTrustEntry.value = MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
				group: 'navigation',
				order: 0,
				when: folderTrustRetryScope.isEqualTo(scope),
				command: { id: retryFolderTrustCommandId, title, tooltip: title, icon: Lxicon.lock },
			});
			retryScope.set(scope);
			status(title);
		}));
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
		const recoveryActions = [
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
				localize('sessions.workspaceStatus.connectionFailed', 'Could not reconnect to the Agent Host. Try again.'),
				Lxicon.warning,
			],
			[
				'workspaceTrust',
				ReconnectAppServerCommandId,
				localize('sessions.workspaceStatus.trust', 'Trust this workspace'),
				localize('sessions.workspaceStatus.trust', 'Trust this workspace'),
				Lxicon.lock,
			],
			[
				'workspacePreparing',
				ReconnectAppServerCommandId,
				localize('appServer.preparingWorkspace', 'Preparing the workspace…'),
				localize('appServer.preparingWorkspace', 'Preparing the workspace…'),
				Lxicon.refresh,
			],
			[
				'workspaceFailed',
				ReconnectAppServerCommandId,
				localize('sessions.workspaceStatus.retryWorkspace', 'Retry workspace restore'),
				localize('sessions.workspaceStatus.workspaceFailed', 'Could not restore the workspace. Try again.'),
				Lxicon.warning,
			],
			['unavailable', 'workbench.action.reloadWindow', reload.label, reload.label, Lxicon.warning],
		] as const;
		for (const [state, command, title, tooltip, icon] of recoveryActions) {
			this._register(
				MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
					group: 'navigation',
					order: 0,
					when: state === 'workspaceTrust'
						? ContextKeyExpr.and(connectionRecoveryState.isEqualTo(state), noFolderTrustRetry)
						: connectionRecoveryState.isEqualTo(state),
					command: { id: command, title, tooltip, icon },
				}),
			);
		}
		const updateConnection = (): void => {
			const recoveryStatus = recovery.status;
			const canRetry = recoveryStatus === 'failed' || recoveryStatus === 'recovering';
			let next: WorkspaceRecoveryState = recoveryStatus;
			if (canRetry && recovery.phase === 'workspaceTrust') {
				next = 'workspaceTrust';
			} else if (canRetry && recovery.phase === 'workspace') {
				next = recoveryStatus === 'failed' ? 'workspaceFailed' : 'workspacePreparing';
			}
			const previous = this.recoveryStatus;
			if (next === previous) return;
			contextKeys.bufferChangeEvents(() => {
				available.set(canRetry);
				connectionState.set(next);
			});
			this.recoveryStatus = next;
			if (next === 'idle' || next === 'suspended') {
				this.recoveryNotification.clear();
				if (next === 'idle' && previous && previous !== 'idle' && previous !== 'suspended') {
					const restoredWorkspace = previous === 'workspaceTrust' || previous === 'workspacePreparing' || previous === 'workspaceFailed';
					status(restoredWorkspace
						? localize('sessions.workspaceStatus.workspaceRestored', 'Workspace restored.')
						: localize('sessions.workspaceStatus.connected', 'Agent Host connection restored.'));
				}
				return;
			}
			if (next === 'unavailable') {
				const message = localize(
					'appServer.recoveryUnavailable',
					'The Agent Host connection cannot be restored. {0}',
					recovery.error ?? '',
				);
				status(message);
				// A terminal connection failure needs a global recovery action; ordinary reconnects do not.
				const notification = notifications.notify({
					severity: Severity.Error,
					message,
					sticky: true,
					actions: { primary: [reload] },
				});
				this.recoveryNotification.value = toDisposable(() => notification.close());
			} else {
				const action = recoveryActions.find(([state]) => state === next);
				if (action) status(action[3]);
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
				when: ContextKeyExpr.and(SessionsWorkspaceModeContext.isEqualTo('code'), noFolderTrustRetry),
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
			![MANAGE_TRUST_COMMAND_ID, retryFolderTrustCommandId, ReconnectAppServerCommandId, 'workbench.action.reloadWindow'].includes(
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
					"Agent window status\nThe title bar shows connection and workspace recovery. Use Tab and Shift+Tab to reach the status actions, and Enter or Space to activate them. Retry trust for a folder reopens the authorization prompt for the folder you chose. Trust this workspace retries authorization for the window workspace. Retry workspace restore tries to reopen the workspace. Reconnect Agent Host retries the connection without resending unfinished messages. Agent Host: Reconnect is also available in the Command Palette. Reload Agent Window is offered when the connection cannot be restored. In Code, Read-only workspace or Restricted workspace names this window's workspace. Activate it to open Workspace Trust and review or change that workspace's directory permissions. Other conversations and hosts keep their own permissions. Escape closes this help and returns focus.",
				),
			() => {
				if (focused.isConnected) focused.focus();
				else layout.focus();
			},
			AccessibilityVerbositySettingId.AgentSessions,
		);
	},
});
