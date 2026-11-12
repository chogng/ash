import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILanguageServerService, type LanguageServerEnablement, type LanguageServerEnablementScope } from '../../../../platform/language/common/languageServerService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../../workbench/services/preferences/common/preferences.js';
import { IAppServerRemoteAgentService } from '../../../../workbench/services/remote/common/appServerRemoteAgentService.js';

export class LspSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'code-intelligence';
	readonly groupId = null;
	readonly itemId = 'languageServers.enabled';
	readonly keywords = ['lsp', 'language servers', 'worktrees'];
	readonly description = '';

	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private visible = false;
	private version = 0;
	private snapshot: LanguageServerEnablement | undefined;
	private saving = false;
	private message = '';

	constructor(
		@ILanguageServerService private readonly servers: ILanguageServerService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) {
		super();
		this._register(servers.onDidChangeConfig(() => {
			if (!this.saving) { void this.refresh(); }
		}));
		this._register(remote.onDidChangeConnection(() => this.reset()));
		this._register(remote.onDidChangeConnectionState(() => this.reset()));
	}

	get title(): string {
		return localize({ bundle: 'ash.settings', key: 'lsp.enablement.title' }, 'LSP');
	}

	get help(): string {
		return localize({ bundle: 'ash.settings', key: 'lsp.enablement.help' }, 'LSP settings\nPress Tab to move between switches and Space to toggle. Enable LSPs controls all language servers in the connected App Server profile. Enable LSPs for Worktrees controls Agent worktrees while Enable LSPs is on. Turning off a switch stops the language servers it controls. Escape closes help and returns focus.');
	}

	get fields(): readonly SettingsSectionField[] {
		return [{
			id: 'enabled', kind: 'boolean',
			label: localize({ bundle: 'ash.settings', key: 'lsp.enablement.label' }, 'Enable LSPs'),
			description: localize({ bundle: 'ash.settings', key: 'lsp.enablement.description' }, 'Use language servers for code features in this App Server profile.'),
			value: this.snapshot?.enabled ?? false, enabled: !!this.snapshot && !this.saving,
			setValue: value => { void this.setEnabled(value, 'all'); },
		}, {
			id: 'worktrees-enabled', kind: 'boolean',
			label: localize({ bundle: 'ash.settings', key: 'lsp.enablement.worktreesLabel' }, 'Enable LSPs for Worktrees'),
			description: localize({ bundle: 'ash.settings', key: 'lsp.enablement.worktreesDescription' }, 'Use language servers in Agent worktrees. Requires Enable LSPs.'),
			value: this.snapshot?.worktreesEnabled ?? false,
			enabled: this.snapshot?.enabled === true && this.snapshot.worktreesEnabled !== undefined && !this.saving,
			setValue: value => { void this.setEnabled(value, 'worktrees'); },
		}, { id: 'status', kind: 'status', text: this.message }];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.reset();
	}

	private reset(): void {
		this.version++;
		this.snapshot = undefined;
		this.saving = false;
		this.message = '';
		if (this.visible) { void this.refresh(); }
	}

	private async refresh(message = ''): Promise<void> {
		if (!this.visible) { return; }
		if (this.remote.connectionState !== 'connected') {
			this.message = localize({ bundle: 'ash.settings', key: 'lsp.enablement.disconnected' }, 'Connect to App Server to edit LSP settings.');
			this.changed.fire();
			return;
		}
		const version = ++this.version;
		if (!this.snapshot) {
			this.message = localize({ bundle: 'ash.settings', key: 'lsp.enablement.loading' }, 'Loading LSP settings…');
			this.changed.fire();
		}
		try {
			const snapshot = await this.servers.readEnablement();
			if (!this.isCurrent(version)) { return; }
			this.snapshot = snapshot;
			this.message = snapshot ? message : localize({ bundle: 'ash.settings', key: 'lsp.enablement.unavailable' }, 'LSP settings are unavailable on this App Server.');
		} catch {
			if (!this.isCurrent(version)) { return; }
			this.snapshot = undefined;
			this.message = localize({ bundle: 'ash.settings', key: 'lsp.enablement.readFailed' }, 'Could not read LSP settings.');
		}
		this.saving = false;
		this.changed.fire();
	}

	private async setEnabled(enabled: boolean, scope: LanguageServerEnablementScope): Promise<void> {
		const snapshot = this.snapshot;
		if (!this.visible || !snapshot || this.saving) { return; }
		const current = scope === 'all' ? snapshot.enabled : snapshot.enabled ? snapshot.worktreesEnabled : undefined;
		if (current === undefined || current === enabled) { return; }
		const version = ++this.version;
		this.saving = true;
		this.message = '';
		this.changed.fire();
		let message = '';
		try {
			await this.servers.setEnabled(enabled, snapshot.revision, scope);
		} catch {
			message = localize({ bundle: 'ash.settings', key: 'lsp.enablement.saveFailed' }, 'Could not save LSP settings.');
		}
		if (!this.isCurrent(version)) { return; }
		// Keep the switch disabled until it shows the authoritative value, including after a conflict.
		await this.refresh(message);
	}

	private isCurrent(version: number): boolean {
		return !this.isDisposed && this.visible && this.version === version;
	}
}
