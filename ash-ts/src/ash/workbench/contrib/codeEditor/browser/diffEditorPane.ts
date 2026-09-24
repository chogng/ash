import "./media/diffEditorPane.css";
import { type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { assertDefined } from "../../../../base/common/types.js";
import { type IEditorPane } from "../../../browser/parts/editor/editorPane.js";
import { EditorPaneVisibility } from "../../../browser/parts/editor/editorPane.js";
import { type EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { DIFF_EDITOR_ID, isDiffEditorInput } from "./diffEditorInput.js";
import { type ITextResourceStore } from "../../../services/textmodelResolver/common/textResourceStore.js";
import { DiffModel } from "../../../../editor/common/diff/diffModel.js";
import { type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../editor/common/diff/documentDiffProvider.js";
import { DiffEditorWidget } from "../../../../editor/browser/widget/diffEditor/diffEditorWidget.js";
import { type TextModelReference, type ITextModelResourceService } from "../../../services/textmodelResolver/common/textModelResourceService.js";
import { DiffEditorBreadcrumbsController } from "../../../../editor/contrib/diffEditorBreadcrumbs/browser/diffEditorBreadcrumbs.js";
import { h } from "../../../../base/browser/dom.js";
import { type ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeEditorConfiguration, getDiffComputationOptions, getDiffWordWrap } from '../common/editorConfiguration.js';

export interface DiffEditorPaneOptions {
	readonly modelService: ITextModelResourceService;
	readonly createComputationService: () => IDocumentDiffProvider & IDisposable;
	readonly codeEditorService: ICodeEditorService;
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
	readonly breadcrumbs?: boolean;
}

/** Workbench pane that acquires two text references for a read-only comparison. */
export class DiffEditorPane extends Disposable implements IEditorPane {
	readonly id = DIFF_EDITOR_ID;
	private readonly session = this._register(new MutableDisposable<DiffEditorPaneSession>());
	private readonly modelService: ITextModelResourceService;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

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
		this.session.value = next;
		next.layout(this.dimension);
	}

	clearInput(): void {
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
			if (event.affectsConfiguration(CodeEditorConfiguration.diffWordWrap) || event.affectsConfiguration(CodeEditorConfiguration.wordWrap)) {
				this.editor.setConfiguredWordWrap(getDiffWordWrap(configuration));
			}
			if (event.affectsConfiguration(CodeEditorConfiguration.diffIgnoreTrimWhitespace, { overrideIdentifier: languageId })
				|| event.affectsConfiguration(CodeEditorConfiguration.diffMaxComputationTime, { overrideIdentifier: languageId })) {
				this.updateOptions(getDiffComputationOptions(configuration, languageId));
			}
		}));
		this._register(modified.model.onDidChangeLanguage(() => {
			this.updateOptions(getDiffComputationOptions(configuration, model.modified.getLanguageId()));
		}));
		this.editor = this._register(new DiffEditorWidget({
			container,
			model,
			wordWrap: getDiffWordWrap(configuration),
			codeEditorService: options.codeEditorService,
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
		if (options.breadcrumbs !== false) this._register(new DiffEditorBreadcrumbsController(this.editor, model));
	}

	updateOptions(options: IDocumentDiffProviderOptions): void {
		this.model.updateOptions(options);
	}

	layout(dimension: IDimension): void {
		this.editor.layout(dimension);
	}

	focus(): void {
		this.editor.element.focus({ preventScroll: true });
	}
}
