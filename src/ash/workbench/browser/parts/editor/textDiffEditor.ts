import type { CodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import { EditorWorkingCopy } from './textResourceEditor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from '../../../../base/common/event.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { assertDefined } from "../../../../base/common/types.js";
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorPaneSelectionChangeReason, type IEditorPaneWithSelection, type IEditorPaneWithScrolling, type IEditorPaneScrollPosition, type IResourceEditorInput, type ISaveOptions } from '../../../common/editor.js';

import { DIFF_EDITOR_ID, isDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
import { BaseTextEditorModel } from '../../../common/editor/textEditorModel.js';
import { TextDiffEditorModel } from '../../../common/editor/textDiffEditorModel.js';
import { applyTextEditorOptions } from '../../../common/editor/editorOptions.js';
import { type ITextResourceStore } from "../../../services/textmodelResolver/common/textResourceStore.js";
import { DiffModel } from "../../../../editor/common/diff/diffModel.js";
import { type HideUnchangedRegionsOptions } from '../../../../editor/common/config/diffEditor.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../editor/common/diff/documentDiffProvider.js";
import { DiffEditorWidget } from "../../../../editor/browser/widget/diffEditor/diffEditorWidget.js";
import { type TextModelReference, type ITextModelResourceService } from "../../../services/textmodelResolver/common/textModelResourceService.js";
import { h } from "../../../../base/browser/dom.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { getDiffComputationOptions, getDiffWordWrap } from "../../../services/editor/common/editorConfiguration.js";
import { toEditorPaneSelectionChangeReason } from './textEditor.js';
import { editorOptionsRegistry, type IDiffEditorOptions, type IEditorOptions } from '../../../../editor/common/config/editorOptions.js';

export interface DiffEditorPaneOptions extends Pick<CodeEditorWidgetOptions, 'onOpenLocation' | 'onApplyWorkspaceEdit'> {
	readonly modelService: ITextModelResourceService;
	/** The pane owns this provider across input changes; models cancel their own requests. */
	readonly createComputationService: () => IDocumentDiffProvider & IDisposable;
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
}

/** Workbench pane that owns an editable comparison over two acquired text references. */
export class TextDiffEditor extends EditorPane implements IEditorPaneWithSelection, IEditorPaneWithScrolling {
	private readonly scrollChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChangeScroll = this.scrollChangeEmitter.event;
	readonly id = DIFF_EDITOR_ID;
	private readonly session = this._register(new MutableDisposable<DiffEditorPaneSession>());
	private readonly selectionListener = this._register(new MutableDisposable<IDisposable>());
	private readonly selectionChangeEmitter = this._register(new Emitter<EditorPaneSelectionChangeReason>());
	readonly onDidChangeSelection = this.selectionChangeEmitter.event;
	private readonly modelService: ITextModelResourceService;
	private readonly computationService: IDocumentDiffProvider & IDisposable;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	public get workingCopy(): IWorkingCopy | undefined { return this.session.value?.workingCopy; }

	async save(options?: ISaveOptions): Promise<void> {
		await this.workingCopy?.save(new AbortController().signal, options);
	}

	public override getControl(): DiffEditorWidget | undefined {
		return this.session.value?.editor;
	}

	getScrollPosition(): IEditorPaneScrollPosition {
		const editor = this.getControl()?.modifiedEditor;
		return { scrollTop: editor?.getScrollTop() ?? 0, scrollLeft: editor?.getScrollLeft() };
	}

	setScrollPosition(position: IEditorPaneScrollPosition): void {
		this.getControl()?.modifiedEditor.setScrollPosition(position);
	}

	getSelection(): Range | undefined {
		return this.session.value?.editor.modifiedEditor.getSelection() ?? undefined;
	}

	revealRange(range: Range): void {
		const editor = this.session.value?.editor.modifiedEditor;
		editor?.setSelection(range);
		editor?.revealRange(range);
		editor?.focus();
	}

	restoreSelection(selection: Range, source: TextEditorSelectionSource): void {
		this.session.value?.restoreSelection(selection, source);
	}

	constructor(
		private readonly resourceStore: ITextResourceStore,
		private readonly options: DiffEditorPaneOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(DIFF_EDITOR_ID, themeService, storageService);
		if (!resourceStore || typeof resourceStore.resolve !== "function") {
			this.dispose();
			throw new TypeError("Diff editor pane requires a text resource store");
		}
		if (!options || typeof options !== "object" || typeof options.createComputationService !== "function") {
			this.dispose();
			throw new TypeError("Diff editor pane requires a Workbench diff computation service");
		}
		if (!options.modelService || typeof options.modelService.acquire !== "function") {
			this.dispose();
			throw new TypeError("Diff editor pane requires a text model service");
		}
		this.modelService = options.modelService;
		let computationService: IDocumentDiffProvider & IDisposable;
		try { computationService = options.createComputationService(); }
		catch (error) { this.dispose(); throw error; }
		if (!computationService || typeof computationService.computeDiff !== 'function') {
			this.dispose();
			throw new TypeError('Diff editor pane factory returned an invalid Workbench diff computation service');
		}
		this.computationService = this._register(computationService);
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("DiffEditorPane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "stanza-diff-editor-pane";
		parent.append(container);
		super.create(container);
		this.container = container;
		this._register(toDisposable(() => {
			container.remove();
			this.container = undefined;
		}));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isDiffEditorInput(input)) {
			throw new TypeError("Diff editor pane requires a diff editor input");
		}
		const container = this.requireContainer();
		throwIfCancelled(signal, "Diff editor input loading was cancelled");
		using references = new DisposableStore();
		const acquisition = new AbortController();
		const acquisitionSignal = AbortSignal.any([signal, acquisition.signal]);
		const acquire = async (side: IResourceEditorInput): Promise<TextModelReference> => {
			const reference = await this.modelService.acquire(side, acquisitionSignal, { waitForSyntax: false });
			// A sibling can fail before this acquisition settles. A late reference
			// still needs releasing even when its resolver did not honor cancellation.
			if (references.isDisposed) reference.dispose();
			else references.add(reference);
			return reference;
		};
		let original: TextModelReference | undefined;
		let modified: TextModelReference | undefined;
		let next: DiffEditorPaneSession | undefined;
		try {
			[original, modified] = await Promise.all([acquire(input.original), acquire(input.modified)]);
			references.delete(original);
			references.delete(modified);
			throwIfCancelled(signal, "Diff editor input loading was cancelled");
			next = this.instantiationService.createInstance(
				DiffEditorPaneSession, container, original, modified,
				input.original.label, input.modified, this.options, this.computationService,
			);
			// The host keeps this candidate hidden. Build its controls while syntax
			// initializes, then publish only when both lexical sides and the diff are ready.
			await Promise.all([
				next.waitForDiff(acquisitionSignal),
				original.model.tokenization.whenReady(acquisitionSignal),
				modified.model.tokenization.whenReady(acquisitionSignal),
			]);
			throwIfCancelled(signal, "Diff editor input loading was cancelled");
		} catch (error) {
			acquisition.abort();
			next?.dispose();
			if (!next) {
				modified?.dispose();
				original?.dispose();
			}
			throw error;
		}
		this.selectionListener.clear();
		this.session.value = next;
		const listeners = new DisposableStore();
		listeners.add(next.editor.modifiedEditor.onDidScrollChange(() => this.scrollChangeEmitter.fire()));
		listeners.add(next.editor.modifiedEditor.onDidChangeCursorSelection(event => {
			this.selectionChangeEmitter.fire(toEditorPaneSelectionChangeReason(event.source));
		}));
		listeners.add(next.editor.modifiedEditor.onDidChangeModelContent(() => {
			this.selectionChangeEmitter.fire(EditorPaneSelectionChangeReason.EDIT);
		}));
		this.selectionListener.value = listeners;
		next.layout(this.dimension);
	}

	public override clearInput(): void {
		this.selectionListener.clear();
		this.session.clear();
	}

	public override layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.session.value?.layout(this.dimension);
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		const session = this.session.value;
		if (!session) return;
		if (visibility) {
			session.editor.originalEditor.onVisible();
			session.editor.modifiedEditor.onVisible();
			session.layout(this.dimension);
		} else {
			session.editor.originalEditor.onHide();
			session.editor.modifiedEditor.onHide();
		}
	}

	public override focus(): void {
		this.session.value?.focus();
	}

	toggleWordWrap(): void {
		this.session.value?.editor.toggleWordWrap();
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.container, new ReferenceError("Diff editor pane has not been created"));
		return this.container;
	}
}

class DiffEditorPaneSession extends Disposable {
	readonly editor: DiffEditorWidget;
	readonly workingCopy: IWorkingCopy | undefined;
	private readonly model: DiffModel;
	private initialRevealPending = true;

	constructor(
		container: HTMLElement,
		original: TextModelReference,
		modified: TextModelReference,
		originalLabel: string | undefined,
		modifiedInput: IResourceEditorInput,
		options: DiffEditorPaneOptions,
		computationService: IDocumentDiffProvider,
		@IConfigurationService configuration: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
	) {
		super();
		this._register(original);
		// Widgets must detach before their last model reference is released.
		this.workingCopy = modifiedInput.readOnly ? undefined : this._register(new EditorWorkingCopy(modified, modifiedInput, workingCopies, undefined));
		if (!this.workingCopy) this._register(modified);
		const originalEditorModel = this._register(new BaseTextEditorModel(original.model));
		const modifiedEditorModel = this._register(new BaseTextEditorModel(modified.model, modifiedInput.readOnly === true));
		const editorModel = this._register(new TextDiffEditorModel(originalEditorModel, modifiedEditorModel));
		const textModels = editorModel.textDiffEditorModel;
		assertDefined(textModels, new ReferenceError('Diff editor requires two resolved text models'));
		const model = this.model = this._register(new DiffModel({
			original: textModels.original,
			modified: textModels.modified,
			diffProvider: computationService,
			diffOptions: getDiffComputationOptions(configuration, modified.model.getLanguageId()),
		}));
		const readEditorOptions = (): IDiffEditorOptions => {
			const languageId = model.modified.getLanguageId();
			const configured = getEditorOptions(configuration, languageId);
			return {
				...configured,
				readOnly: editorModel.isReadonly(),
				lineNumbers: options.showLineNumbers === false ? 'off' : configured.lineNumbers,
				lineNumbersMinChars: 3,
				lineDecorationsWidth: '2ch',
				fontFamily: options.fontFamily ?? (configured.fontFamily || undefined),
				fontSize: options.fontSize ?? configured.fontSize,
				lineHeight: options.lineHeight ?? configured.lineHeight,
				fontLigatures: options.fontLigatures ?? configured.fontLigatures,
				wordWrap: getDiffWordWrap(configuration, languageId),
				diffCodeLens: configuration.getValue<boolean>('diffEditor.codeLens', { overrideIdentifier: languageId }) ?? false,
			};
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			const languageId = model.modified.getLanguageId();
			if (event.affectsConfiguration('editor', { overrideIdentifier: languageId })
				|| event.affectsConfiguration('diffEditor.wordWrap', { overrideIdentifier: languageId })
				|| event.affectsConfiguration('diffEditor.codeLens', { overrideIdentifier: languageId })) {
				this.editor.updateOptions(readEditorOptions());
			}
			if (event.affectsConfiguration("diffEditor.ignoreTrimWhitespace", { overrideIdentifier: languageId })
				|| event.affectsConfiguration("diffEditor.maxComputationTime", { overrideIdentifier: languageId })
				|| event.affectsConfiguration('diffEditor.experimental.showMoves')) {
				this.updateOptions(getDiffComputationOptions(configuration, languageId));
			}
			if (event.affectsConfiguration("diffEditor.hideUnchangedRegions.enabled")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.contextLineCount")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.minimumLineCount")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.revealLineCount")) {
				this.editor.setHideUnchangedRegionsOptions(getHideUnchangedRegionsOptions(configuration));
			}
			if (event.affectsConfiguration('diffEditor.renderSideBySide')
				|| event.affectsConfiguration('diffEditor.useInlineViewWhenSpaceIsLimited')
				|| event.affectsConfiguration('diffEditor.renderSideBySideInlineBreakpoint')) {
				this.editor.setViewMode(
					configuration.getValue('diffEditor.renderSideBySide'),
					configuration.getValue('diffEditor.useInlineViewWhenSpaceIsLimited'),
					configuration.getValue('diffEditor.renderSideBySideInlineBreakpoint'),
				);
			}
			if (event.affectsConfiguration('diffEditor.enableSplitViewResizing')
				|| event.affectsConfiguration('diffEditor.splitViewDefaultRatio')) {
				this.editor.setSplitViewOptions(
					configuration.getValue('diffEditor.enableSplitViewResizing'),
					configuration.getValue('diffEditor.splitViewDefaultRatio'),
				);
			}
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.DiffEditor)) {
				this.editor.setAccessibilityHelpHint(configuration.getValue(AccessibilityVerbositySettingId.DiffEditor));
			}
		}));
		this._register(modified.model.onDidChangeLanguage(() => {
			const languageId = model.modified.getLanguageId();
			this.updateOptions(getDiffComputationOptions(configuration, languageId));
			this.editor.updateOptions(readEditorOptions());
		}));
		this.editor = this._register(instantiationService.createInstance(DiffEditorWidget, {
			...readEditorOptions(),
			container,
			model,
			onOpenLocation: options.onOpenLocation,
			onApplyWorkspaceEdit: options.onApplyWorkspaceEdit,
			readOnly: editorModel.isReadonly(),
			renderSideBySide: configuration.getValue('diffEditor.renderSideBySide'),
			useInlineViewWhenSpaceIsLimited: configuration.getValue('diffEditor.useInlineViewWhenSpaceIsLimited'),
			renderSideBySideInlineBreakpoint: configuration.getValue('diffEditor.renderSideBySideInlineBreakpoint'),
			enableSplitViewResizing: configuration.getValue('diffEditor.enableSplitViewResizing'),
			splitViewDefaultRatio: configuration.getValue('diffEditor.splitViewDefaultRatio'),
			hideUnchangedRegions: getHideUnchangedRegionsOptions(configuration),
			showLineNumbers: options.showLineNumbers,
			showInlineChanges: options.showInlineChanges,
			loopChanges: options.loopChanges,
			originalAriaLabel: originalLabel,
			modifiedAriaLabel: modifiedInput.label,
		}));
		this.editor.setAccessibilityHelpHint(configuration.getValue(AccessibilityVerbositySettingId.DiffEditor));
	}

	updateOptions(options: IDocumentDiffProviderOptions): void {
		this.model.updateOptions(options);
	}

	async waitForDiff(signal: AbortSignal): Promise<void> {
		if (this.model.state.kind !== 'loading') return;
		using listeners = new DisposableStore();
		await raceCancellationError(new Promise<void>(resolve => {
			listeners.add(this.model.onDidChange(state => {
				if (state.kind !== 'loading') resolve();
			}));
		}), signal, 'Diff editor input loading was cancelled');
	}

	restoreSelection(selection: Range, source: TextEditorSelectionSource): void {
		this.initialRevealPending = false;
		applyTextEditorOptions({ selection, selectionSource: source }, this.editor.modifiedEditor, ScrollType.Smooth);
	}

	layout(dimension: IDimension): void {
		this.editor.layout(dimension);
		// Pending panes have no viewport. Reveal after layout, before the host applies an explicit selection.
		if (this.initialRevealPending && dimension.width > 0 && dimension.height > 0) {
			this.initialRevealPending = false;
			this.editor.revealFirstDiff();
		}
	}

	focus(): void {
		this.editor.focus();
	}
}

function getHideUnchangedRegionsOptions(configuration: IConfigurationService): HideUnchangedRegionsOptions {
	return {
		enabled: configuration.getValue<boolean>("diffEditor.hideUnchangedRegions.enabled"),
		contextLineCount: configuration.getValue<number>("diffEditor.hideUnchangedRegions.contextLineCount"),
		minimumLineCount: configuration.getValue<number>("diffEditor.hideUnchangedRegions.minimumLineCount"),
		revealLineCount: configuration.getValue<number>("diffEditor.hideUnchangedRegions.revealLineCount"),
	};
}

/** Only editor-owned options cross into the widget; Workbench settings can share the namespace. */
function getEditorOptions(configuration: IConfigurationService, languageId: string): IEditorOptions {
	const values = configuration.getValue<Record<string, unknown>>('editor', { overrideIdentifier: languageId });
	return Object.fromEntries(editorOptionsRegistry
		.filter(option => values[option.name] !== undefined)
		.map(option => [option.name, values[option.name]]));
}
