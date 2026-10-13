import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { TERMINAL_CONFIG_SECTION } from '../common/terminal.js';
import { ITerminalProfileService } from '../../../services/terminal/common/terminal.js';

interface ProfileItem extends IQuickPickItem { readonly profileId: string; }

/** A command-owned selection lifetime; cancelling never acquires a terminal process. */
export class TerminalProfileQuickpick extends Disposable {
	private readonly selection = this._register(new MutableDisposable<DisposableStore>());
	constructor(
		@ITerminalProfileService private readonly profiles: ITerminalProfileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { super(); }

	async showAndGetResult(type: 'setDefault' | 'createInstance'): Promise<string | undefined> {
		await this.profiles.refreshAvailableProfiles();
		if (this.isDisposed) throw new CancellationError();
		const platform = await this.profiles.getPlatformKey();
		if (this.isDisposed) throw new CancellationError();
		const profileId = await new Promise<string | undefined>(resolve => {
			const lifetime = new DisposableStore();
			this.selection.value = lifetime;
			const picker = lifetime.add(this.quickInput.createQuickPick<ProfileItem>());
			picker.ariaLabel = picker.placeholder = type === 'setDefault'
				? localize('terminal.profile.selectDefault', 'Select the default terminal profile')
				: localize('terminal.profile.select', 'Select a terminal profile');
			const update = () => {
				picker.items = [...this.profiles.availableProfiles.map(profile => ({
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

				if (!this.profiles.availableProfiles.some(profile => profile.profileId === item.profileId) && !this.profiles.contributedProfiles.some(profile => item.profileId === `extension:${profile.extensionIdentifier}/${profile.id}`)) return;
				selected = item.profileId;
				picker.hide();

			}));
			lifetime.add(picker.onDidHide(() => { resolve(selected); this.selection.clear(); }));
			lifetime.add(toDisposable(() => resolve(undefined)));
			picker.show();
		});
		if (profileId === undefined || this.isDisposed) return undefined;
		const currentPlatform = await this.profiles.getPlatformKey();
		if (this.isDisposed || platform !== currentPlatform) return undefined;
		const profile = this.profiles.availableProfiles.find(profile => profile.profileId === profileId);
		const contributed = this.profiles.contributedProfiles.find(profile => profileId === `extension:${profile.extensionIdentifier}/${profile.id}`);
		if (!profile && !contributed) return undefined;
		if (type === 'setDefault') {
			if (contributed) await this.profiles.registerContributedProfile({ ...contributed, options: contributed.options ?? {} });
			const title = profile?.profileName ?? contributed!.title;
			await this.configuration.updateValue(`${TERMINAL_CONFIG_SECTION}.defaultProfile.${platform}`, title, ConfigurationTarget.USER);
			return title;
		}
		return profileId;
	}
}
