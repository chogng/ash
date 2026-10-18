import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ITerminalProcessService, TerminalSettingPrefix } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalProfileService } from '../common/terminal.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';

interface ProfileItem extends IQuickPickItem { readonly profileId: string; }

/** A command-owned selection lifetime; cancelling never acquires a terminal process. */
export class TerminalProfileQuickpick extends Disposable {
	private readonly selection = this._register(new MutableDisposable<DisposableStore>());
	private readonly cancellation = new CancellationTokenSource();
	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@ICommandService private readonly commands: ICommandService,
		@ITerminalProcessService processes: ITerminalProcessService,
	) {
		super();
		this._register(toDisposable(() => this.cancellation.dispose(true)));
		// Profile IDs and platform names can be reused by a different execution scope.
		// Retire the selection permanently rather than accepting an item after it returns.
		const retire = (): void => { this.cancellation.cancel(); this.selection.clear(); };
		this._register(this.workspace.onDidChangeWorkspace(retire));
		this._register(processes.onConnectionState(retire));
	}

	async showAndGetResult(type: 'setDefault' | 'createInstance', dirId?: string): Promise<string | undefined> {
		const isCurrent = (): boolean => !this.isDisposed && !this.cancellation.token.isCancellationRequested;
		if (!isCurrent()) return undefined;
		const folders = this.workspace.getWorkspace().folders;
		if (!dirId && folders.length > 1) {
			const active = this.editors.activeEditor?.resource;
			const folder = (active && this.workspace.getWorkspaceFolder(active))
				|| await this.commands.executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('terminal.selectFolder', 'Select a workspace folder for the terminal.') }, this.cancellation.token]);
			if (!folder || !isCurrent()) return undefined;
			dirId = folder.id;
		}
		await this.profiles.refreshAvailableProfiles(dirId);
		if (this.isDisposed) throw new CancellationError();
		if (!isCurrent()) return undefined;
		const platform = await this.profiles.getPlatformKey();
		if (this.isDisposed) throw new CancellationError();
		if (!isCurrent()) return undefined;
		const profileId = await new Promise<string | undefined>(resolve => {
			const lifetime = new DisposableStore();
			this.selection.value = lifetime;
			const picker = lifetime.add(this.quickInput.createQuickPick<ProfileItem>());
			picker.ariaLabel = picker.placeholder = type === 'setDefault'
				? localize('terminal.profile.selectDefault', 'Select the default terminal profile')
				: localize('terminal.profile.select', 'Select a terminal profile');
			const update = () => {
				picker.items = [...this.profiles.getAvailableProfiles(dirId).map(profile => ({
					profileId: profile.profileId, label: profile.title,
					description: profile.isDefault ? localize('terminal.profile.default', 'Default') : undefined,
				})), ...this.profiles.contributedProfiles.map(profile => ({ profileId: `extension:${profile.extensionIdentifier}/${profile.id}`, label: profile.title, description: profile.extensionIdentifier }))];
			};
			update();
			lifetime.add(this.profiles.onDidChangeAvailableProfiles(update));
			let selected: string | undefined;
			lifetime.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;

				if (!this.profiles.getAvailableProfiles(dirId).some(profile => profile.profileId === item.profileId) && !this.profiles.contributedProfiles.some(profile => item.profileId === `extension:${profile.extensionIdentifier}/${profile.id}`)) return;
				selected = item.profileId;
				picker.hide();

			}));
			lifetime.add(picker.onDidHide(() => { resolve(selected); this.selection.clear(); }));
			lifetime.add(toDisposable(() => resolve(undefined)));
			picker.show();
		});
		if (profileId === undefined || !isCurrent()) return undefined;
		const currentPlatform = await this.profiles.getPlatformKey();
		if (!isCurrent() || platform !== currentPlatform) return undefined;
		const profile = this.profiles.getAvailableProfiles(dirId).find(profile => profile.profileId === profileId);
		const contributed = this.profiles.contributedProfiles.find(profile => profileId === `extension:${profile.extensionIdentifier}/${profile.id}`);
		if (!profile && !contributed) return undefined;
		if (type === 'setDefault') {
			if (contributed) await this.profiles.registerContributedProfile({ ...contributed, options: contributed.options ?? {} });
			if (!isCurrent()) return undefined;
			const title = profile?.profileName ?? contributed!.title;
			await this.configuration.updateValue(`${TerminalSettingPrefix.DefaultProfile}${platform}`, title, ConfigurationTarget.USER);
			return title;
		}
		return profileId;
	}
}
