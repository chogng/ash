import { ILocalizationService } from '../../../../workbench/services/localization/common/localizationService.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IDirPermissionsService, dirPermissionNames, type DirPermission, type DirPermissionsSnapshot } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExecutionSettingsService, type ExecutionSettings, type ExecutionSettingsSnapshot } from '../../../../platform/execution/common/executionSettingsService.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../platform/sessions/common/approvalModes.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';

const readPermissions: readonly DirPermission[] = ['readFiles', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository'];
const writePermissions: readonly DirPermission[] = [...readPermissions, 'writeFiles', 'mutateRepository'];
const commandPermissions: readonly DirPermission[] = [...writePermissions, 'executeCommands'];

/** Only UI drafts live here. Defaults and directory grants retain their existing backend owners and revisions. */
export class ExecutionSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'execution-permissions';
	get title(): string { return localize({ bundle: 'ash.settings', key: 'execution.title' }, 'Execution and permissions'); }
	get description(): string { return localize({ bundle: 'ash.settings', key: 'execution.description' }, 'Defaults for ordinary chats and Symphony. Directory grants control which host directories tools can access.'); }
	get help(): string { return localize({ bundle: 'ash.settings', key: 'execution.help' }, 'Execution and permissions settings\nUse Tab to choose the default approval mode, command file access and command network access, then Save execution defaults. New chats and workflows without an explicit approval mode inherit this default. Conversation choices and workflow approval settings override it. Command defaults apply after backend reload to newly prepared commands; running commands are not stopped. Approval or configured execution rules may permit broader command access. Directory grants remain required. Managed network rules still apply. On a trusted desktop host, enter an absolute directory path, choose its file and command permissions and Save directory permissions. Other directory capabilities are preserved. Select a saved directory to review or revoke its grant. Revocation blocks subsequent operations after backend reload; it does not stop already running commands. Web connections can show execution defaults but cannot grant host directory access. Refresh discards drafts. Changes elsewhere require refreshing before saving. Closing settings releases listeners and ignores late results. Escape closes this help and returns focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private snapshot: ExecutionSettingsSnapshot | undefined;
	private directories: DirPermissionsSnapshot | undefined;
	private draft: ExecutionSettings = { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' };
	private path = '';
	private access = 'read';
	private visible = false;
	private busy = false;
	private dirty = false;
	private directoryDirty = false;
	private stale = false;
	private generation = 0;
	private savedText = '';
	private message = '';

	constructor(
		@IExecutionSettingsService private readonly execution: IExecutionSettingsService,
		@IDirPermissionsService private readonly permissions: IDirPermissionsService,
		@IAgentCapabilitiesService private readonly capabilities: IAgentCapabilitiesService,
		@IRemoteAgentService private readonly remote: IRemoteAgentService,
		@IDialogService private readonly dialogs: IDialogService,
		@ILocalizationService private readonly localization: ILocalizationService,
	) {
		super();
		const changed = (): void => {
			if (!this.visible || this.busy) return;
			if (this.dirty || this.directoryDirty) {
				this.stale = true;
				this.message = localize({ bundle: 'ash.settings', key: 'execution.changed' }, 'Backend settings changed. Refresh before saving; refresh discards drafts.');
				this.changed.fire();
			} else { void this.refresh(); }
		};
		this._register(execution.onDidChange(changed));
		this._register(permissions.onDidChangePermissions(changed));
		const connectionChanged = (): void => {
			this.generation++; this.snapshot = undefined; this.directories = undefined; this.dirty = false; this.directoryDirty = false; this.busy = false; this.message = ''; this.savedText = ''; this.path = '';
			if (this.visible) void this.refresh();
		};
		this._register(remote.onDidChangeConnection(connectionChanged));
		this._register(remote.onDidChangeConnectionState(connectionChanged));
	}

	get fields(): readonly SettingsSectionField[] {
		const editable = !!this.snapshot && !this.busy && this.remote.connectionState === 'connected';
		const directoryEditable = editable && !!this.directories;
		return [
			{ id: 'approval', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.approval' }, 'Default approval mode'), value: this.draft.approvalMode, options: approvalModeDefinitions.map(mode => ({ value: mode.id, label: localize(mode.label.key, mode.label.text) })), enabled: editable, setValue: value => { const mode = approvalModeDefinitions.find(mode => mode.id === value); if (mode) this.edit({ ...this.draft, approvalMode: mode.id }); } },
			{ id: 'approval-description', kind: 'status', text: localize(approvalModeDefinition(this.draft.approvalMode).description.key, approvalModeDefinition(this.draft.approvalMode).description.text) },
			{ id: 'files', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.files' }, 'Command file access'), value: this.draft.commandFileAccess, options: [{ value: 'readOnly', label: localize({ bundle: 'ash.settings', key: 'execution.readOnly' }, 'Read only') }, { value: 'directoryWrite', label: localize({ bundle: 'ash.settings', key: 'execution.directoryWrite' }, 'Write in authorized directories') }], enabled: editable, setValue: value => { if (value === 'readOnly' || value === 'directoryWrite') this.edit({ ...this.draft, commandFileAccess: value }); } },
			{ id: 'network', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.network' }, 'Command network access'), value: this.draft.commandNetworkAccess, options: [{ value: 'denied', label: localize({ bundle: 'ash.settings', key: 'execution.denied' }, 'Blocked') }, { value: 'allowed', label: localize({ bundle: 'ash.settings', key: 'execution.allowed' }, 'Allowed') }], enabled: editable, setValue: value => { if (value === 'denied' || value === 'allowed') this.edit({ ...this.draft, commandNetworkAccess: value }); } },
			{ id: 'saved', kind: 'status', text: this.savedText },
			{ id: 'application', kind: 'status', text: localize({ bundle: 'ash.settings', key: 'execution.application' }, 'New chats and workflows inherit approval unless overridden. Command defaults apply to newly prepared commands after backend reload. Running commands continue. Approval and execution rules may permit broader command access; directory grants and managed network rules still apply.') },
			{ id: 'save', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'execution.save' }, 'Save execution defaults'), enabled: editable && this.dirty && !this.stale, run: () => this.saveDefaults() },
			{ id: 'directories', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.directories' }, 'Saved directory grants'), value: this.directories?.entries.find(entry => entry.path === this.path)?.dir, options: this.directories?.entries.map(entry => ({ value: entry.dir, label: entry.path ?? entry.dir })) ?? [], enabled: directoryEditable, setValue: value => { const entry = this.directories?.entries.find(entry => entry.dir === value); if (entry?.path) this.selectDirectory(entry.path); } },
			{ id: 'directory', kind: 'text', label: localize({ bundle: 'ash.settings', key: 'execution.directory' }, 'Directory path on the App Server host'), value: this.path, placeholder: localize({ bundle: 'ash.settings', key: 'execution.pathPlaceholder' }, 'Absolute directory path'), enabled: directoryEditable, setValue: value => { this.path = value; this.directoryDirty = true; this.changed.fire(); } },
			{ id: 'directory-access', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.directoryAccess' }, 'Directory file and command permissions'), value: this.access, options: [{ value: 'read', label: localize({ bundle: 'ash.settings', key: 'execution.readOnly' }, 'Read only') }, { value: 'write', label: localize({ bundle: 'ash.settings', key: 'execution.readWrite' }, 'Read and write') }, { value: 'commands', label: localize({ bundle: 'ash.settings', key: 'execution.readWriteCommands' }, 'Read, write and run commands') }, { value: 'custom', label: localize({ bundle: 'ash.settings', key: 'execution.custom' }, 'Custom saved permissions') }], enabled: directoryEditable, setValue: value => { this.access = value; this.directoryDirty = true; this.changed.fire(); } },
			{ id: 'directory-current', kind: 'status', text: this.directoryText() },
			{ id: 'save-directory', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'execution.saveDirectory' }, 'Save directory permissions'), enabled: directoryEditable && this.directoryDirty && !!this.path.trim() && this.access !== 'custom' && !this.stale, run: () => this.saveDirectory(false) },
			{ id: 'revoke-directory', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'execution.revokeDirectory' }, 'Revoke directory grant'), enabled: directoryEditable && !!this.directories?.entries.some(entry => entry.path === this.path) && !this.stale, run: () => this.saveDirectory(true) },
			{ id: 'directory-scope', kind: 'status', text: localize({ bundle: 'ash.settings', key: 'execution.directoryScope' }, 'Directory changes preserve instruction, configuration, skill, plugin and other discovery permissions. Revocation blocks subsequent operations after backend reload; running commands continue. Directory grants can only be edited through a trusted desktop host.') },
			{ id: 'refresh', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'execution.refresh' }, 'Refresh'), enabled: !this.busy, run: () => this.refresh() },
			{ id: 'status', kind: 'status', text: this.busy ? localize({ bundle: 'ash.settings', key: 'execution.busy' }, 'Reading or saving execution settings…') : this.message },
		];
	}

	setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		if (visible) void this.refresh();
		else { this.generation++; this.busy = false; }
	}

	private edit(draft: ExecutionSettings): void { this.draft = draft; this.dirty = true; this.changed.fire(); }
	private current(generation: number): boolean { return !this.isDisposed && this.visible && generation === this.generation; }
	private selectDirectory(path: string): void {
		this.path = path;
		const permissions = this.directories?.entries.find(entry => entry.path === path)?.permissions ?? [];
		this.access = 'custom';
		for (const [access, preset] of [['read', readPermissions], ['write', writePermissions], ['commands', commandPermissions]] as const) {
			if (commandPermissions.every(permission => permissions.includes(permission) === preset.includes(permission))) this.access = access;
		}
		this.directoryDirty = false;
		this.changed.fire();
	}
	private directoryText(): string {
		if (!this.directories) return localize({ bundle: 'ash.settings', key: 'execution.directoryUnavailable' }, 'Directory grants require a connected trusted desktop host.');
		const entry = this.directories.entries.find(entry => entry.path === this.path);
		return entry ? localize({ bundle: 'ash.settings', key: 'execution.directoryCurrent' }, 'Saved capabilities: {0}', entry.permissions.map(permission => this.localization.translate('ash.settings', `capabilities.permission.${permission}`, dirPermissionNames[permission])).join(', ')) : localize({ bundle: 'ash.settings', key: 'execution.directoryNew' }, 'No saved grant selected. Enter a directory to grant file and command access.');
	}
	private async refresh(preserveDrafts = false): Promise<void> {
		if (!this.visible || this.remote.connectionState !== 'connected') { this.changed.fire(); return; }
		const generation = ++this.generation;
		this.busy = true; this.message = ''; this.changed.fire();
		try {
			const [snapshot, catalog] = await Promise.all([this.execution.read(), this.capabilities.read()]);
			const directories = catalog.directoryGrantsReadable ? await this.permissions.list() : undefined;
			if (!this.current(generation)) return;
			const draft = this.draft; const dirty = this.dirty; const directoryDirty = this.directoryDirty;
			this.snapshot = snapshot; this.draft = snapshot.settings; this.directories = directories;
			this.savedText = localize({ bundle: 'ash.settings', key: 'execution.saved' }, 'Saved defaults: approval {0}; command files {1}; command network {2}.', localize(approvalModeDefinition(snapshot.settings.approvalMode).label.key, approvalModeDefinition(snapshot.settings.approvalMode).label.text), snapshot.settings.commandFileAccess === 'readOnly' ? localize({ bundle: 'ash.settings', key: 'execution.readOnly' }, 'Read only') : localize({ bundle: 'ash.settings', key: 'execution.directoryWrite' }, 'Write in authorized directories'), snapshot.settings.commandNetworkAccess === 'denied' ? localize({ bundle: 'ash.settings', key: 'execution.denied' }, 'Blocked') : localize({ bundle: 'ash.settings', key: 'execution.allowed' }, 'Allowed'));
			this.dirty = false; this.directoryDirty = false; this.stale = false;
			if (!preserveDrafts || !directoryDirty) {
				if (directories?.entries.some(entry => entry.path === this.path)) this.selectDirectory(this.path);
			}
			if (preserveDrafts) { if (dirty) { this.draft = draft; this.dirty = true; } this.directoryDirty = directoryDirty; }
		} catch (error) {
			if (!this.current(generation)) return;
			this.snapshot = undefined; this.directories = undefined;
			this.message = localize({ bundle: 'ash.settings', key: 'execution.readFailed' }, 'Could not read execution settings: {0}', String(error));
		} finally { if (this.current(generation)) { this.busy = false; this.changed.fire(); } }
	}
	private async saveDefaults(): Promise<void> {
		if (!this.snapshot || this.busy || this.stale || !this.dirty) return;
		const generation = ++this.generation;
		const snapshot = this.snapshot; const draft = this.draft;
		this.busy = true; this.changed.fire();
		try {
			if (draft.approvalMode !== snapshot.settings.approvalMode && approvalModeDefinition(draft.approvalMode).requiresConfirmation) {
				const result = await this.dialogs.confirm({ message: localize({ bundle: 'ash.settings', key: 'execution.confirmBypass' }, 'Skip most approvals by default?'), detail: localize({ bundle: 'ash.settings', key: 'execution.confirmBypassDetail' }, 'New chats and workflows may change files and perform external actions without asking. Directory and network access limits still apply.'), primaryButton: localize({ bundle: 'ash.settings', key: 'execution.save' }, 'Save execution defaults') });
				if (!this.current(generation) || !result.confirmed) return;
			}
			await this.execution.configure(draft, snapshot.revision);
			if (this.current(generation)) { this.dirty = false; await this.refresh(true); }
		} catch (error) { if (this.current(generation)) this.saveFailed(error); }
		finally { if (this.current(generation)) { this.busy = false; this.changed.fire(); } }
	}
	private async saveDirectory(revoke: boolean): Promise<void> {
		if (!this.directories || this.busy || this.stale) return;
		const generation = ++this.generation;
		const directories = this.directories; const path = this.path.trim();
		this.busy = true; this.changed.fire();
		try {
			const resolved = await this.permissions.resolve(path);
			if (!this.current(generation)) return;
			const entry = directories.entries.find(entry => entry.dir === resolved.dir);
			if (revoke) { if (entry) await this.permissions.forget(entry.dir, directories.revision); }
			else {
				const preset = this.access === 'commands' ? commandPermissions : this.access === 'write' ? writePermissions : readPermissions;
				const retained = entry?.permissions.filter(permission => !commandPermissions.includes(permission)) ?? [];
				await this.permissions.set(path, [...preset, ...retained], directories.revision);
			}
			if (this.current(generation)) {
				this.directoryDirty = false;
				const refreshedGeneration = this.generation + 1;
				await this.refresh(true);
				if (!this.current(refreshedGeneration)) return;
				const canonical = this.directories?.entries.find(entry => entry.dir === resolved.dir)?.path;
				if (!this.isDisposed && this.visible && canonical) this.selectDirectory(canonical);
			}
		} catch (error) { if (this.current(generation)) this.saveFailed(error); }
		finally { if (this.current(generation)) { this.busy = false; this.changed.fire(); } }
	}
	private saveFailed(error: unknown): void { this.stale = true; this.message = localize({ bundle: 'ash.settings', key: 'execution.saveFailed' }, 'Could not save settings. Refresh before trying again: {0}', String(error)); }
}
