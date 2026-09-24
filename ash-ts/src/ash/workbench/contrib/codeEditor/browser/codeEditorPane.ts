import type { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import "./media/editorPane.css";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, DisposableStore, MutableDisposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { assertDefined } from "../../../../base/common/types.js";
import * as strings from '../../../../base/common/strings.js';
import type { URI } from "../../../../base/common/uri.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { type IEditorPane } from "../../../browser/parts/editor/editorPane.js";
import { EditorPaneVisibility } from "../../../browser/parts/editor/editorPane.js";
import { CODE_EDITOR_ID } from "./codeEditorInput.js";
import { type ITextResourceStore } from "../../../services/textmodelResolver/common/textResourceStore.js";
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { type ICodeEditorViewState } from '../../../../editor/common/editorCommon.js';
import { ITextModelResourceService, type TextModelReference } from "../../../services/textmodelResolver/common/textModelResourceService.js";
import { type EditorTextDirection } from "../../../../editor/browser/view.js";
import { EditorLineWrapping, type IEditorOptions } from "../../../../editor/common/config/editorOptions.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import { type Range } from "../../../../editor/common/core/range.js";
import { type LanguageLocation, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import { type ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import type { Selection } from "../../../../editor/common/core/selection.js";
import type { ICursorSelectionChangedEvent } from "../../../../editor/common/cursorEvents.js";
import type { EditorPaneStatus } from "../../../browser/parts/editor/editorPane.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import { trimTrailingWhitespace } from "../../../../editor/common/commands/trimTrailingWhitespaceCommand.js";
import { EditOperation } from '../../../../editor/common/core/editOperation.js';
import { Position } from '../../../../editor/common/core/position.js';
import { CodeEditorConfiguration } from '../common/editorConfiguration.js';

export interface EditorPanePart extends IDisposable {
	readonly onDidChangeModelContent?: Event<IModelContentChangedEvent>;
	readonly onDidChangeCursorSelection?: Event<ICursorSelectionChangedEvent>;
	getSelections?(): Selection[] | null;
	layout(dimension: IDimension): void;
	focus(): void;
	getValue(): string;
	updateOptions(options: Readonly<IEditorOptions>): void;
	revealRange?(range: Range): void;
	saveViewState?(): ICodeEditorViewState | null;
	restoreViewState?(state: ICodeEditorViewState): void;
	announceAccessibilityStatus?(message: string): void;
}

export interface EditorPanePartOptions extends CodeEditorWidgetOptions {
	readonly textMateService?: ITextMateService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly accessibilityService?: IAccessibilityService;
}

export interface EditorPaneOptions {
	readonly workingCopyService?: IWorkingCopyService;
	readonly createPart?: (options: EditorPanePartOptions) => EditorPanePart;
	readonly textMateService?: ITextMateService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly accessibilityService?: IAccessibilityService;
	readonly lineWrapping?: EditorLineWrapping;
	readonly wrappingIndent?: CodeEditorWidgetOptions['wrappingIndent'];
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly lineHeight?: number;
	readonly fontLigatures?: boolean;
	readonly experimentalGpuAcceleration?: CodeEditorWidgetOptions["experimentalGpuAcceleration"];
	readonly minimap?: CodeEditorWidgetOptions["minimap"];
	readonly renderLineHighlight?: CodeEditorWidgetOptions['renderLineHighlight'];
	readonly renderLineHighlightOnlyWhenFocus?: CodeEditorWidgetOptions['renderLineHighlightOnlyWhenFocus'];
	readonly cursorStyle?: CodeEditorWidgetOptions['cursorStyle'];
	readonly cursorBlinking?: CodeEditorWidgetOptions['cursorBlinking'];
	readonly cursorSmoothCaretAnimation?: CodeEditorWidgetOptions['cursorSmoothCaretAnimation'];
	readonly cursorWidth?: CodeEditorWidgetOptions['cursorWidth'];
	readonly cursorHeight?: CodeEditorWidgetOptions['cursorHeight'];
	readonly lineNumbers?: CodeEditorWidgetOptions['lineNumbers'];
	readonly guides?: CodeEditorWidgetOptions['guides'];
	readonly bracketPairColorization?: CodeEditorWidgetOptions['bracketPairColorization'];
	readonly matchBrackets?: CodeEditorWidgetOptions["matchBrackets"];
	readonly stickyScroll?: CodeEditorWidgetOptions['stickyScroll'];
	readonly suggestions?: CodeEditorWidgetOptions["suggestions"];
	readonly inlineCompletions?: CodeEditorWidgetOptions["inlineCompletions"];
	readonly parameterHints?: boolean;
	readonly inlayHints?: CodeEditorWidgetOptions['inlayHints'];
	readonly codeLens?: boolean;
	readonly colorDecorators?: CodeEditorWidgetOptions["colorDecorators"];
	readonly colorDecoratorsActivatedOn?: CodeEditorWidgetOptions["colorDecoratorsActivatedOn"];
	readonly colorDecoratorsLimit?: CodeEditorWidgetOptions["colorDecoratorsLimit"];
	readonly defaultColorDecorators?: CodeEditorWidgetOptions["defaultColorDecorators"];
	readonly formatOnSave?: boolean;
	readonly trimTrailingWhitespace?: boolean;
	readonly trimTrailingWhitespaceInRegexAndStrings?: boolean;
	readonly find?: CodeEditorWidgetOptions["find"];
	readonly indentation?: CodeEditorWidgetOptions["indentation"];
	/** Browser paragraph direction forwarded to every created editor part. */
	readonly textDirection?: EditorTextDirection;
	readonly onOpenLink?: (target: string) => void | Promise<void>;
	readonly onExecuteEditorCommand?: CodeEditorWidgetOptions["onExecuteEditorCommand"];
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
	readonly placeholder?: string;
	readonly showUnicodeHighlights?: boolean;
	readonly insertFinalNewLine?: boolean;
	readonly onSave?: () => Promise<void | boolean>;
	readonly onSaveError?: (error: unknown) => void;
}

/** Workbench pane that composes the text model, input, view, and language services. */
export class CodeEditorPane extends Disposable implements IEditorPane {
	readonly id = CODE_EDITOR_ID;
	readonly viewStateTypeId = "stanza.code.textView";
	private readonly workingCopySlot = this._register(new MutableDisposable<IWorkingCopy>());
	private readonly part = this._register(new MutableDisposable<EditorPanePart>());
	private readonly statusListener = this._register(new MutableDisposable<IDisposable>());
	private readonly statusChangeEmitter = this._register(new Emitter<void>());
	private readonly createPart: (options: EditorPanePartOptions) => EditorPanePart;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };
	private saving = false;
	private beforeSaveHooks: Array<() => void | Promise<void>> = [];
	private languageId: string | undefined;
	readonly onDidChangeStatus = this.statusChangeEmitter.event;

	getControl(): EditorPanePart | undefined {
		return this.part.value;
	}

	get workingCopy(): IWorkingCopy | undefined {
		return this.workingCopySlot.value;
	}

	constructor(
		private readonly resourceStore: ITextResourceStore,
		private readonly options: EditorPaneOptions,
		@ITextModelResourceService private readonly modelService: ITextModelResourceService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		if (!resourceStore || typeof resourceStore.resolve !== "function" || typeof resourceStore.save !== "function" || typeof resourceStore.onDidChange !== "function") {
			this.dispose();
			throw new TypeError("Code editor pane requires a text resource store");
		}
		this.createPart = options.createPart ?? (partOptions => this.instantiationService.createInstance(CodeEditorWidget, partOptions));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			const part = this.part.value;
			if (!part) return;
			const update: {
				wordWrap?: IEditorOptions['wordWrap'];
				minimap?: IEditorOptions['minimap'];
				renderWhitespace?: IEditorOptions['renderWhitespace'];
				renderControlCharacters?: IEditorOptions['renderControlCharacters'];
			} = {};
			if (this.options.lineWrapping === undefined && event.affectsConfiguration(CodeEditorConfiguration.wordWrap)) {
				update.wordWrap = this.configurationService.getValue(CodeEditorConfiguration.wordWrap) === EditorLineWrapping.On ? 'on' : 'off';
			}
			if (this.options.minimap === undefined && event.affectsConfiguration(CodeEditorConfiguration.minimapEnabled)) {
				update.minimap = { enabled: this.configurationService.getValue(CodeEditorConfiguration.minimapEnabled) };
			}
			if (event.affectsConfiguration(CodeEditorConfiguration.renderWhitespace)) {
				update.renderWhitespace = this.configurationService.getValue(CodeEditorConfiguration.renderWhitespace);
			}
			if (event.affectsConfiguration(CodeEditorConfiguration.renderControlCharacters)) {
				update.renderControlCharacters = this.configurationService.getValue(CodeEditorConfiguration.renderControlCharacters);
			}
			if (Object.keys(update).length > 0) part.updateOptions(update);
		}));
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("EditorPane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "stanza-editor-pane";
		parent.append(container);
		this.container = container;
		this._register(addDisposableListener<KeyboardEvent>(container, "keydown", event => this.handleSaveKeydown(event)));
		this._register(toDisposable(() => {
			container.remove();
			this.container = undefined;
		}));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		const container = this.requireContainer();
		throwIfCancelled(signal, "Code editor input loading was cancelled");
		const modelReference = await this.modelService.acquire(input, signal);
		let part: EditorPanePart | undefined;
		let workingCopy: EditorWorkingCopy | undefined;
		const beforeSaveHooks: Array<() => void | Promise<void>> = [];
		try {
			throwIfCancelled(signal, "Code editor input loading was cancelled");
			const languageId = modelReference.model.getLanguageId();
			part = this.createPart({
				container,
				input,
				languageId,
				model: modelReference.model,
				textMateService: this.options.textMateService,
				languageDiagnosticsService: this.options.languageDiagnosticsService,
				accessibilityService: this.options.accessibilityService,
				lineWrapping: this.options.lineWrapping ?? this.configurationService.getValue(CodeEditorConfiguration.wordWrap),
				wrappingIndent: this.options.wrappingIndent,
				fontFamily: this.options.fontFamily,
				fontSize: this.options.fontSize,
				lineHeight: this.options.lineHeight,
				fontLigatures: this.options.fontLigatures,
				experimentalGpuAcceleration: this.options.experimentalGpuAcceleration,
				minimap: this.options.minimap ?? { enabled: this.configurationService.getValue(CodeEditorConfiguration.minimapEnabled) },
				renderWhitespace: this.configurationService.getValue(CodeEditorConfiguration.renderWhitespace),
				renderControlCharacters: this.configurationService.getValue(CodeEditorConfiguration.renderControlCharacters),
				renderLineHighlight: this.options.renderLineHighlight,
				renderLineHighlightOnlyWhenFocus: this.options.renderLineHighlightOnlyWhenFocus,
				cursorStyle: this.options.cursorStyle,
				cursorBlinking: this.options.cursorBlinking,
				cursorSmoothCaretAnimation: this.options.cursorSmoothCaretAnimation,
				cursorWidth: this.options.cursorWidth,
				cursorHeight: this.options.cursorHeight,
				lineNumbers: this.options.lineNumbers,
				guides: this.options.guides,
				bracketPairColorization: this.options.bracketPairColorization,
				matchBrackets: this.options.matchBrackets,
				stickyScroll: this.options.stickyScroll,
				suggestions: this.options.suggestions,
				inlineCompletions: this.options.inlineCompletions,
				parameterHints: this.options.parameterHints === undefined ? undefined : { enabled: this.options.parameterHints },
				inlayHints: this.options.inlayHints,
				codeLens: this.options.codeLens,
				colorDecorators: this.options.colorDecorators,
				colorDecoratorsActivatedOn: this.options.colorDecoratorsActivatedOn,
				colorDecoratorsLimit: this.options.colorDecoratorsLimit,
				defaultColorDecorators: this.options.defaultColorDecorators,
				formatOnSave: this.options.formatOnSave,
				find: this.options.find,
				indentation: this.options.indentation,
				textDirection: this.options.textDirection,
				onOpenLink: this.options.onOpenLink,
				onExecuteEditorCommand: this.options.onExecuteEditorCommand,
				onOpenLocation: this.options.onOpenLocation,
				onApplyWorkspaceEdit: this.options.onApplyWorkspaceEdit,
				placeholder: this.options.placeholder,
				showUnicodeHighlights: this.options.showUnicodeHighlights,
				registerBeforeSave: hook => {
					beforeSaveHooks.push(hook);
					return toDisposable(() => {
						const index = beforeSaveHooks.indexOf(hook);
						if (index >= 0) beforeSaveHooks.splice(index, 1);
					});
				},
			});
			if (this.options.trimTrailingWhitespace) {
				beforeSaveHooks.unshift(() => {
					const selections = [...(part?.getSelections?.() ?? [])];
					const operations = trimTrailingWhitespace(modelReference.model, [], this.options.trimTrailingWhitespaceInRegexAndStrings ?? true);
					if (operations.length > 0) modelReference.model.pushEditOperations(selections, operations, () => selections);
				});
			}
			if (this.options.insertFinalNewLine) {
				beforeSaveHooks.push(() => {
					const model = modelReference.model;
					const lineCount = model.getLineCount();
					if (!lineCount || strings.lastNonWhitespaceIndex(model.getLineContent(lineCount)) === -1) return;
					const selections = [...(part?.getSelections?.() ?? [])];
					const operations = [EditOperation.insert(new Position(lineCount, model.getLineMaxColumn(lineCount)), model.getEOL())];
					model.pushEditOperations(selections, operations, () => selections);
				});
			}
			workingCopy = new EditorWorkingCopy(
				modelReference,
				this.resourceStore,
				input,
				this.options.workingCopyService,
				input.resource.scheme === "untitled" ? this.options.onSave : undefined,
			);
			throwIfCancelled(signal, "Code editor input loading was cancelled");
		} catch (error) {
			part?.dispose();
			workingCopy?.dispose();
			if (!workingCopy) modelReference.dispose();
			throw error;
		}
		const shouldRestoreFocus = container.contains(container.ownerDocument.activeElement);
		this.statusListener.clear();
		this.part.value = part;
		this.beforeSaveHooks = beforeSaveHooks;
		this.workingCopySlot.value = workingCopy;
		this.languageId = modelReference.model.getLanguageId();
		const statusListeners = new DisposableStore();
		if (part.onDidChangeCursorSelection) statusListeners.add(part.onDidChangeCursorSelection(() => this.statusChangeEmitter.fire()));
		if (part.onDidChangeModelContent) statusListeners.add(part.onDidChangeModelContent(() => this.statusChangeEmitter.fire()));
		statusListeners.add(modelReference.onDidChangeExternalChange(() => {
			if (modelReference.hasExternalChange) part.announceAccessibilityStatus?.("File changed on disk. Local edits are preserved.");
			this.statusChangeEmitter.fire();
		}));
		this.statusListener.value = statusListeners;
		part.layout(this.dimension);
		if (shouldRestoreFocus && !container.hidden) {
			part.focus();
		}
		this.statusChangeEmitter.fire();
	}

	clearInput(): void {
		this.statusListener.clear();
		this.part.clear();
		this.beforeSaveHooks = [];
		this.workingCopySlot.clear();
		this.languageId = undefined;
		this.statusChangeEmitter.fire();
	}

	layout(dimension: IDimension): void {
		this.dimension = {
			width: Math.max(0, dimension.width),
			height: Math.max(0, dimension.height),
		};
		this.part.value?.layout(this.dimension);
	}

	setVisible(visibility: EditorPaneVisibility): void {
		if (!this.container) return;
		this.container.hidden = visibility === EditorPaneVisibility.Hidden;
		if (visibility === EditorPaneVisibility.Visible) this.part.value?.layout(this.dimension);
	}

	focus(): void {
		this.part.value?.focus();
	}

	getValue(): string {
		return this.part.value?.getValue() ?? "";
	}

	async saveAs(resource: URI): Promise<void> {
		const workingCopy = this.workingCopy;
		if (workingCopy) {
			await workingCopy.saveAs(resource, new AbortController().signal);
			return;
		}
		await this.resourceStore.save({ resource, text: this.getValue() }, new AbortController().signal);
	}

	get isDirty(): boolean {
		return this.workingCopy?.isDirty ?? false;
	}

	get hasExternalChange(): boolean {
		return this.workingCopy?.hasExternalChange ?? false;
	}

	async save(): Promise<void> {
		for (const hook of [...this.beforeSaveHooks]) await hook();
		await this.workingCopy?.save(new AbortController().signal);
	}

	async revert(): Promise<void> {
		await this.workingCopy?.revert(new AbortController().signal);
	}

	revealRange(range: Range): void {
		this.part.value?.revealRange?.(range);
	}

	saveViewState(): unknown {
		return this.part.value?.saveViewState?.();
	}

	restoreViewState(state: unknown): void {
		if (!isCodeEditorViewState(state)) throw new TypeError("Invalid code editor view state");
		const part = this.part.value;
		if (!part?.restoreViewState) throw new Error("Stanza code editor view-state restoration is unavailable");
		part.restoreViewState(state);
	}

	getStatus(): EditorPaneStatus {
		const selections = this.part.value?.getSelections?.();
		const active = selections?.[0]?.getPosition();
		return Object.freeze({
			...(active ? { lineNumber: active.lineNumber, columnNumber: active.column } : {}),
			...(selections && selections.length > 1 ? { selectionCount: selections.length } : {}),
			...(this.languageId ? { languageId: this.languageId } : {}),
			encoding: "UTF-8",
			endOfLine: "LF",
		});
	}

	private handleSaveKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "s") return;
		stopEvent(event);
		if (this.saving) return;
		this.saving = true;
		void this.save().then(() => {
			this.part.value?.announceAccessibilityStatus?.("Saved");
		}).catch(error => {
			const message = error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : "unknown error";
			this.part.value?.announceAccessibilityStatus?.(`Save failed: ${message}`);
			(this.options.onSaveError ?? reportSaveError)(error);
		}).finally(() => {
			this.saving = false;
		});
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.container, new ReferenceError("EditorPane has not been created"));
		return this.container;
	}
}

function isCodeEditorViewState(value: unknown): value is ICodeEditorViewState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<ICodeEditorViewState>;
	return Array.isArray(state.cursorState)
		&& Boolean(state.viewState)
		&& typeof state.viewState?.scrollLeft === 'number'
		&& Boolean(state.viewState?.firstPosition);
}

function reportSaveError(error: unknown): void {
	console.error("Code editor save failed", error);
}

class EditorWorkingCopy extends Disposable implements IWorkingCopy {
	readonly resource: URI;
	readonly backupKind = "text" as const;
	readonly backupLanguageId: string | undefined;
	readonly backupContentType: string | undefined;
	readonly backupLabel: string | undefined;
	readonly onDidChangeDirty: IWorkingCopy["onDidChangeDirty"];
	readonly onDidChangeExternalChange: IWorkingCopy["onDidChangeExternalChange"];
	readonly onDidChangeContent: IWorkingCopy["onDidChangeContent"];

	constructor(
		private readonly reference: TextModelReference,
		private readonly resourceStore: ITextResourceStore,
		input: EditorInput,
		workingCopyService: IWorkingCopyService | undefined,
		private readonly saveUntitled: (() => Promise<void | boolean>) | undefined,
	) {
		super();
		this._register(reference);
		this.resource = input.resource;
		this.backupLanguageId = input.languageId;
		this.backupContentType = input.contentType;
		this.backupLabel = input.label;
		this.onDidChangeDirty = reference.onDidChangeDirty;
		this.onDidChangeExternalChange = reference.onDidChangeExternalChange;
		this.onDidChangeContent = listener => reference.model.onDidChangeContent(() => listener());
		if (workingCopyService) this._register(workingCopyService.register(this));
	}

	get isDirty(): boolean {
		return this.reference.isDirty;
	}

	get hasExternalChange(): boolean {
		return this.reference.hasExternalChange;
	}

	backup(): string {
		return this.reference.model.getText();
	}

	restoreBackup(content: string): void {
		this.reference.model.reset(content);
	}

	save(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, "Code editor working-copy save was cancelled");
		if (this.resource.scheme === "untitled") return this.saveUntitledDocument();
		return this.reference.save(signal);
	}

	async saveAs(resource: URI, signal: AbortSignal): Promise<void> {
		await this.resourceStore.save({ resource, text: this.reference.model.getText() }, signal);
	}

	revert(signal: AbortSignal): Promise<void> {
		return this.reference.revert(signal);
	}

	private async saveUntitledDocument(): Promise<void> {
		const result = await this.saveUntitled?.();
		if (result === false) return;
		if (!this.saveUntitled) throw new Error("Untitled code editor has no save handler");
	}
}
