import { type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from '../../../../base/common/event.js';
import type { Range } from '../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { assertDefined } from "../../../../base/common/types.js";
import { EditorPaneVisibility } from "../../../browser/parts/editor/editorPane.js";
import { EditorPaneSelectionChangeReason, type IEditorPaneWithSelection } from '../../../common/editor.js';
import { type EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { DIFF_EDITOR_ID, isDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
import { type ITextResourceStore } from "../../../services/textmodelResolver/common/textResourceStore.js";
import { DiffModel } from "../../../../editor/common/diff/diffModel.js";
import { type HideUnchangedRegionsOptions } from '../../../../editor/common/config/diffEditor.js';
import { type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../editor/common/diff/documentDiffProvider.js";
import { DiffEditorWidget } from "../../../../editor/browser/widget/diffEditor/diffEditorWidget.js";
import { type TextModelReference, type ITextModelResourceService } from "../../../services/textmodelResolver/common/textModelResourceService.js";
import { h } from "../../../../base/browser/dom.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { getDiffComputationOptions, getDiffWordWrap } from "../../../services/editor/common/editorConfiguration.js";
import { toEditorPaneSelectionChangeReason } from './textEditor.js';

export interface DiffEditorPaneOptions {
	readonly modelService: ITextModelResourceService;
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
export class TextDiffEditor extends Disposable implements IEditorPaneWithSelection {
	readonly id = DIFF_EDITOR_ID;
	private readonly session = this._register(new MutableDisposable<DiffEditorPaneSession>());
	private readonly selectionListener = this._register(new MutableDisposable<IDisposable>());
	private readonly selectionChangeEmitter = this._register(new Emitter<EditorPaneSelectionChangeReason>());
	readonly onDidChangeSelection = this.selectionChangeEmitter.event;
	private readonly modelService: ITextModelResourceService;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	getControl(): DiffEditorWidget | undefined {
		return this.session.value?.editor;
	}

	getSelection(): Range | undefined {
		return this.session.value?.editor.modifiedEditor.getSelection() ?? undefined;
	}

	restoreSelection(selection: Range, source: TextEditorSelectionSource): void {
		const editor = this.session.value?.editor.modifiedEditor;
		if (!editor) return;
		editor.setSelection(selection, source);
		editor.revealRange(selection);
	}

	constructor(
		private readonly resourceStore: ITextResourceStore,
		private readonly options: DiffEditorPaneOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
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
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("DiffEditorPane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "stanza-diff-editor-pane";
		parent.append(container);
		this.container = container;
		this._register(toDisposable(() => {
			container.remove();
			this.container = undefined;
		}));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isDiffEditorInput(input)) {
			throw new TypeError("Diff editor pane requires a diff editor input");
		}
		const container = this.requireContainer();
		throwIfCancelled(signal, "Diff editor input loading was cancelled");
		const original = await this.modelService.acquire(input.original, signal);
		let modified: TextModelReference | undefined;
		let next: DiffEditorPaneSession | undefined;
		try {
			throwIfCancelled(signal, "Diff editor input loading was cancelled");
			modified = await this.modelService.acquire(input.modified, signal);
			throwIfCancelled(signal, "Diff editor input loading was cancelled");
			next = this.instantiationService.createInstance(
				DiffEditorPaneSession, container, original, modified,
				input.original.label, input.modified.label, this.options,
			);
			throwIfCancelled(signal, "Diff editor input loading was cancelled");
		} catch (error) {
			next?.dispose();
			if (!next) {
				modified?.dispose();
				original.dispose();
			}
			throw error;
		}
		this.selectionListener.clear();
		this.session.value = next;
		const listeners = new DisposableStore();
		listeners.add(next.editor.modifiedEditor.onDidChangeCursorSelection(event => {
			this.selectionChangeEmitter.fire(toEditorPaneSelectionChangeReason(event.source));
		}));
		listeners.add(next.editor.modifiedEditor.onDidChangeModelContent(() => {
			this.selectionChangeEmitter.fire(EditorPaneSelectionChangeReason.EDIT);
		}));
		this.selectionListener.value = listeners;
		next.layout(this.dimension);
	}

	clearInput(): void {
		this.selectionListener.clear();
		this.session.clear();
	}

	layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.session.value?.layout(this.dimension);
	}

	setVisible(visibility: EditorPaneVisibility): void {
		if (!this.container) return;
		this.container.hidden = visibility === EditorPaneVisibility.Hidden;
		if (visibility === EditorPaneVisibility.Visible) this.session.value?.layout(this.dimension);
	}

	focus(): void {
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
	private readonly model: DiffModel;

	constructor(
		container: HTMLElement,
		original: TextModelReference,
		modified: TextModelReference,
		originalLabel: string | undefined,
		modifiedLabel: string | undefined,
		options: DiffEditorPaneOptions,
		@IConfigurationService configuration: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(original);
		this._register(modified);
		const computationService = options.createComputationService();
		if (!computationService || typeof computationService.computeDiff !== "function") {
			throw new TypeError("Diff editor pane factory returned an invalid Workbench diff computation service");
		}
		this._register(computationService);
		const model = this.model = this._register(new DiffModel({
			original: original.model,
			modified: modified.model,
			diffProvider: computationService,
			diffOptions: getDiffComputationOptions(configuration, modified.model.getLanguageId()),
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			const languageId = model.modified.getLanguageId();
			if (event.affectsConfiguration("diffEditor.wordWrap") || event.affectsConfiguration("editor.wordWrap")) {
				this.editor.setConfiguredWordWrap(getDiffWordWrap(configuration));
			}
			if (event.affectsConfiguration("diffEditor.ignoreTrimWhitespace", { overrideIdentifier: languageId })
				|| event.affectsConfiguration("diffEditor.maxComputationTime", { overrideIdentifier: languageId })) {
				this.updateOptions(getDiffComputationOptions(configuration, languageId));
			}
			if (event.affectsConfiguration("diffEditor.hideUnchangedRegions.enabled")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.contextLineCount")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.minimumLineCount")
				|| event.affectsConfiguration("diffEditor.hideUnchangedRegions.revealLineCount")) {
				this.editor.setHideUnchangedRegionsOptions(getHideUnchangedRegionsOptions(configuration));
			}
			if (event.affectsConfiguration('diffEditor.renderSideBySide')
				|| event.affectsConfiguration('diffEditor.useInlineViewWhenSpaceIsLimited')) {
				this.editor.setViewMode(
					configuration.getValue('diffEditor.renderSideBySide'),
					configuration.getValue('diffEditor.useInlineViewWhenSpaceIsLimited'),
				);
			}
		}));
		this._register(modified.model.onDidChangeLanguage(() => {
			this.updateOptions(getDiffComputationOptions(configuration, model.modified.getLanguageId()));
		}));
		this.editor = this._register(instantiationService.createInstance(DiffEditorWidget, {
			container,
			model,
			wordWrap: getDiffWordWrap(configuration),
			renderSideBySide: configuration.getValue('diffEditor.renderSideBySide'),
			useInlineViewWhenSpaceIsLimited: configuration.getValue('diffEditor.useInlineViewWhenSpaceIsLimited'),
			hideUnchangedRegions: getHideUnchangedRegionsOptions(configuration),
			lineHeight: options.lineHeight,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			showLineNumbers: options.showLineNumbers,
			showInlineChanges: options.showInlineChanges,
			loopChanges: options.loopChanges,
			originalAriaLabel: originalLabel,
			modifiedAriaLabel: modifiedLabel,
		}));
	}

	updateOptions(options: IDocumentDiffProviderOptions): void {
		this.model.updateOptions(options);
	}

	layout(dimension: IDimension): void {
		this.editor.layout(dimension);
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
