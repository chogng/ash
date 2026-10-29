import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { WorkspaceTrustEditorInput } from '../../../services/workspaces/browser/workspaceTrustEditorInput.js';
import { WorkspaceTrustEditor } from './workspaceTrustEditor.js';
import { MANAGE_TRUST_COMMAND_ID } from '../common/workspace.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, type IWorkspaceTrustInfo, type WorkspaceTrustRequestOptions } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IDialogsModel, type IDialogHandle } from '../../../common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { registerWorkbenchContribution, WorkbenchPhase, type IWorkbenchContribution } from '../../../common/contributions.js';
import { StatusbarAlignment, IStatusbarService, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';

const bannerId = 'workbench.banner.restrictedMode';
const dismissedKey = 'workbench.banner.restrictedMode.dismissed';
const bannerSetting = 'security.workspace.trust.banner';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: bannerSetting,
	defaultValue: 'untilDismissed' as 'always' | 'untilDismissed' | 'never',
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['always', 'untilDismissed', 'never'] },
	parse(value: unknown): 'always' | 'untilDismissed' | 'never' {
		if (value !== 'always' && value !== 'untilDismissed' && value !== 'never') throw new TypeError(localize('workspaceTrust.bannerInvalid', 'Workspace permission banner must be always, untilDismissed, or never.'));
		return value;
	},
	setting: {
		valueType: 'select',
		title: localize('workspaceTrust.bannerTitle', 'Workspace permission banner'),
		description: localize('workspaceTrust.bannerDescription', 'Choose when to show the banner for a read-only or restricted workspace. This does not change directory permissions.'),
		options: [
			{ value: 'always', label: localize('workspaceTrust.bannerAlways', 'Always') },
			{ value: 'untilDismissed', label: localize('workspaceTrust.bannerUntilDismissed', 'Until dismissed') },
			{ value: 'never', label: localize('workspaceTrust.bannerNever', 'Never') },
		],
	},
});

class WorkspacePermissionStatus extends Disposable implements IWorkbenchContribution {
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private generation = 0;
	private trustInfo: IWorkspaceTrustInfo | undefined;
	private workspaceId: string;

	constructor(
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IBannerService private readonly banners: IBannerService,
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.workspaceId = workspace.getWorkspace().id;
		this._register(trust.onDidChangeTrustedFolders(() => { void this.refresh(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(bannerSetting)) this.updateEntry();
		}));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.WORKSPACE && event.key === dismissedKey) this.updateEntry();
		}));
		void this.refresh();
	}

	protected override disposeCore(): void {
		this.banners.hide(bannerId);
		super.disposeCore();
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const workspaceId = this.workspace.getWorkspace().id;
		if (workspaceId !== this.workspaceId) {
			this.workspaceId = workspaceId;
			this.trustInfo = undefined;
			this.updateEntry();
		}
		try {
			await this.trust.workspaceTrustInitialized;
			await this.trust.resolveWorkspaceTrust();
			const trustInfo = await this.trust.getWorkspaceTrustInfo();
			if (this.isDisposed || generation !== this.generation) return;
			this.trustInfo = trustInfo;
			this.updateEntry();
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return;
			console.error('Failed to read workspace trust information', error);
			this.trustInfo = undefined;
			this.updateEntry();
		}
	}

	private updateEntry(): void {
		if (!this.trustInfo || this.trustInfo.isTrusted) {
			this.entry.clear();
			this.banners.hide(bannerId);
			return;
		}
		const text = this.trustInfo.isReadOnly
			? localize('workspaceTrust.readOnlyStatus', 'Read-only folder')
			: localize('workspaceTrust.restrictedStatus', 'Restricted workspace');
		const tooltip = this.trustInfo.isReadOnly
			? localize('workspaceTrust.readOnlyStatusDetail', 'Files in this folder cannot be edited.')
			: localize('workspaceTrust.restrictedStatusDetail', 'Some workspace features are limited by directory permissions.');
		const content = { text, ariaLabel: `${text}. ${tooltip}`, tooltip, command: MANAGE_TRUST_COMMAND_ID };
		if (this.entry.value) this.entry.value.update(content);
		else this.entry.value = this.statusbar.addEntry(content, { id: 'ash.status.workspacePermissions', alignment: StatusbarAlignment.Left, priority: 850 });
		const policy = this.configuration.getValue<'always' | 'untilDismissed' | 'never'>(bannerSetting);
		if (policy === 'never' || policy !== 'always' && this.storage.getBoolean(dismissedKey, StorageScope.WORKSPACE, false)) {
			this.banners.hide(bannerId);
			return;
		}
		const workspaceId = this.workspaceId;
		this.banners.show({
			id: bannerId,
			icon: Lxicon.lock,
			actions: [{ label: localize('workspaceTrust.manage', 'Manage permissions'), href: `command:${MANAGE_TRUST_COMMAND_ID}` }],
			message: this.trustInfo.isReadOnly
				? localize('workspaceTrust.readOnlyBanner', 'This workspace is read-only. Editing files and running commands are unavailable.')
				: localize('workspaceTrust.restrictedBanner', 'This workspace has limited directory permissions. Some features are unavailable.'),
			onClose: () => {
				// A pending close must never dismiss a different workspace after a switch.
				if (workspaceId === this.workspace.getWorkspace().id) this.storage.store(dismissedKey, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			},
		});
	}
}

/** Dialog presentation is separate from the window's single pending trust decision. */
class WorkspaceTrustRequestHandler extends Disposable implements IWorkbenchContribution {
	private generation = 0;
	private dialog: IDialogHandle | undefined;

	constructor(
		@IWorkspaceTrustRequestService private readonly requests: IWorkspaceTrustRequestService,
		@IWorkspaceTrustManagementService private readonly management: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDialogsModel private readonly dialogs: IDialogsModel,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(requests.onDidInitiateWorkspaceTrustRequest(options => { void this.showRequest(options); }));
		this._register(requests.onDidInitiateWorkspaceTrustRequestOnStartup(() => { void this.showRequest(); }));
		this._register(workspace.onDidChangeWorkspace(() => { this.generation++; this.dialog?.item.cancel(); this.dialog = undefined; }));
		void management.workspaceTrustInitialized.then(async () => {
			// A saved read-only decision has already been answered by the directory prompt.
			if (this.isDisposed || !management.canSetWorkspaceTrust()) return;
			const generation = this.generation;
			const info = await management.getWorkspaceTrustInfo();
			if (!this.isDisposed && generation === this.generation && info === undefined) requests.requestWorkspaceTrustOnStartup();
		}).catch(error => { if (!this.isDisposed) notifications.error(getErrorMessage(error)); });
	}

	private async showRequest(options?: WorkspaceTrustRequestOptions): Promise<void> {
		const generation = ++this.generation;
		this.dialog?.item.cancel();
		const current = (): boolean => !this.isDisposed && generation === this.generation;
		try {
			await this.management.workspaceResolved;
			if (!current()) return;
			const buttons = options?.buttons ?? [
				{ label: localize('workspaceTrust.enableDevelopment', 'Trust workspace'), type: 'ContinueWithTrust' },
				{ label: localize('workspaceTrust.manage', 'Manage permissions'), type: 'Manage' },
			] as const;
			const actions = buttons.filter(button => button.type !== 'Cancel');
			const dialog = this.dialog = this.dialogs.show({
				kind: 'choice',
				title: localize('workspaceTrust.editorTitle', 'Workspace Trust'),
				message: options?.message ?? localize('workspaceTrust.requestMessage', 'Do you trust the authors of the files in this workspace?'),
				detail: localize('workspaceTrust.requestDetail', 'Trusting this workspace enables commands and workspace integrations in every folder. Only continue if you trust this project. Changing permissions may terminate running terminal commands and debug sessions. Unsaved process state may be lost.'),
				buttons: actions.map(button => button.label),
				cancelButton: buttons.find(button => button.type === 'Cancel')?.label ?? localize('cancel', 'Cancel'),
			});
			const result = await dialog.result;
			if (this.dialog === dialog) this.dialog = undefined;
			if (!current()) return;
			switch (result.buttonIndex === undefined ? undefined : actions[result.buttonIndex]?.type) {
				case 'ContinueWithTrust': await this.requests.completeWorkspaceTrustRequest(true); break;
				case 'ContinueWithoutTrust': await this.requests.completeWorkspaceTrustRequest(false); break;
				case 'Manage':
					this.requests.cancelWorkspaceTrustRequest();
					await this.editors.openEditor(new WorkspaceTrustEditorInput(), { pinned: true, modal: { size: { width: 560, height: 360 } } }, 'modalGroup');
					break;
				default: this.requests.cancelWorkspaceTrustRequest();
			}
		} catch (error) {
			if (current()) { this.requests.cancelWorkspaceTrustRequest(); this.notifications.error(getErrorMessage(error)); }
		}
	}

	protected override disposeCore(): void {
		this.dialog?.item.cancel();
		this.dialog = undefined;
		super.disposeCore();
	}
}

registerWorkbenchContribution(
	'workbench.contrib.workspaceTrustRequestHandler',
	WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(WorkspaceTrustRequestHandler),
);

registerWorkbenchContribution(
	'workbench.contrib.workspacePermissionStatus',
	WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(WorkspacePermissionStatus),
);

registerEditorPane({
	id: WorkspaceTrustEditor.ID,
	get name() { return localize('workspaceTrust.editorTitle', 'Workspace Trust'); },
	canOpen: input => input.contentType === WorkspaceTrustEditorInput.ID ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Workspace Trust requires the Instantiation Service');
		return options.instantiationService.createInstance(WorkspaceTrustEditor);
	},
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: MANAGE_TRUST_COMMAND_ID, title: localize2('manageWorkspaceTrust', 'Manage Workspace Trust'), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorService).openEditor(new WorkspaceTrustEditorInput(), {
			pinned: true,
			modal: { size: { width: 560, height: 360 } },
		}, 'modalGroup');
	}
});
