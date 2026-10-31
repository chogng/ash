import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentExecutionSettingsService, type ExecutionSettings, type ExecutionSettingsSnapshot } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';

/** Edits command defaults in the backend profile; grants and effective policy stay backend-owned. */
export class SandboxSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'sandbox';
	get title(): string { return localize({ bundle: 'ash.settings', key: 'sandbox.title' }, 'Sandbox'); }
	get description(): string { return localize({ bundle: 'ash.settings', key: 'sandbox.description' }, 'Set file and network access defaults for Agent commands on the connected host.'); }
	get help(): string { return localize({ bundle: 'ash.settings', key: 'sandbox.help' }, 'Sandbox settings\nUse Tab to choose command file and network access, then Save sandbox defaults. These controls save backend profile defaults. Named permission profiles, managed constraints, directory grants, execution rules and approvals determine effective access. The diagnostics below describe the running backend. Running commands are unchanged. Workbench terminals use a separate host execution path. Refresh discards unsaved changes. Changes from another window require refreshing before saving. Escape closes this help and returns focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private snapshot: ExecutionSettingsSnapshot | undefined;
	private draft: ExecutionSettings | undefined;
	private visible = false;
	private busy = false;
	private dirty = false;
	private stale = false;
	private refreshRequested = false;
	private generation = 0;
	private message = '';

	constructor(
		@IAgentExecutionSettingsService private readonly execution: IAgentExecutionSettingsService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) {
		super();
		this._register(execution.onDidChange(() => {
			if (!this.visible) return;
			if (this.busy) { this.refreshRequested = true; return; }
			if (this.dirty) {
				this.stale = true;
				this.message = localize({ bundle: 'ash.settings', key: 'sandbox.changed' }, 'Backend settings changed. Refresh before saving; refresh discards your draft.');
				this.changed.fire();
			} else { void this.refresh(); }
		}));
		const connectionChanged = (): void => {
			this.generation++;
			this.snapshot = this.draft = undefined;
			this.dirty = this.stale = this.busy = false;
			this.message = '';
			if (this.visible) void this.refresh();
		};
		this._register(remote.onDidChangeConnection(connectionChanged));
		this._register(remote.onDidChangeConnectionState(connectionChanged));
	}

	get fields(): readonly SettingsSectionField[] {
		const editable = !!this.snapshot && !this.busy && this.remote.connectionState === 'connected';
		return [
			{ id: 'files', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.files' }, 'Command file access'), value: this.draft?.commandFileAccess ?? 'readOnly', options: [{ value: 'readOnly', label: localize({ bundle: 'ash.settings', key: 'execution.readOnly' }, 'Read only') }, { value: 'directoryWrite', label: localize({ bundle: 'ash.settings', key: 'execution.directoryWrite' }, 'Write in authorized directories') }], enabled: editable, setValue: value => { if (this.draft && (value === 'readOnly' || value === 'directoryWrite')) this.edit({ ...this.draft, commandFileAccess: value }); } },
			{ id: 'network', kind: 'select', label: localize({ bundle: 'ash.settings', key: 'execution.network' }, 'Command network access'), value: this.draft?.commandNetworkAccess ?? 'denied', options: [{ value: 'denied', label: localize({ bundle: 'ash.settings', key: 'execution.denied' }, 'Blocked') }, { value: 'allowed', label: localize({ bundle: 'ash.settings', key: 'execution.allowed' }, 'Allowed') }], enabled: editable, setValue: value => { if (this.draft && (value === 'denied' || value === 'allowed')) this.edit({ ...this.draft, commandNetworkAccess: value }); } },
			{ id: 'save', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'sandbox.save' }, 'Save sandbox defaults'), enabled: editable && this.dirty && !this.stale, run: () => this.save() },
			{ id: 'refresh', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'execution.refresh' }, 'Refresh'), enabled: !this.busy, run: () => this.refresh() },
			{ id: 'scope', kind: 'status', text: localize({ bundle: 'ash.settings', key: 'sandbox.scope' }, 'Saved defaults apply to newly prepared Agent commands after backend reload. A selected permission profile overrides these defaults; managed constraints and directory grants still apply. Approvals and execution rules can change individual requests. Workbench terminals are separate. Running commands are not stopped.') },
			{ id: 'status', kind: 'status', text: this.message },
		];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.refresh();
		else { this.generation++; this.busy = false; }
	}

	private current(generation: number): boolean { return !this.isDisposed && this.visible && this.generation === generation; }
	private edit(draft: ExecutionSettings): void { this.draft = draft; this.dirty = true; this.changed.fire(); }
	private async refresh(): Promise<void> {
		if (!this.visible || this.remote.connectionState !== 'connected') { this.changed.fire(); return; }
		const generation = ++this.generation;
		this.busy = true; this.message = ''; this.changed.fire();
		try {
			do {
				this.refreshRequested = false;
				const snapshot = await this.execution.read();
				if (!this.current(generation)) return;
				this.snapshot = snapshot; this.draft = snapshot.settings;
			} while (this.refreshRequested);
			this.dirty = this.stale = false;
		} catch (error) {
			if (this.current(generation)) { this.snapshot = undefined; this.message = localize({ bundle: 'ash.settings', key: 'sandbox.readFailed' }, 'Could not read sandbox defaults: {0}', String(error)); }
		} finally { if (this.current(generation)) { this.busy = false; this.changed.fire(); } }
	}

	private async save(): Promise<void> {
		if (!this.snapshot || !this.draft || this.busy || this.stale || !this.dirty) return;
		const generation = ++this.generation;
		this.busy = true; this.changed.fire();
		try {
			// Preserve the approval mode from the same revision; conflicts are never retried silently.
			await this.execution.configure(this.draft, this.snapshot.revision);
			if (this.current(generation)) await this.refresh();
		} catch (error) {
			if (this.current(generation)) { this.stale = true; this.message = localize({ bundle: 'ash.settings', key: 'sandbox.saveFailed' }, 'Could not save sandbox defaults. Refresh before trying again: {0}', String(error)); }
		} finally { if (this.current(generation)) { this.busy = false; this.changed.fire(); } }
	}
}
