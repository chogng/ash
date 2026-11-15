import { IBufferCollabService, BufferCollabState, type BufferCollabSession } from '../../../../../workbench/services/collab/common/bufferCollabService.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { h, type IDimension } from '../../../../../base/browser/dom.js';
import { type IAction } from '../../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { EditorWorkingCopy } from '../../../../../workbench/browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../../workbench/common/editor.js';
import { IFilesConfigurationService } from '../../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { ITextModelResourceService } from '../../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { TextFileSaveErrorHandler } from '../../../../../workbench/contrib/files/browser/editors/textFileSaveErrorHandler.js';
import { loadArkdown } from './arkdownRuntime.js';
import { createArkdownCollabProfile } from './arkdownCollabProfile.js';
import { ArkdownEditor } from './arkdownEditor.js';
import type { DocsEditorMode } from '../../common/docs.js';

/** File lifecycle for the Arkdown document host used by Sessions Docs. */
export class ArkdownEditorPane extends EditorPane {
	readonly id: string;
	private root!: HTMLElement;
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private widget: ArkdownEditor | undefined;
	private copy: EditorWorkingCopy | undefined;
	private input: IResourceEditorInput | undefined;
	private readOnly = false;
	private model: TextModel | undefined;
	private connecting = false;
	private readonly collaborationPresentation = this._register(new MutableDisposable());
	private observedSession: BufferCollabSession | undefined;
	private get collaborationSession() { return this.model ? this.bufferCollab.get(this.model) : undefined; }

	private collaborationAbort: AbortController | undefined;
	private readonly saveErrors: TextFileSaveErrorHandler;

	constructor(
		private readonly options: { readonly id: string; readonly onSave?: () => Promise<void | boolean>; },
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IOpenerService private readonly opener: IOpenerService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IBufferCollabService private readonly bufferCollab: IBufferCollabService,
	) {
		super(options.id, theme, storage);
		this.id = options.id;
		this.saveErrors = instantiation.createInstance(TextFileSaveErrorHandler);
		this._register(filesConfiguration.onDidChangeReadonly(() => this.updateReadOnly()));
		this._register(bufferCollab.onDidChange(model => {
			if (model !== this.model) return;
			this.updateReadOnly();
			const state = this.collaborationSession?.state;
			if (state) status(this.collaborationStatus(state));
		}));
	}

	override create(parent: HTMLElement): void {
		this.root = h(parent.ownerDocument, 'div', { className: 'stanza-arkdown-editor-pane' });
		this.root.style.height = '100%';
		parent.append(this.root);
		this._register(toDisposable(() => this.root.remove()));
		super.create(this.root);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		const runtime = await loadArkdown();
		signal.throwIfAborted();
		const reference = await this.models.acquire({ ...input, languageId: 'markdown' }, signal, { waitForSyntax: false });
		const lifetime = new DisposableStore();
		try {
			const copy = lifetime.add(new EditorWorkingCopy(reference, input, this.workingCopies, this.options.onSave));
			const widget = lifetime.add(this.instantiation.createInstance(ArkdownEditor, this.root, reference.model, runtime, 'rich',
				(error: unknown) => this.notifications.error(error instanceof Error ? error : String(error)),
				(url: string) => { void this.opener.open(URI.parse(url), { openExternal: true }).catch(error => this.notifications.error(String(error))); }));
			signal.throwIfAborted();
			this.collaborationAbort?.abort(); this.collaborationAbort = undefined; this.connecting = false;
			this.inputLifetime.value = lifetime;
			this.collaborationPresentation.clear(); this.observedSession = undefined;
			this.model = reference.model;
			this.widget = widget;
			this.copy = copy;
			this.input = input;
			lifetime.add(widget.onDidChangeMode(() => this.updateTitleArea()));
			this.updateReadOnly();
		} catch (error) { lifetime.dispose(); reference.dispose(); throw error; }
	}

	get workingCopy(): EditorWorkingCopy | undefined { return this.copy; }

	private collaborationStatus(state: BufferCollabState): string {
		switch (state) {
			case BufferCollabState.Connecting: return localize({ bundle: 'ash.arkdown', key: 'collabConnecting' }, 'Connecting to collaboration room.');
			case BufferCollabState.Connected: return localize({ bundle: 'ash.arkdown', key: 'roomConnected' }, 'Connected to collaboration room.');
			case BufferCollabState.Offline: return localize({ bundle: 'ash.arkdown', key: 'reconnecting' }, 'Reconnecting collaboration. Local edits are retained.');
			case BufferCollabState.Rejected: return localize({ bundle: 'ash.arkdown', key: 'collabRejected' }, 'The collaboration update was rejected. Local edits are retained.');
			case BufferCollabState.Forbidden: return localize({ bundle: 'ash.arkdown', key: 'collabForbidden' }, 'Collaboration access has expired. Leave and rejoin to continue.');
		}
	}
	get isDirty(): boolean { return this.copy?.isDirty ?? false; }
	get hasExternalChange(): boolean { return this.copy?.hasExternalChange ?? false; }
	get isReadonly(): boolean { return this.readOnly; }
	setMode(mode: DocsEditorMode): void { this.widget?.setMode(mode); }
	private getMode(): DocsEditorMode { return this.widget?.getMode() ?? 'rich'; }
	override getControl(): ArkdownEditor | undefined { return this.widget; }
	override focus(): void { this.widget?.focus(); }
	override layout(dimension: IDimension): void { this.widget?.layout({ width: this.root.clientWidth || dimension.width, height: this.root.clientHeight || dimension.height }); }
	override clearInput(): void { this.collaborationAbort?.abort(); this.collaborationAbort = undefined; this.connecting = false; this.collaborationPresentation.clear(); this.observedSession = undefined; this.model = undefined; this.widget = undefined; this.copy = undefined; this.input = undefined; this.inputLifetime.clear(); }
	async save(options?: ISaveOptions): Promise<void> {
		try { await this.copy?.save(new AbortController().signal, options); }
		catch (error) { if (isCancellationError(error)) throw error; if (!await this.saveErrors.onSaveError(error, this.copy?.resource)) throw new CancellationError(undefined, error); }
	}
	async saveAs(resource: URI): Promise<void> { await this.copy?.saveAs(resource, new AbortController().signal); }
	containsAccessibilityFocus(target: HTMLElement): boolean { return this.getMode() === 'rich' && this.root.contains(target); }
	getAccessibleContent(): string { return this.widget?.getAccessibleText() ?? ''; }
	getAccessibilityHelp(): readonly string[] { return [localize({ bundle: 'ash.arkdown', key: 'arkdownHelp' }, 'Edit the document directly. Use Control or Command+B for bold, Control or Command+I for italic, and Control or Command+Z to undo. Use Control or Command+Alt+0 through 6 for a paragraph or heading. Use Control or Command+Shift+7, 8, or 9 for numbered, bulleted, or task lists. In a table, Tab and Shift+Tab move between cells; Tab in the last cell adds a row. Show Markdown source opens the code editor on the same document; Show document returns to the formatted document. Changes save automatically. Export creates a separate copy. Read-only files cannot be edited. Collaborate creates or joins a room. Copy room ID shares its identifier; remote rooms also require an access token. Undo during collaboration affects local edits and preserves remote edits. Disconnected edits are retried after reconnection. Leave collaboration stops synchronization and keeps the current local document. Saving still writes the local file. Collaboration stays active when switching tabs or views; leave the room to stop it. Collaboration undo history is checkpointed after 256 operations or 16 MiB.'), localize({ bundle: 'ash.arkdown', key: 'remoteChangesHelp' }, 'Recent remote changes expands a session-local list of the last 20 received changes with connection labels and insertion or deletion previews. The affected ranges are highlighted in matching colors in the document and source views. These ranges describe received updates, not permanent text authorship. Connection IDs are not verified user names. The list is available in the accessible view and clears when leaving collaboration.')]; }

	override getActions(): readonly IAction[] {
		const source = this.getMode() === 'markdown';
		const bold = localize({ bundle: 'ash.arkdown', key: 'bold' }, 'Bold');
		const italic = localize({ bundle: 'ash.arkdown', key: 'italic' }, 'Italic');
		const mode = source
			? localize({ bundle: 'ash.arkdown', key: 'showDocument' }, 'Show document')
			: localize({ bundle: 'ash.arkdown', key: 'showSource' }, 'Show Markdown source');
		const roomId = this.collaborationSession?.roomId;
		const collaborationLabel = roomId ? localize({ bundle: 'ash.arkdown', key: 'leaveCollaboration' }, 'Leave collaboration') : localize({ bundle: 'ash.arkdown', key: 'collaborate' }, 'Collaborate');
		return [
			{ id: 'arkdown.editor.collaborate', label: collaborationLabel, tooltip: roomId ? `${localize({ bundle: 'ash.arkdown', key: 'collaborationRoom' }, 'Room {0}', roomId)} · ${this.collaborationStatus(this.collaborationSession!.state)}` : collaborationLabel, icon: Lxicon.link, enabled: !!this.model && !this.connecting && (!this.readOnly || !!roomId), run: () => roomId ? this.stopCollaboration() : this.startCollaboration() },
			...(roomId ? [{ id: 'arkdown.editor.copyRoom', label: localize({ bundle: 'ash.arkdown', key: 'copyRoom' }, 'Copy room ID'), tooltip: localize({ bundle: 'ash.arkdown', key: 'copyRoom' }, 'Copy room ID'), icon: Lxicon.copy, enabled: true, run: () => this.clipboard.writeText(roomId) }] : []),
			{
				id: 'arkdown.editor.bold', label: bold, tooltip: bold, icon: Lxicon.bold,
				enabled: !!this.widget && !this.readOnly, run: () => this.widget?.format('**'),
			},
			{
				id: 'arkdown.editor.italic', label: italic, tooltip: italic, icon: Lxicon.italic,
				enabled: !!this.widget && !this.readOnly, run: () => this.widget?.format('_'),
			},
			{
				id: 'arkdown.editor.toggleMode', label: mode, tooltip: mode,
				icon: source ? Lxicon.fileText : Lxicon.code, enabled: !!this.widget,
				run: () => this.setMode(source ? 'rich' : 'markdown'),
			},
		];
	}

	private stopCollaboration(): void {
		this.collaborationAbort?.abort(); this.collaborationAbort = undefined;
		if (this.model) this.bufferCollab.leave(this.model);
		this.connecting = false; this.updateReadOnly();
	}
	protected override disposeCore(): void { this.collaborationAbort?.abort(); super.disposeCore(); }

	private async startCollaboration(): Promise<void> {
		const model = this.model;
		if (!model || this.connecting) return;
		const result = await this.dialogs.input({ title: localize({ bundle: 'ash.arkdown', key: 'collaborate' }, 'Collaborate'), message: localize({ bundle: 'ash.arkdown', key: 'chooseRoom' }, 'Enter a room ID to join, or leave it blank to create one.'), inputs: [{ value: '' }] });
		if (!result.confirmed || model !== this.model) return;
		this.connecting = true; this.updateReadOnly();
		const abort = this.collaborationAbort = new AbortController();
		try {
			const runtime = await loadArkdown();
			if (abort.signal.aborted) return;
			await this.bufferCollab.join(model, { resource: this.input!.resource, languageId: 'markdown', contentType: 'text/markdown' }, createArkdownCollabProfile(runtime), result.values?.[0]?.trim() || undefined, abort.signal);
		} catch (error) {
			const cancelled = abort.signal.aborted;
			if (this.collaborationAbort === abort) this.stopCollaboration();
			if (!cancelled && !isCancellationError(error)) this.notifications.error(localize({ bundle: 'ash.arkdown', key: 'collaborationFailed' }, 'Could not join the collaboration room. Check the server, room ID, and access token.'));
		} finally {
			if (this.collaborationAbort === abort) { this.connecting = false; this.updateReadOnly(); }
		}
	}

	private updateReadOnly(): void {
		if (!this.input) return;
		const session = this.collaborationSession;
		if (session !== this.observedSession) {
			this.collaborationPresentation.clear();
			this.observedSession = session;
			if (session) this.collaborationPresentation.value = session.onDidChangeRemoteChanges(() => this.widget?.setRemoteChanges(session.recentChanges));
		}
		this.widget?.setRemoteChanges(session?.recentChanges ?? []);
		this.readOnly = this.connecting || this.collaborationSession?.state === BufferCollabState.Connecting || this.input.readOnly === true || !!this.filesConfiguration.isReadonly(this.input.resource) || (!!this.collaborationSession?.roomId && !this.collaborationSession.canEdit);
		this.widget?.setReadOnly(this.readOnly);
		this.updateTitleArea();
	}
}
