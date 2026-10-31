import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionManagementService, type ExtensionUpdatePolicy, type ExtensionUpdatesSnapshot, type ExtensionRegistrySources } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';

/** Projects profile policy and existing commands; Preferences owns all controls. */
export class ExtensionsSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'extensions';
	public readonly groupId = null;
	public readonly itemId = 'extensions.management';
	public readonly keywords = ['extensions', 'updates', 'sources', 'recommendations'];
	public get title(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsTitle' }, 'Extension management'); }
	public get description(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsDescription' }, 'Manage registry extension updates and sources for the connected profile.'); }
	public get help(): string { return localize({ bundle: 'ash.extensions', key: 'managementSettingsHelp' }, 'Extension management settings. Use Tab to reach update switches and actions; press Space to toggle a switch and Enter to run an action. Automatic checks run hourly while App Server is running. Automatic updates also enable automatic checks; turning off automatic checks also turns off automatic updates. Bundled extensions follow Ash updates. Updated packages retain existing execution authorization rules. Check for updates reads signed registries and installs updates when automatic updates are enabled. Manage extension sources opens the source picker to add or pause a custom source. Restore dismissed extension recommendation notifications restores dismissed notices; recommendation preferences still apply. Escape closes accessibility help and restores focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: ExtensionUpdatesSnapshot | undefined;
	private sources: ExtensionRegistrySources | undefined;
	private message = '';
	private visible = false;
	private busy = false;
	private readVersion = 0;

	constructor(
		@IExtensionManagementService private readonly management: IExtensionManagementService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(management.onDidChangeInstalled(() => { if (this.visible && !this.busy) { void this.refresh(); } }));
		this._register(toDisposable(() => { this.readVersion++; }));
	}

	public get fields(): readonly SettingsSectionField[] {
		const enabled = !this.busy && !!this.snapshot?.canManage && !this.snapshot.checking;
		return [
			{ id: 'update-status', kind: 'status', text: this.updateStatus() },
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
			{ id: 'sources-status', kind: 'status', text: this.sources?.sources.map(source => localize({ bundle: 'ash.extensions', key: 'sourceSettingsSummary' }, '{0}: {1}', source.id, source.enabled ? localize({ bundle: 'ash.extensions', key: 'sourceSettingsEnabled' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'sourceSettingsPaused' }, 'Paused'))).join('\n') ?? '' },
			{
				id: 'check-updates', kind: 'action', enabled,
				label: localize({ bundle: 'ash.extensions', key: 'checkUpdatesTitle' }, 'Check for extension updates'),
				run: () => this.perform(async () => { this.snapshot = await this.management.checkForUpdates(); }),
			},
			{
				id: 'manage-sources', kind: 'action', enabled,
				label: localize({ bundle: 'ash.extensions', key: 'manageSources' }, 'Manage extension sources'),
				run: () => this.perform(async () => { await this.commands.executeCommand('ash.extensions.manageSources'); }),
			},
			{
				id: 'restore-notifications', kind: 'action', enabled: !this.busy,
				label: localize({ bundle: 'ash.extensions', key: 'restoreRecommendationNotifications' }, 'Restore dismissed extension recommendation notifications'),
				run: () => this.perform(async () => {
					await this.commands.executeCommand('ash.extensions.resetRecommendationNotifications');
					this.message = localize({ bundle: 'ash.extensions', key: 'recommendationNotificationsRestored' }, 'Dismissed recommendation notifications were restored. Recommendation preferences still apply.');
				}),
			},
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
		const status = [this.snapshot.lastCheckedAt === undefined
			? localize({ bundle: 'ash.extensions', key: 'updatesNotChecked' }, 'Extensions have not been checked for updates yet.')
			: localize({ bundle: 'ash.extensions', key: 'updatesSummary' }, '{0} available updates; {1} packages updated; {2} packages could not be checked or updated.', this.snapshot.available.length, this.snapshot.updated.length, this.snapshot.failures.length)];
		if (this.snapshot.lastCheckedAt !== undefined) { status.push(localize({ bundle: 'ash.extensions', key: 'updatesLastChecked' }, 'Last checked: {0}.', new Date(this.snapshot.lastCheckedAt).toLocaleString(getNLSLanguage()))); }
		if (!this.snapshot.canManage) { status.push(localize({ bundle: 'ash.extensions', key: 'updatesReadOnly' }, 'This connection can read extension update settings. Use an authorized desktop or remote host to change them.')); }
		status.push(...this.snapshot.available.map(update => localize({ bundle: 'ash.extensions', key: 'updateAvailablePackage' }, '{0}: {1} → {2}', update.current.id, update.current.version, update.available.version)));
		if (this.snapshot.failures.length) { status.push(localize({ bundle: 'ash.extensions', key: 'updatesFailedPackages' }, 'Check the connection and extension sources, then retry: {0}', this.snapshot.failures.join(', '))); }
		return status.join('\n');
	}

	private async setPolicy(policy: ExtensionUpdatePolicy): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot || this.busy || !snapshot.canManage) { return; }
		await this.perform(async () => { this.snapshot = await this.management.setUpdatePolicy(policy, snapshot.revision); });
	}

	private async refresh(): Promise<void> {
		const version = ++this.readVersion;
		try {
			const [snapshot, sources] = await Promise.all([this.management.updates(), this.management.sources()]);
			if (this.isDisposed || version !== this.readVersion) { return; }
			this.snapshot = snapshot;
			this.sources = sources;
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
