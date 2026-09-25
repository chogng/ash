import { addDisposableListener } from "../../../../base/browser/dom.js";
import { Dimension, type IDimension } from "../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { validateJsonValue } from "../../../../base/common/jsonValue.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import type { URI } from "../../../../base/common/uri.js";
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { TextFileBinaryError, type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { EditorInput, EditorOpenOptions } from "./editorInput.js";
import type { TextResourceLanguageResolver } from "../../../../platform/language/common/textResourceLanguage.js";
import { isEditorPaneWithViewState, type IEditorPane } from "./editorPane.js";
import { EditorPanes, type EditorPaneInstance } from './editorPanes.js';
import { extractExternalEditorInputs } from "./editorDropData.js";
import { EditorPaneRegistry } from "./editorRegistry.js";
import type { IEditorTabDragAndDrop, EditorTabDropPosition } from "./editorTabDragAndDrop.js";
import { EditorGroupView } from './editorGroupView.js';
import { ErrorPlaceholderEditor } from "./editorPlaceholder.js";
import type { EditorWelcomeOptions, IEditorWelcomeProject } from "../../../contrib/files/browser/editorWelcome.js";
import { editorInputKey, type EditorTabDescriptor } from "./editorTabsControl.js";
import type { EditorHeaderActions } from "./editorHeaderControl.js";
import { type LanguageLocation, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import type { ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import type { IKeybindingsResourceService } from "../../../../platform/keybinding/common/keybindingsResource.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService, IScopedContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { EditorCloseReason, EditorGroupChangeEvent, EditorGroupId, EditorGroupState, EditorInstanceId, EditorInstanceState } from "../../../services/editor/common/editorState.js";
import type { SerializedEditorViewState } from "../../../services/editor/common/editorWorkingSet.js";
import { EditorGroupContextKeyController } from './editorContextKeys.js';

/** Operations and state owned independently by one EditorGroup. */
export interface IEditorGroup {
	readonly id: EditorGroupId;
	readonly domNode: HTMLElement;
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent>;
	readonly inputs: readonly EditorInput[];
	readonly editors: readonly EditorInstanceState[];
	readonly activeInput: EditorInput | undefined;
	readonly activePane: IEditorPane | undefined;
	getEditorState(): EditorGroupState;
	saveEditorViewState(input: EditorInput): SerializedEditorViewState | undefined;
	restoreEditorViewState(input: EditorInput, state: SerializedEditorViewState | undefined): boolean;
	isPreview(input: EditorInput): boolean;

	openEditor(
		input: EditorInput,
		options?: EditorOpenOptions,
		instanceId?: EditorInstanceId,
	): Promise<IEditorPane>;
	activateEditor(input: EditorInput): IEditorPane;
	confirmCloseEditor(input: EditorInput): Promise<boolean>;
	closeEditor(input: EditorInput, options?: EditorCloseOptions): Promise<boolean>;
	replaceEditor(input: EditorInput, replacement: EditorInput): Promise<void>;
	moveEditorTo(input: EditorInput, target: IEditorGroup, targetIndex: number): Promise<void>;
	setWelcomeRecentProjects(projects: readonly IEditorWelcomeProject[]): void;
	setWelcomeVisible(visible: boolean): void;
	setContent(content: Element): Promise<boolean>;
	layout(dimension: IDimension): void;
	focus(): void;
}

/** Internal lifecycle controls used when an editor is moved instead of closed. */
export interface EditorCloseOptions {
	readonly skipConfirmation?: boolean;
	readonly reason?: EditorCloseReason;
}

/** Construction inputs for one independently navigable EditorGroup. */
export interface EditorGroupOptions {
	readonly id?: EditorGroupId;
	readonly registry: EditorPaneRegistry;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	readonly keybindingService?: IKeybindingService;
	readonly keybindingsResourceService?: IKeybindingsResourceService;
	readonly keyboardLayoutService?: IKeyboardLayoutService;
	readonly fileService?: IFileService;
	readonly textFileService?: ITextFileService;
	readonly textMateService?: ITextMateService;
	readonly languageResolver?: TextResourceLanguageResolver;
	readonly diffService?: IDiffService;
	readonly instantiationService?: IInstantiationService;
	readonly accessibilityService?: IAccessibilityService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly documentCollaborationApi?: IDocumentCollaborationApi;
	readonly serverEvents?: IServerEventApi;
	readonly workingCopyService?: IWorkingCopyService;
	readonly onSave?: (group: IEditorGroup, input: EditorInput, pane: IEditorPane) => Promise<boolean>;
	readonly onWillCloseEditor?: (group: IEditorGroup, input: EditorInput, pane: IEditorPane) => Promise<boolean>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
	readonly titleActions?: EditorHeaderActions;
	readonly welcome?: EditorWelcomeOptions;
	readonly welcomeVisible?: boolean;
	readonly onDidActivate?: () => void;
	readonly dragAndDrop?: IEditorTabDragAndDrop;
}

interface EditorGroupEntry extends EditorTabDescriptor {
	readonly instanceId: EditorInstanceId;
	paneInstance: EditorPaneInstance;
	input: EditorInput;
	preview: boolean;
}

/**
 * Owns the ordered Editor inputs and active tab in one group.
 *
 * EditorGroupView owns its DOM and EditorPanes owns pane lifetimes.
 */
export class EditorGroup extends Disposable implements IEditorGroup {
	readonly id: EditorGroupId;
	readonly domNode: HTMLElement;
	private readonly editorChangeEmitter = this._register(new Emitter<EditorGroupChangeEvent>());
	readonly onDidChangeEditors: Event<EditorGroupChangeEvent> = this.editorChangeEmitter.event;
	private readonly view: EditorGroupView;
	private readonly panes: EditorPanes;
	private readonly registry: EditorPaneRegistry;
	private readonly configurationService: IConfigurationService | undefined;
	private readonly contextKeyService: IContextKeyService | undefined;
	private readonly scopedContextKeyService: IScopedContextKeyService | undefined;
	private readonly keybindingService: IKeybindingService | undefined;
	private readonly keybindingsResourceService: IKeybindingsResourceService | undefined;
	private readonly keyboardLayoutService: IKeyboardLayoutService | undefined;
	private readonly fileService: IFileService | undefined;
	private readonly textFileService: ITextFileService | undefined;
	private readonly textMateService: ITextMateService | undefined;
	private readonly languageResolver: TextResourceLanguageResolver | undefined;
	private readonly diffService: IDiffService | undefined;
	private readonly instantiationService: IInstantiationService | undefined;
	private readonly accessibilityService: IAccessibilityService | undefined;
	private readonly languageDiagnosticsService: ILanguageDiagnosticsService | undefined;
	private readonly documentCollaborationApi: IDocumentCollaborationApi | undefined;
	private readonly serverEvents: IServerEventApi | undefined;
	private readonly workingCopyService: IWorkingCopyService | undefined;
	private readonly onSave: ((group: IEditorGroup, input: EditorInput, pane: IEditorPane) => Promise<boolean>) | undefined;
	private readonly onWillCloseEditor: ((group: IEditorGroup, input: EditorInput, pane: IEditorPane) => Promise<boolean>) | undefined;
	private readonly onOpenLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined;
	private readonly onApplyWorkspaceEdit: ((edit: LanguageWorkspaceEdit) => void | Promise<void>) | undefined;
	private readonly titleActions: EditorHeaderActions | undefined;
	private readonly entries: EditorGroupEntry[] = [];
	private activeEntry: EditorGroupEntry | undefined;
	private ordinaryContent: Element | undefined;
	private groupDimension: IDimension = Dimension.Zero;
	private dimension: IDimension = Dimension.Zero;
	private openSequence = 0;

	constructor(container: HTMLElement, options: EditorGroupOptions) {
		super();
		this.id = options.id ?? nextEditorGroupId();
		reserveEditorGroupId(this.id);
		this.registry = options.registry;
		this.configurationService = options.configurationService;
		this.contextKeyService = options.contextKeyService;
		this.keybindingService = options.keybindingService;
		this.keybindingsResourceService = options.keybindingsResourceService;
		this.keyboardLayoutService = options.keyboardLayoutService;
		this.fileService = options.fileService;
		this.textFileService = options.textFileService;
		this.textMateService = options.textMateService;
		this.languageResolver = options.languageResolver;
		this.diffService = options.diffService;
		this.instantiationService = options.instantiationService;
		this.accessibilityService = options.accessibilityService;
		this.languageDiagnosticsService = options.languageDiagnosticsService;
		this.documentCollaborationApi = options.documentCollaborationApi;
		this.serverEvents = options.serverEvents;
		this.workingCopyService = options.workingCopyService;
		this.onSave = options.onSave;
		this.onWillCloseEditor = options.onWillCloseEditor;
		this.onOpenLocation = options.onOpenLocation;
		this.onApplyWorkspaceEdit = options.onApplyWorkspaceEdit;
		this.titleActions = options.titleActions;
		this.view = this._register(new EditorGroupView(container, {
			activate: input => this.activateEntry(this.requireEntry(input), true),
			preview: input => this.activateEntry(this.requireEntry(input), false),
			close: input => {
				void this.closeEditor(input).catch(reportEditorCloseError);
			},
			startDrag: input => options.dragAndDrop?.start(this, input),
			isDragging: () => options.dragAndDrop?.isDragging() ?? false,
			drop: (target, position) => options.dragAndDrop?.drop(this, target, position),
			dropExternal: (event, target, position) => {
				void this.openExternalEditors(event.dataTransfer, target, position).catch((error: unknown) => {
					console.error("Failed to open dropped editor resources", error);
				});
			},
			endDrag: () => options.dragAndDrop?.end(),
		}, options));
		this.domNode = this.view.domNode;
		this.panes = this.view.panes;
		this.scopedContextKeyService = this.view.scopedContextKeyService;
		if (this.scopedContextKeyService) {
			this._register(new EditorGroupContextKeyController(
				this.scopedContextKeyService,
				this,
				this.registry,
				this.languageResolver,
			));
		}
		if (options.onDidActivate) {
			this._register(addDisposableListener(this.domNode, "focusin", () => {
				options.onDidActivate?.();
			}));
		}
		this._register(this.view.onDidChangeTitleHeight(() => this.layout(this.groupDimension)));
		this._register(toDisposable(() => {
			this.cancelPendingOpen();
			this.entries.length = 0;
		}));
		this.renderChrome();
	}

	get inputs(): readonly EditorInput[] {
		return this.entries.map(({ input }) => input);
	}

	get editors(): readonly EditorInstanceState[] {
		return this.entries.map(entry => this.editorState(entry));
	}

	get activeInput(): EditorInput | undefined {
		return this.activeEntry?.input;
	}

	get activePane(): IEditorPane | undefined {
		return this.panes.activePane;
	}

	getEditorState(): EditorGroupState {
		return Object.freeze({
			id: this.id,
			editors: Object.freeze(this.editors),
			activeEditorInstanceId: this.activeEntry?.instanceId,
		});
	}

	saveEditorViewState(input: EditorInput): SerializedEditorViewState | undefined {
		const pane = this.entry(input)?.paneInstance.pane;
		if (!pane || !isEditorPaneWithViewState(pane)) return undefined;
		return Object.freeze({
			typeId: pane.viewStateTypeId,
			value: validateJsonValue(pane.saveViewState(), { path: "editor view state" }),
		});
	}

	restoreEditorViewState(input: EditorInput, state: SerializedEditorViewState | undefined): boolean {
		const pane = this.entry(input)?.paneInstance.pane;
		if (!pane || !state || !isEditorPaneWithViewState(pane) || pane.viewStateTypeId !== state.typeId) return false;
		pane.restoreViewState(validateJsonValue(state.value, { path: "editor view state" }));
		return true;
	}

	isPreview(input: EditorInput): boolean {
		return this.entry(input)?.preview ?? false;
	}

	async openEditor(
		input: EditorInput,
		options: EditorOpenOptions = {},
		instanceId?: EditorInstanceId,
	): Promise<IEditorPane> {
		const sequence = ++this.openSequence;
		this.cancelPendingOpen();
		const existing = this.entry(input);
		let descriptor: ReturnType<EditorPaneRegistry["resolve"]>;
		try {
			const matchInput = this.languageResolver
				? { ...input, languageId: this.languageResolver.resolveLanguageId({ resource: input.resource, ...(input.contentType === undefined ? {} : { contentType: input.contentType }) }) }
				: input;
			descriptor = this.registry.resolve(matchInput, options);
		} catch (error) {
			this.showOpenError(input, options, error, existing);
			throw error;
		}
		if (existing?.paneInstance.pane.id === descriptor.id) {
			const wasPreview = existing.preview;
			existing.input = input;
			if (options.pinned === true) existing.preview = false;
			this.moveEntry(existing, options.index);
			this.activateEntry(existing, false);
			applyEditorOpenOptions(existing.paneInstance.pane, options);
			if (wasPreview !== existing.preview) this.publishEditorState(existing);
			return existing.paneInstance.pane;
		}

		let createdPane: IEditorPane | undefined;
		let pane: IEditorPane;
		try {
			pane = descriptor.create({
				input,
				configurationService: this.configurationService,
				contextKeyService: this.contextKeyService,
				...(this.titleActions ? {
					actionServices: {
						menuService: this.titleActions.menuService,
						contextMenuProvider: this.titleActions.contextMenuProvider,
						contextKeyService: this.scopedContextKeyService,
					},
				} : {}),
				keybindingService: this.keybindingService,
				keybindingsResourceService: this.keybindingsResourceService,
				keyboardLayoutService: this.keyboardLayoutService,
				fileService: this.fileService,
				textFileService: this.textFileService,
				textMateService: this.textMateService,
				languageResolver: this.languageResolver,
				diffService: this.diffService,
				instantiationService: this.instantiationService,
				accessibilityService: this.accessibilityService,
				languageDiagnosticsService: this.languageDiagnosticsService,
				documentCollaborationApi: this.documentCollaborationApi,
				serverEvents: this.serverEvents,
				workingCopyService: this.workingCopyService,
				onOpenLocation: this.onOpenLocation,
				onApplyWorkspaceEdit: this.onApplyWorkspaceEdit,
				...(this.onSave ? {
					onSave: () => {
						if (!createdPane) return Promise.reject(new Error("Editor save is unavailable"));
						return this.onSave!(this, input, createdPane);
					},
				} : {}),
			});
		} catch (error) {
			this.showOpenError(input, options, error, existing);
			throw error;
		}
		createdPane = pane;
		if (pane.id !== descriptor.id) {
			pane.dispose();
			const error = new TypeError(
				`Editor pane factory '${descriptor.id}' created '${pane.id}'`,
			);
			this.showOpenError(input, options, error, existing);
			throw error;
		}
		let paneInstance: EditorPaneInstance;
		try {
			paneInstance = this.panes.create(pane);
		} catch (error) {
			this.showOpenError(input, options, error, existing);
			throw error;
		}
		this.panes.setPending(paneInstance);
		try {
			await pane.setInput(input, paneInstance.signal);
		} catch (error) {
			this.panes.disposePane(paneInstance);
			if (sequence !== this.openSequence) {
				throw new EditorOpenSupersededError(input);
			}
			this.showOpenError(input, options, error, existing);
			throw error;
		}

		if (
			sequence !== this.openSequence ||
			this.panes.pendingPane !== paneInstance
		) {
			this.panes.disposePane(paneInstance);
			throw new EditorOpenSupersededError(input);
		}
		this.panes.clearPending(paneInstance);
		return this.commitEditorPane(input, options, paneInstance, existing, instanceId);
	}

	private commitEditorPane(input: EditorInput, options: EditorOpenOptions, paneInstance: EditorPaneInstance, existing: EditorGroupEntry | undefined, instanceId?: EditorInstanceId): IEditorPane {
		const pane = paneInstance.pane;
		let entry: EditorGroupEntry = {
			input,
			instanceId: existing?.instanceId ?? instanceId ?? nextEditorInstanceId(),
			panelId: paneInstance.panelId,
			tabId: paneInstance.tabId,
			paneInstance,
			preview: options.pinned === false,
			get isDirty() { return paneInstance.pane.workingCopy?.isDirty ?? false; },
			get hasExternalChange() { return paneInstance.pane.workingCopy?.hasExternalChange ?? false; },
		};
		paneInstance.observeWorkingCopy(() => {
			if (entry.preview && entry.paneInstance.pane.workingCopy?.isDirty) entry.preview = false;
			this.publishEditorState(entry);
		});
		if (existing) {
			const index = this.entries.indexOf(existing);
			const previous = this.editorState(existing);
			this.panes.disposePane(existing.paneInstance);
			if (this.activeEntry === existing) this.activeEntry = undefined;
			this.entries[index] = entry;
			this.editorChangeEmitter.fire(Object.freeze({ kind: "editorClosed", editor: previous, reason: "replace" }));
		} else {
			const preview = options.pinned === false
				? this.entries.find(candidate => candidate.preview && !candidate.paneInstance.pane.workingCopy?.isDirty)
				: undefined;
			if (preview) {
				const index = this.entries.indexOf(preview);
				const previous = this.editorState(preview);
				this.panes.disposePane(preview.paneInstance);
				if (this.activeEntry === preview) this.activeEntry = undefined;
				this.entries[index] = entry;
				this.editorChangeEmitter.fire(Object.freeze({ kind: "editorClosed", editor: previous, reason: "previewReplace" }));
			} else {
				this.insertEntry(entry, options.index);
			}
		}
		this.ordinaryContent = undefined;
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorOpened", editor: this.editorState(entry) }));
		this.activateEntry(entry, false);
		applyEditorOpenOptions(pane, options);
		return pane;
	}

	private showOpenError(input: EditorInput, options: EditorOpenOptions, error: unknown, existing: EditorGroupEntry | undefined): void {
		if (existing?.paneInstance.pane instanceof ErrorPlaceholderEditor) {
			existing.paneInstance.pane.updateError(error);
			this.activateEntry(existing, false);
			return;
		}
		if (existing || this.activeEntry) return;
		const binaryEditor = error instanceof TextFileBinaryError
			? this.registry.getEditors(input).find(candidate => candidate.id === "ash.editor.binary")
			: undefined;
		const pane = new ErrorPlaceholderEditor(
			error,
			() => {
				void this.openEditor(input, { ...options, pinned: true }).catch(() => undefined);
			},
			() => {
				void this.closeEditor(input).catch(reportEditorCloseError);
			},
			binaryEditor ? {
				label: localize("workbench.editorOpenAsBinary", "Open as Binary"),
				run: () => {
					void this.openEditor(input, { ...options, pinned: true, preferredEditorId: binaryEditor.id }).catch(() => undefined);
				},
			} : undefined,
		);
		const paneInstance = this.panes.create(pane);
		void pane.setInput(input, paneInstance.signal);
		this.commitEditorPane(input, options, paneInstance, undefined);
	}

	activateEditor(input: EditorInput): IEditorPane {
		const entry = this.requireEntry(input);
		this.activateEntry(entry, false);
		return entry.paneInstance.pane;
	}

	async confirmCloseEditor(input: EditorInput): Promise<boolean> {
		const entry = this.entry(input);
		if (!entry) return true;
		if (!entry.paneInstance.pane.workingCopy?.isDirty) return true;
		return await this.onWillCloseEditor?.(this, entry.input, entry.paneInstance.pane) ?? false;
	}

	async closeEditor(input: EditorInput, options: EditorCloseOptions = {}): Promise<boolean> {
		const entry = this.entry(input);
		if (!entry) return false;
		if (!options.skipConfirmation && entry.paneInstance.pane.workingCopy?.isDirty && !await this.confirmCloseEditor(input)) return false;
		if (!this.entries.includes(entry)) return true;
		this.doCloseEditor(entry, options.reason ?? "close");
		return true;
	}

	private doCloseEditor(entry: EditorGroupEntry, reason: EditorCloseReason): void {
		const index = this.entries.indexOf(entry);
		if (index < 0) return;
		this.entries.splice(index, 1);
		const closedState = this.editorState(entry, index);
		const wasActive = this.activeEntry === entry;
		if (wasActive) {
			this.activeEntry = undefined;
		}
		this.panes.disposePane(entry.paneInstance);
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorClosed", editor: closedState, reason }));
		if (wasActive) {
			const next = this.entries[index] ?? this.entries[index - 1];
			if (next) this.activateEntry(next, true);
			else {
				this.editorChangeEmitter.fire(Object.freeze({ kind: "activeEditorChanged", editor: undefined }));
			}
		}
		this.renderContent();
		this.renderChrome();
	}

	async replaceEditor(input: EditorInput, replacement: EditorInput): Promise<void> {
		const index = this.entries.findIndex(
			(candidate) => editorInputKey(candidate.input) === editorInputKey(input),
		);
		if (index < 0) throw new RangeError(`Editor is not open in this group: ${input.resource}`);
		await this.openEditor(replacement, { index });
		await this.closeEditor(input, { skipConfirmation: true, reason: "replace" });
	}

	setWelcomeRecentProjects(projects: readonly IEditorWelcomeProject[]): void {
		this.view.setWelcomeRecentProjects(projects);
	}

	setWelcomeVisible(visible: boolean): void {
		if (!this.view.setWelcomeVisible(visible)) return;
		this.renderContent();
	}

	getEditorInsertionIndex(target: EditorInput | undefined, position: EditorTabDropPosition): number {
		if (!target) return this.entries.length;
		const index = this.entries.findIndex(
			(candidate) => editorInputKey(candidate.input) === editorInputKey(target),
		);
		if (index < 0) return this.entries.length;
		return position === "before" ? index : index + 1;
	}

	moveEditor(input: EditorInput, targetIndex: number): void {
		const sourceIndex = this.entries.findIndex(
			(candidate) => editorInputKey(candidate.input) === editorInputKey(input),
		);
		if (sourceIndex < 0) return;
		const [entry] = this.entries.splice(sourceIndex, 1);
		if (!entry) return;
		const adjustedIndex = Math.min(
			Math.max(0, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex),
			this.entries.length,
		);
		this.entries.splice(adjustedIndex, 0, entry);
		this.renderContent();
		this.renderChrome();
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorMoved", editor: this.editorState(entry), previousIndex: sourceIndex }));
	}

	private async openExternalEditors(dataTransfer: DataTransfer | null, target: EditorInput | undefined, position: EditorTabDropPosition): Promise<void> {
		if (!dataTransfer) return;
		const inputs = await extractExternalEditorInputs(dataTransfer);
		let index = this.getEditorInsertionIndex(target, position);
		for (const input of inputs) {
			await this.openEditor(input, { index });
			index += 1;
		}
	}

	async moveEditorTo(input: EditorInput, target: IEditorGroup, targetIndex: number): Promise<void> {
		if (target === this) {
			this.moveEditor(input, targetIndex);
			return;
		}
		const entry = this.requireEntry(input);
		await target.openEditor(input, { index: targetIndex }, entry.instanceId);
		await this.closeEditor(input, { skipConfirmation: true, reason: "move" });
		target.activateEditor(input);
	}

	async setContent(content: Element): Promise<boolean> {
		const inputs = [...this.inputs];
		for (const input of inputs) {
			if (!await this.confirmCloseEditor(input)) return false;
		}
		this.openSequence += 1;
		this.cancelPendingOpen();
		for (const entry of [...this.entries]) this.doCloseEditor(entry, "reset");
		this.ordinaryContent = content;
		this.renderContent();
		this.renderChrome();
		return true;
	}

	layout(dimension: IDimension): void {
		this.groupDimension = dimension;
		this.dimension = new Dimension(
			dimension.width,
			Math.max(0, dimension.height - this.view.titleHeight),
		);
		this.panes.layout(this.dimension);
	}

	focus(): void {
		this.panes.focus();
	}

	private activateEntry(entry: EditorGroupEntry, focus: boolean): void {
		const changed = this.activeEntry !== entry;
		if (this.activeEntry !== entry) {
			this.activeEntry = entry;
		}
		if (changed) {
			this.editorChangeEmitter.fire(Object.freeze({ kind: "activeEditorChanged", editor: this.editorState(entry) }));
		}
		this.ordinaryContent = undefined;
		this.renderContent();
		this.panes.activate(entry.paneInstance, this.dimension);
		this.renderChrome();
		if (focus) this.panes.focus();
	}

	private renderContent(): void {
		this.view.renderContent(
			this.entries.map(entry => entry.paneInstance),
			this.panes.pendingPane,
			this.ordinaryContent,
		);
	}

	private renderChrome(): void {
		this.view.setEditors(this.entries, this.activeInput);
	}

	private insertEntry(entry: EditorGroupEntry, index: number | undefined): void {
		const targetIndex = index === undefined
			? this.entries.length
			: Math.min(Math.max(0, index), this.entries.length);
		this.entries.splice(targetIndex, 0, entry);
	}

	private moveEntry(entry: EditorGroupEntry, index: number | undefined): void {
		if (index === undefined) return;
		const currentIndex = this.entries.indexOf(entry);
		if (currentIndex < 0) return;
		this.entries.splice(currentIndex, 1);
		const targetIndex = Math.min(Math.max(0, index), this.entries.length);
		this.entries.splice(targetIndex, 0, entry);
		if (currentIndex !== targetIndex) this.editorChangeEmitter.fire(Object.freeze({ kind: "editorMoved", editor: this.editorState(entry), previousIndex: currentIndex }));
	}

	private publishEditorState(entry: EditorGroupEntry): void {
		if (!this.entries.includes(entry)) return;
		this.renderChrome();
		this.editorChangeEmitter.fire(Object.freeze({ kind: "editorStateChanged", editor: this.editorState(entry) }));
	}

	private editorState(entry: EditorGroupEntry, index = this.entries.indexOf(entry)): EditorInstanceState {
		const workingCopy = entry.paneInstance.pane.workingCopy;
		return Object.freeze({
			groupId: this.id,
			instanceId: entry.instanceId,
			paneId: entry.paneInstance.pane.id,
			input: entry.input,
			index,
			isActive: this.activeEntry === entry,
			isPreview: entry.preview,
			isDirty: workingCopy?.isDirty ?? false,
			canRevert: workingCopy !== undefined,
			hasExternalChange: workingCopy?.hasExternalChange ?? false,
		});
	}

	private entry(input: EditorInput): EditorGroupEntry | undefined {
		const key = editorInputKey(input);
		return this.entries.find(
			(candidate) => editorInputKey(candidate.input) === key,
		);
	}

	private requireEntry(input: EditorInput): EditorGroupEntry {
		const entry = this.entry(input);
		if (!entry) {
			throw new RangeError(
				`Editor is not open in this group: ${input.resource}`,
			);
		}
		return entry;
	}

	private cancelPendingOpen(): void {
		this.panes.cancelPending();
	}
}

function applyEditorOpenOptions(pane: IEditorPane, options: EditorOpenOptions): void {
	if (options.selection) pane.revealRange?.(options.selection);
}

let editorGroupId = 0;
let editorInstanceId = 0;

function nextEditorGroupId(): EditorGroupId {
	return `editor-group-${++editorGroupId}`;
}

function reserveEditorGroupId(id: EditorGroupId): void {
	const match = /^editor-group-(\d+)$/u.exec(id);
	if (!match) return;
	const value = Number(match[1]);
	if (Number.isSafeInteger(value)) editorGroupId = Math.max(editorGroupId, value);
}

function nextEditorInstanceId(): EditorInstanceId {
	return `editor-instance-${++editorInstanceId}`;
}

export class EditorOpenSupersededError extends Error {
	constructor(readonly input: EditorInput) {
		super(`Editor opening was superseded: ${input.resource}`);
		this.name = "EditorOpenSupersededError";
	}
}

function reportEditorCloseError(error: unknown): void {
	console.error("Failed to close editor", error);
}
