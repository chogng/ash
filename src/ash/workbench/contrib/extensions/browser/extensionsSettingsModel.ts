import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IExtensionManagementService, type ExtensionUpdatePolicy, type ExtensionUpdatesSnapshot } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';

/** Projects profile update policy; Preferences owns all controls. */
export class ExtensionsSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'extensions';
	public readonly groupId = null;
	public readonly itemId = 'extensions.management';
	public readonly keywords = ['extensions', 'updates'];
	public get title(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsTitle' }, 'Extension management'); }
	public get description(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsDescription' }, 'Configure automatic extension updates for the connected profile.'); }
	public get help(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsHelp' }, 'Extension management settings. Use Tab to reach update switches and Space to toggle them. Automatic checks run hourly while App Server is running. Automatic updates also enable automatic checks; turning off automatic checks also turns off automatic updates. Bundled extensions follow Ash updates. Updated packages retain existing execution authorization rules. Use the Extensions More Actions menu to check for updates, manage extension sources or restore dismissed recommendation notifications. Escape closes accessibility help and restores focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: ExtensionUpdatesSnapshot | undefined;
	private message = '';
	private visible = false;
	private busy = false;
	private readVersion = 0;

	constructor(
		@IExtensionManagementService private readonly management: IExtensionManagementService,
	) {
		super();
		this._register(management.onDidChangeInstalled(() => { if (this.visible && !this.busy) { void this.refresh(); } }));
		this._register(toDisposable(() => { this.readVersion++; }));
	}

	public get fields(): readonly SettingsSectionField[] {
		const enabled = !this.busy && !!this.snapshot?.canManage && !this.snapshot.checking;
		return [
			{
				id: 'auto-check-updates', kind: 'boolean', enabled,
				label: localize({ bundle: 'ash.extensions', key: 'autoCheckUpdatesTitle' }, 'Automatically check for extension updates'),
				description: localize({ bundle: 'ash.extensions', key: 'autoCheckUpdatesDescription' }, 'Check signed registries hourly while App Server is running. Bundled extensions follow Ash updates.'),
				value: this.snapshot?.policy.autoCheckUpdates ?? false,
				setValue: value => { void this.setPolicy({ autoCheckUpdates: value, autoUpdate: value && !!this.snapshot?.policy.autoUpdate }); },
			},
			{
				id: 'auto-update', kind: 'boolean', enabled,
				label: localize({ bundle: 'ash.extensions', key: 'autoUpdateTitle' }, 'Automatically update extensions'),
				description: localize({ bundle: 'ash.extensions', key: 'autoUpdateDescription' }, 'Install newer stable registry versions when checking for updates. This also enables automatic checks. Execution authorization remains separate.'),
				value: this.snapshot?.policy.autoUpdate ?? false,
				setValue: value => { void this.setPolicy({ autoCheckUpdates: value || !!this.snapshot?.policy.autoCheckUpdates, autoUpdate: value }); },
			},
			{ id: 'update-status', kind: 'status', text: this.updateStatus() },
		];
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		if (visible) { this.message = ''; void this.refresh(); }
		else { this.readVersion++; }
	}

	private updateStatus(): string {
		if (this.message) { return this.message; }
		if (this.busy || this.snapshot?.checking) { return localize({ bundle: 'ash.extensions', key: 'updatesWorking' }, 'Reading extension update settings…'); }
		if (!this.snapshot) { return localize({ bundle: 'ash.extensions', key: 'updatesNotLoaded' }, 'Open this section to read extension update settings.'); }
		if (!this.snapshot.canManage) { return localize({ bundle: 'ash.extensions', key: 'updatesReadOnly' }, 'This connection can read extension update settings. Use an authorized desktop or remote host to change them.'); }
		return '';
	}

	private async setPolicy(policy: ExtensionUpdatePolicy): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot || this.busy || !snapshot.canManage) { return; }
		await this.perform(async () => { this.snapshot = await this.management.setUpdatePolicy(policy, snapshot.revision); });
	}

	private async refresh(): Promise<void> {
		const version = ++this.readVersion;
		try {
			const snapshot = await this.management.updates();
			if (this.isDisposed || version !== this.readVersion) { return; }
			this.snapshot = snapshot;
		} catch {
			if (this.isDisposed || version !== this.readVersion) { return; }
			this.message = localize({ bundle: 'ash.extensions', key: 'updatesReadFailed' }, 'Could not read extension update settings. Check the App Server connection and reopen this section.');
		}
		if (!this.isDisposed && version === this.readVersion) { this.changed.fire(); }
	}

	private async perform(work: () => Promise<void>): Promise<void> {
		if (this.busy || this.isDisposed) { return; }
		this.readVersion++;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try { await work(); }
		catch { if (!this.isDisposed) { this.message = localize({ bundle: 'ash.extensions', key: 'updatesActionFailed' }, 'Could not complete the extension action. Refresh the section and retry. Another window may have changed the policy.'); } }
		finally {
			if (!this.isDisposed) {
				this.busy = false;
				if (this.visible) { await this.refresh(); }
				this.changed.fire();
			}
		}
	}
}
