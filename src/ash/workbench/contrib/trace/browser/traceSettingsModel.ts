import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ITraceSettingsService, type TraceSettingsSnapshot } from '../../../../platform/trace/common/traceSettingsService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../preferences/browser/settingsTreeModels.js';

/** Keeps only an unsaved draft; the connected backend owns configuration and recording state. */
export class TraceSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'execution-trace';
	public get title(): string { return localize({ bundle: 'ash.settings', key: 'trace.title' }, 'Execution trace'); }
	public get description(): string { return localize({ bundle: 'ash.settings', key: 'trace.description' }, 'Manage local request and response recording for the connected App Server profile. Execution history remains available when detailed recording is off.'); }
	public get help(): string { return localize({ bundle: 'ash.settings', key: 'trace.help' }, 'Execution trace settings\nUse Tab to toggle detailed recording, enter an absolute directory on the App Server host, and save. Choose directory is available for a local connection. Save changes the backend profile configuration; restart the owning App Server to apply it. Restarting only the window may reuse the existing server. Current recording state describes the running backend, independently of unsaved or saved changes. Refresh reloads saved configuration and discards your draft. Requests and responses can contain user, instruction, attachment and tool content. Recording stays on the server host without uploading. It covers Agent, compaction and auxiliary tool model attempts, not HTTP bytes, individual streaming chunks or every internal model call. Capture limits and storage faults can omit evidence; inspect each conversation trace for completeness. Closing this page releases its listeners and ignores late results. Escape closes this help and returns focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: TraceSettingsSnapshot | undefined;
	private enabled = false;
	private directory = '';
	private visible = false;
	private busy = false;
	private dirty = false;
	private stale = false;
	private revision = 0;
	private message = '';

	constructor(
		@ITraceSettingsService private readonly trace: ITraceSettingsService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
	) {
		super();
		this._register(trace.onDidChange(() => {
			if (!this.visible || this.busy) { return; }
			if (this.dirty) {
				this.stale = true;
				this.message = localize({ bundle: 'ash.settings', key: 'trace.changed' }, 'Backend settings changed. Refresh before saving; refresh discards your draft.');
				this.changed.fire();
			} else { void this.refresh(); }
		}));
		this._register(remote.onDidChangeConnection(() => this.connectionChanged()));
		this._register(remote.onDidChangeConnectionState(() => this.connectionChanged()));
	}

	public get fields(): readonly SettingsSectionField[] {
		const connected = this.remote.connectionState === 'connected';
		const editable = connected && !!this.snapshot && !this.busy;
		return [
			{ id: 'current', kind: 'status', text: this.recordingText() },
			{ id: 'enabled', kind: 'boolean', label: localize({ bundle: 'ash.settings', key: 'trace.enabled' }, 'Record detailed requests and responses'), value: this.enabled, enabled: editable, setValue: value => { this.enabled = value; this.edit(); } },
			{ id: 'directory', kind: 'text', label: localize({ bundle: 'ash.settings', key: 'trace.directory' }, 'Save directory on the App Server host'), value: this.directory, placeholder: localize({ bundle: 'ash.settings', key: 'trace.directoryPlaceholder' }, 'Absolute directory path'), enabled: editable, setValue: value => { this.directory = value; this.edit(); } },
			{ id: 'choose', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'trace.choose' }, 'Choose directory'), enabled: editable && this.remote.connection?.kind === 'local', run: () => this.chooseDirectory() },
			{ id: 'save', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'trace.save' }, 'Save trace settings'), enabled: editable && this.dirty && !this.stale, run: () => this.save() },
			{ id: 'refresh', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'trace.refresh' }, 'Refresh'), enabled: !this.busy, run: () => this.refresh() },
			{ id: 'application', kind: 'status', text: this.applicationText() },
			{ id: 'scope', kind: 'status', text: localize({ bundle: 'ash.settings', key: 'trace.scope' }, 'Records Agent, compaction and auxiliary tool model requests and responses locally. Content may include user messages, instructions, attachments and tool results. HTTP bytes, individual streaming chunks and other internal model calls are not recorded. Each payload is limited to 8 MiB; each capture to 128 MiB and 32,000 events. Check conversation traces for omissions and storage failures.') },
			{ id: 'status', kind: 'status', text: this.busy ? localize({ bundle: 'ash.settings', key: 'trace.busy' }, 'Reading or saving trace settings…') : this.message },
		];
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		if (visible) { void this.refresh(); }
		else { this.revision++; this.busy = false; }
	}

	private connectionChanged(): void {
		this.revision++;
		this.snapshot = undefined;
		this.busy = false;
		this.enabled = false;
		this.directory = '';
		this.dirty = false;
		this.message = '';
		if (this.visible) { void this.refresh(); }
	}

	private edit(): void {
		this.dirty = true;
		if (!this.stale) { this.message = localize({ bundle: 'ash.settings', key: 'trace.unsaved' }, 'Unsaved changes. Save, then restart the owning App Server to apply them.'); }
		this.changed.fire();
	}

	private recordingText(): string {
		if (!this.snapshot) { return localize({ bundle: 'ash.settings', key: 'trace.unknown' }, 'Current recording state is unavailable. Connect to App Server and refresh.'); }
		const state = this.snapshot.recording;
		switch (state.type) {
			case 'disabled': return localize({ bundle: 'ash.settings', key: 'trace.disabled' }, 'Current backend: detailed recording is off.');
			case 'enabled': return localize({ bundle: 'ash.settings', key: 'trace.recording' }, 'Current backend: detailed recording is enabled in {0}.', state.directory);
			case 'unavailable': return localize({ bundle: 'ash.settings', key: 'trace.unavailable' }, 'Current backend: recording directory {0} is unavailable: {1}', state.directory, state.error);
		}
	}

	private applicationText(): string {
		const snapshot = this.snapshot;
		if (!snapshot) { return ''; }
		const configured = snapshot.configured;
		if (!configured) { return localize({ bundle: 'ash.settings', key: 'trace.launch' }, 'No saved trace preference. The current backend uses its launch configuration. Saving overrides that configuration, including when recording is off.'); }
		const recording = snapshot.recording;
		const applied = configured.enabled ? recording.type !== 'disabled' && configured.directory === recording.directory : recording.type === 'disabled';
		return applied
			? localize({ bundle: 'ash.settings', key: 'trace.applied' }, 'Saved settings match the running backend. Future changes require restarting the owning App Server; reopening the window may reuse it. Earlier missing requests cannot be recovered.')
			: localize({ bundle: 'ash.settings', key: 'trace.restart' }, 'Saved settings require restarting the owning App Server. The current backend still uses the recording state shown above. Reopening the window may reuse it; earlier missing requests cannot be recovered.');
	}

	private async refresh(): Promise<void> {
		if (!this.visible || this.remote.connectionState !== 'connected') { this.changed.fire(); return; }
		const revision = ++this.revision;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try {
			const snapshot = await this.trace.read();
			if (this.isDisposed || !this.visible || revision !== this.revision) { return; }
			this.snapshot = snapshot;
			this.enabled = snapshot.configured?.enabled ?? snapshot.recording.type !== 'disabled';
			this.directory = snapshot.configured ? snapshot.configured.directory ?? '' : snapshot.recording.type === 'disabled' ? '' : snapshot.recording.directory;
			this.dirty = false;
			this.stale = false;
		} catch {
			if (this.isDisposed || revision !== this.revision) { return; }
			this.snapshot = undefined;
			this.message = localize({ bundle: 'ash.settings', key: 'trace.readFailed' }, 'Could not read trace settings. Connect to App Server and refresh.');
		} finally {
			if (!this.isDisposed && revision === this.revision) { this.busy = false; this.changed.fire(); }
		}
	}

	private async save(): Promise<void> {
		if (!this.snapshot || this.busy || this.stale || !this.dirty || !this.visible) { return; }
		const directory = this.directory.trim();
		if (this.enabled && !directory) {
			this.message = localize({ bundle: 'ash.settings', key: 'trace.required' }, 'Enter an absolute save directory before enabling detailed recording.');
			this.changed.fire();
			return;
		}
		const revision = ++this.revision;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try {
			await this.trace.configure({ enabled: this.enabled, directory: directory || null }, this.snapshot.revision);
			if (this.isDisposed || !this.visible || revision !== this.revision) { return; }
			await this.refresh();
		} catch {
			if (this.isDisposed || revision !== this.revision) { return; }
			this.message = localize({ bundle: 'ash.settings', key: 'trace.saveFailed' }, 'Could not save trace settings. Use an absolute directory on the App Server host. If settings changed elsewhere, refresh before saving again.');
		} finally {
			if (!this.isDisposed && revision === this.revision) { this.busy = false; this.changed.fire(); }
		}
	}

	private async chooseDirectory(): Promise<void> {
		if (!this.visible || this.busy || this.remote.connection?.kind !== 'local') { return; }
		const revision = ++this.revision;
		this.busy = true;
		this.changed.fire();
		try {
			const selected = await this.dialogs.showOpenDialog({ title: localize({ bundle: 'ash.settings', key: 'trace.choose' }, 'Choose directory'), canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
			if (this.isDisposed || !this.visible || revision !== this.revision || !selected?.[0]) { return; }
			this.directory = selected[0].fsPath;
			this.edit();
		} catch {
			if (this.isDisposed || revision !== this.revision) { return; }
			this.message = localize({ bundle: 'ash.settings', key: 'trace.chooseFailed' }, 'Could not choose a directory. Enter an absolute path on the App Server host.');
		} finally {
			if (!this.isDisposed && revision === this.revision) { this.busy = false; this.changed.fire(); }
		}
	}
}
