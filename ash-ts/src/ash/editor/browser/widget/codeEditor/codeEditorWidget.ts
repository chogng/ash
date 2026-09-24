import type { BracketGuideSource } from '../../viewParts/indentGuides/indentGuides.js';
import { IMarkerDecorationsService } from '../../../common/services/markerDecorations.js';
import { getClientArea, h, isHTMLElement, scheduleAtNextAnimationFrame } from "../../../../base/browser/dom.js";
import { type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { trackFocus, type IFocusTracker } from '../../../../base/browser/focus.js';
import { type IMouseWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { Selection, type ISelection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { Range, type IRange } from "../../../common/core/range.js";
import { TextModel } from "../../../common/model/textModel.js";
import { type ICursorStateComputer, type IIdentifiedSingleEditOperation, type IModelDecoration, type IModelDecorationsChangeAccessor, type IModelDeltaDecoration, type ITextModel } from '../../../common/model.js';
import { type IModelContentChangedEvent, type IModelDecorationsChangedEvent } from '../../../common/textModelEvents.js';
import { Handler, ScrollType, type CompositionTypePayload, type ICommand, type IEditorAction, type ICodeEditorViewState, type IEditorDecorationsCollection, type IModelChangedEvent, type INewScrollPosition, type ReplacePreviousCharPayload, type TypePayload } from '../../../common/editorCommon.js';
import { VerticalRevealType } from '../../../common/viewEvents.js';
import type { ICodeEditor, IContentWidget, IEditorMouseEvent, IGlyphMarginWidget, IOverlayWidget, IOverviewRuler, IPartialEditorMouseEvent, PastePayload, IViewZoneChangeAccessor } from '../../editorBrowser.js';
import { View, type EditorTextDirection, type EditorViewportPresentation } from '../../view.js';
import { KeyboardNavigationController, ViewController } from "../../view/viewController.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { CodeEditorContributions } from "./codeEditorContributions.js";
import { EditorConfiguration, type IEditorConstructionOptions } from '../../config/editorConfiguration.js';
import { migrateOptions } from '../../config/migrateOptions.js';
import { EditorExtensionsRegistry, type EditorCommandEvent, type EditorContributionRegistration, type TextEditorContributionContext } from '../../editorExtensions.js';
import { IVersionedEditorWorkerClient, VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from '../../services/editorWorkerService.js';
import { EditorWorker } from '../../../common/services/editorWebWorker.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type EditorIndentationOptions } from '../../../common/core/misc/indentation.js';
import { type ConfigurationChangedEvent, EditorLineWrapping, EditorOption, type EditorLayoutInfo, type FindComputedEditorOptionValueById, type IComputedEditorOptions, type IEditorOptions, WrappingIndent } from '../../../common/config/editorOptions.js';
import { type LanguageCompletionWorkerFactory, type LanguageLocation, type LanguageWorkspaceEdit, type LanguageDiagnosticsHost } from '../../../common/languages.js';
import { isCompletionsEnablement, type CompletionsEnablement } from '../../../common/services/completionsEnablement.js';
import { type SemanticTokenSource } from '../../viewParts/viewLines/viewLine.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { applyFontInfo } from '../../config/domFontInfo.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IClipboardCopyEvent, type IClipboardPasteEvent } from '../../controller/editContext/clipboardUtils.js';
import { DOMLineBreaksComputerFactory } from '../../view/domLineBreaksComputer.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';
import { ViewModel } from '../../../common/viewModel/viewModelImpl.js';
import { OutgoingViewModelEventKind } from '../../../common/viewModelEventDispatcher.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EditSources, TextModelEditSource } from '../../../common/textModelEditSource.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { type IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { InternalEditorAction } from '../../../common/editorAction.js';
import { type ICursorPositionChangedEvent, type ICursorSelectionChangedEvent } from '../../../common/cursorEvents.js';

export interface EditorSectionHeaderOptions {
	readonly showRegionSectionHeaders?: boolean;
	readonly showMarkSectionHeaders?: boolean;
	readonly markSectionHeaderRegex?: string;
}

/** Internal services and host callbacks used while constructing one code editor widget. */
export interface CodeEditorWidgetOptions extends IEditorConstructionOptions {
	readonly container: HTMLElement;
	readonly model: TextModel | null;
	readonly ownerId?: string;
	readonly editorWorkerFactory?: VersionedEditorWorkerFactory;
	readonly completionWorkerFactory?: LanguageCompletionWorkerFactory;
	readonly languageDiagnosticsService?: LanguageDiagnosticsHost;
	readonly onLanguageError?: (error: unknown) => void;
	readonly onOpenLink?: (target: string) => void | Promise<void>;
	readonly onExecuteEditorCommand?: (id: string, args: readonly unknown[] | undefined) => void | Promise<void>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
	readonly registerBeforeSave?: (hook: () => void | Promise<void>) => IDisposable;
	readonly onContributionError?: (error: unknown) => void;
	/** Omit to use the registered set; an array selects exactly those contributions. */
	readonly contributions?: readonly EditorContributionRegistration[];
	readonly sectionHeaders?: EditorSectionHeaderOptions | false;
	readonly suggestions?: CompletionsEnablement;
	readonly inlineCompletions?: CompletionsEnablement;
	readonly indentation?: EditorIndentationOptions;
	readonly lineWrapping?: EditorLineWrapping;
	readonly presentation?: EditorViewportPresentation;
	readonly textDirection?: EditorTextDirection;
	readonly showSymbolIcons?: boolean;
	readonly occurrencesHighlightDelay?: number;
	readonly selectionHighlightMaxLength?: number;
	readonly selectionHighlightMultiline?: boolean;
	readonly codeLens?: boolean;
	readonly formatOnSave?: boolean;
	readonly insertFinalNewLine?: boolean;
	readonly showUnicodeHighlights?: boolean;
	readonly placeholder?: string;
	readonly isSimpleWidget?: boolean;
	readonly contextMenuId?: MenuId;
}

export type CodeEditorViewState = ICodeEditorViewState;

let decorationOwnerPool = 0;

interface CodeEditorModelState {
	model: TextModel;
	view: View;
	contributions: CodeEditorContributions;
	viewModel: ViewModel;
}

/**
 * Canonical browser editing surface for one Stanza text model and editor-local selection controller.
 *
 * Callers retain ownership of the model. The widget owns its editor-local selections, DOM
 * projection, native text input, keyboard navigation, and pointer selection. Optional drop/paste
 * behavior belongs to the host's contribution composition.
 */
export class CodeEditorWidget extends Disposable implements ICodeEditor {
	private readonly disposeEmitter = this._register(new Emitter<void>());
	private readonly keyDownEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly keyUpEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly focusEditorTextEmitter = this._register(new Emitter<void>());
	private readonly blurEditorTextEmitter = this._register(new Emitter<void>());
	private readonly focusEditorWidgetEmitter = this._register(new Emitter<void>());
	private readonly blurEditorWidgetEmitter = this._register(new Emitter<void>());
	private readonly contextMenuEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseMoveEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseLeaveEmitter = this._register(new Emitter<IPartialEditorMouseEvent>());
	private readonly mouseDownEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseUpEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseDragEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseDropEmitter = this._register(new Emitter<IPartialEditorMouseEvent>());
	private readonly mouseDropCanceledEmitter = this._register(new Emitter<void>());
	private readonly dropIntoEditorEmitter = this._register(new Emitter<{ readonly position: Position; readonly event: DragEvent }>());
	private readonly mouseWheelEmitter = this._register(new Emitter<IMouseWheelEvent>());
	private readonly changeEmitter = this._register(new Emitter<IModelContentChangedEvent>());
	private readonly modelWillChangeEmitter = this._register(new Emitter<IModelChangedEvent>());
	private readonly modelChangeEmitter = this._register(new Emitter<IModelChangedEvent>());
	private readonly modelDecorationsEmitter = this._register(new Emitter<IModelDecorationsChangedEvent>());
	private readonly readOnlyEditEmitter = this._register(new Emitter<void>());
	private readonly layoutChangeEmitter = this._register(new Emitter<EditorLayoutInfo>());
	private readonly cursorPositionEmitter = this._register(new Emitter<ICursorPositionChangedEvent>());
	private readonly cursorSelectionEmitter = this._register(new Emitter<ICursorSelectionChangedEvent>());
	private readonly compositionStartEmitter = this._register(new Emitter<void>());
	private readonly compositionEndEmitter = this._register(new Emitter<void>());
	private readonly typeEmitter = this._register(new Emitter<string>());
	private readonly pasteEmitter = this._register(new Emitter<IClipboardPasteEvent>());
	private readonly willCopyEmitter = this._register(new Emitter<IClipboardCopyEvent>());
	private readonly willCutEmitter = this._register(new Emitter<IClipboardCopyEvent>());
	private readonly willPasteEmitter = this._register(new Emitter<IClipboardPasteEvent>());
	readonly onDidDispose = this.disposeEmitter.event;
	readonly onDidChangeConfiguration: Event<ConfigurationChangedEvent>;
	readonly onDidChangeModelContent = this.changeEmitter.event;
	readonly onWillChangeModel = this.modelWillChangeEmitter.event;
	readonly onDidChangeModel = this.modelChangeEmitter.event;
	readonly onDidChangeModelDecorations = this.modelDecorationsEmitter.event;
	readonly onDidAttemptReadOnlyEdit = this.readOnlyEditEmitter.event;
	readonly onDidLayoutChange = this.layoutChangeEmitter.event;
	readonly onDidChangeCursorPosition = this.cursorPositionEmitter.event;
	readonly onDidChangeCursorSelection = this.cursorSelectionEmitter.event;
	readonly onDidFocusEditorText = this.focusEditorTextEmitter.event;
	readonly onDidBlurEditorText = this.blurEditorTextEmitter.event;
	readonly onDidFocusEditorWidget = this.focusEditorWidgetEmitter.event;
	readonly onDidBlurEditorWidget = this.blurEditorWidgetEmitter.event;
	readonly onDidCompositionStart = this.compositionStartEmitter.event;
	readonly onDidCompositionEnd = this.compositionEndEmitter.event;
	readonly onDidType = this.typeEmitter.event;
	readonly onDidPaste = this.pasteEmitter.event;
	readonly onWillCopy = this.willCopyEmitter.event;
	readonly onWillCut = this.willCutEmitter.event;
	readonly onWillPaste = this.willPasteEmitter.event;
	readonly onKeyDown = this.keyDownEmitter.event;
	readonly onKeyUp = this.keyUpEmitter.event;
	readonly onContextMenu = this.contextMenuEmitter.event;
	readonly onMouseMove = this.mouseMoveEmitter.event;
	readonly onMouseLeave = this.mouseLeaveEmitter.event;
	readonly onMouseDown = this.mouseDownEmitter.event;
	readonly onMouseUp = this.mouseUpEmitter.event;
	readonly onMouseDrag = this.mouseDragEmitter.event;
	readonly onMouseDrop = this.mouseDropEmitter.event;
	readonly onMouseDropCanceled = this.mouseDropCanceledEmitter.event;
	readonly onDropIntoEditor = this.dropIntoEditorEmitter.event;
	readonly onMouseWheel = this.mouseWheelEmitter.event;
	readonly isSimpleWidget: boolean;
	readonly contextMenuId: MenuId;
	private modelState: CodeEditorModelState | null = null;
	private readonly ownerId: string;
	private instantiationService!: IInstantiationService;
	private readonly editorServices!: IInstantiationService;
	private readonly contextKeyService!: IContextKeyService;
	private readonly modelSlot = this._register(new MutableDisposable<DisposableStore>());
	private modelGeneration = 0;
	private readonly contentWidgets = new Map<string, IContentWidget>();
	private readonly overlayWidgets = new Map<string, IOverlayWidget>();
	private readonly glyphWidgets = new Map<string, IGlyphMarginWidget>();
	private readonly rootDomNode!: HTMLDivElement;
	private readonly widgetFocus!: IFocusTracker;
	private readonly constructionOptions!: Omit<CodeEditorWidgetOptions, 'model'>;
	private readonly onLanguageError!: (error: unknown) => void;
	private readonly configuration: EditorConfiguration;
	private readonly decorationOwnerId = ++decorationOwnerPool;

	private get activeState(): CodeEditorModelState {
		if (!this.modelState) throw new ReferenceError('Code editor has no attached model');
		return this.modelState;
	}
	private get currentModel(): TextModel | null {
		return this.modelState?.model ?? null;
	}
	public get controller(): ViewController {
		return this.view.controller;
	}
	public get view(): View {
		return this.activeState.view;
	}
	private get contributions(): CodeEditorContributions {
		return this.activeState.contributions;
	}
	private get viewModel(): ViewModel {
		return this.activeState.viewModel;
	}

	constructor(
		options: CodeEditorWidgetOptions,
		@IInstantiationService private readonly rootServices: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
		@ILanguageConfigurationService private readonly languageConfigurationService: ILanguageConfigurationService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		this.ownerId = options.ownerId ?? `ash-code-editor-${this.decorationOwnerId}`;
		this.codeEditorService.willCreateCodeEditor();
		try {
			validateOptions(options);
			migrateOptions(options);
			const { model: initialModel, ...constructionOptions } = options;
			this.constructionOptions = constructionOptions;
			this.instantiationService = this.rootServices;
			this.onLanguageError = options.onLanguageError ?? options.onContributionError ?? reportLanguageError;
			this.configuration = this._register(this.rootServices.createInstance(EditorConfiguration,
				options.isSimpleWidget ?? false,
				options.contextMenuId ?? (options.isSimpleWidget ? MenuId.SimpleEditorContext : MenuId.EditorContext),
				{
				...constructionOptions,
				lineNumbers: options.lineNumbers ?? (options.presentation === 'embedded' ? 'off' : undefined),
				minimap: { ...options.minimap, enabled: options.minimap?.enabled ?? options.presentation !== 'embedded' },
				guides: {
					...options.guides,
					indentation: options.guides?.indentation ?? options.presentation !== 'embedded',
				},
				renderLineHighlight: options.renderLineHighlight ?? (options.presentation === 'embedded' ? 'none' : undefined),
				wordWrap: options.wordWrap ?? (options.lineWrapping === EditorLineWrapping.On ? 'on' : 'off'),
				padding: options.padding === undefined ? undefined : {
					top: options.padding.top ?? 0,
					bottom: options.padding.bottom ?? 0,
				},
				},
				options.container,
			));
			this.isSimpleWidget = this.configuration.isSimpleWidget;
			this.contextMenuId = this.configuration.contextMenuId;
			this.onDidChangeConfiguration = this.configuration.onDidChange;
			this.rootDomNode = h(options.container.ownerDocument, 'div');
			options.container.append(this.rootDomNode);
			this._register(toDisposable(() => this.rootDomNode.remove()));
			this.widgetFocus = this._register(trackFocus(this.rootDomNode));
			this._register(this.widgetFocus.onDidFocus(() => this.focusEditorWidgetEmitter.fire()));
			this._register(this.widgetFocus.onDidBlur(() => this.blurEditorWidgetEmitter.fire()));
			const editorServices = this.editorServices = this._register(this.rootServices.createChild());
			this.contextKeyService = this._register(contextKeyService.createScoped(this.rootDomNode));
			editorServices.registerInstance(IContextKeyService, this.contextKeyService);
			this.instantiationService = this.editorServices;
			if (initialModel) {
				this.attachModel(initialModel);
			}
			if (new.target === CodeEditorWidget) {
				this.registerWithService();
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Subclasses register after their own state is ready for creation listeners. */
	protected registerWithService(): void {
		this._register(toDisposable(() => this.codeEditorService.removeCodeEditor(this)));
		try {
			this.codeEditorService.addCodeEditor(this);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private attachModel(model: TextModel): void {
		const options = this.constructionOptions;
		const modelStore = new DisposableStore();
		this.modelSlot.value = modelStore;
		try {
			const services = modelStore.add(this.editorServices.createChild());
			this.instantiationService = services;
			const logService = services.getOptional(ILogService);
			const themeService = this.themeService;
			const languageConfigurationService = this.languageConfigurationService;
			const languageFeaturesService = this.languageFeaturesService;
			const onLanguageError = this.onLanguageError;
			const editorWorker = modelStore.add(options.editorWorkerFactory
				? options.editorWorkerFactory(model)
				: new VersionedEditorWorkerClient(model, () => new EditorWorker()));
			services.registerInstance(IVersionedEditorWorkerClient, editorWorker);
			this.configuration.setIsDominatedByLongLines(model.isDominatedByLongLines());
			this.configuration.setModelLineCount(model.lineCount);
			modelStore.add(model.onDidChangeDecorations(event => this.modelDecorationsEmitter.fire(event)));
			modelStore.add(model.onWillDispose(() => this.setModel(null)));
			const attachedView = model.onBeforeAttached();
			modelStore.add(toDisposable(() => model.onBeforeDetached(attachedView)));
			const ownerWindow = options.container.ownerDocument.defaultView;
			if (!ownerWindow) throw new ReferenceError('Code editor requires a browser window');
			const viewModel = modelStore.add(new ViewModel(
				this.decorationOwnerId,
				this.configuration,
				model,
				DOMLineBreaksComputerFactory.create(ownerWindow),
				MonospaceLineBreaksComputerFactory.create(this.configuration.options),
				callback => scheduleAtNextAnimationFrame(ownerWindow, callback),
				languageConfigurationService,
				themeService,
				attachedView,
				{ batchChanges: callback => callback() },
			));
			modelStore.add(viewModel.onEvent(event => {
				if (event.kind === OutgoingViewModelEventKind.ModelContentChanged) {
					this.changeEmitter.fire(event.event);
					return;
				}
				if (event.kind === OutgoingViewModelEventKind.ReadOnlyEditAttempt) {
					this.readOnlyEditEmitter.fire();
					return;
				}
				if (event.kind !== OutgoingViewModelEventKind.CursorStateChanged) return;
				const primary = event.selections[0];
				if (!primary) return;
				this.cursorPositionEmitter.fire({
					position: primary.getPosition(),
					secondaryPositions: event.selections.slice(1).map(selection => selection.getPosition()),
					reason: event.reason,
					source: event.source,
				});
				this.cursorSelectionEmitter.fire({
					selection: primary,
					secondarySelections: event.selections.slice(1),
					modelVersionId: event.modelVersionId,
					oldSelections: event.oldSelections,
					oldModelVersionId: event.oldModelVersionId,
					source: event.source,
					reason: event.reason,
				});
			}));
			const commandEmitter = modelStore.add(new Emitter<EditorCommandEvent>());
			const executeCommand = <T>(commandId: string, operation: () => T): T => executeEditorCommand(commandEmitter, commandId, operation);
			const getService = services.get.bind(services);
			const getOptionalService = services.getOptional.bind(services);
			const provideService = services.registerInstance.bind(services);
			let semanticTokenSource: SemanticTokenSource | undefined;
			let bracketGuideSource: BracketGuideSource | undefined;
			const selectedContributions = options.contributions ?? EditorExtensionsRegistry.getEditorContributions();
			const contributions = modelStore.add(services.createInstance(CodeEditorContributions));
			contributions.configure(selectedContributions, {
				kind: 'text',
				renderDiagnosticDecorations: !services.has(IMarkerDecorationsService),
				options,
				model,
				viewModel,
				editorWorker,
				languageFeaturesService,
				configurations: languageConfigurationService,
				onLanguageError,
				getService,
				getOptionalService,
				provideService,
				setSemanticTokenSource: source => {
					if (semanticTokenSource) throw new Error('Text editor semantic-token source is already configured');
					semanticTokenSource = source;
				},
				setBracketGuideSource: source => {
					if (bracketGuideSource) throw new Error('Text editor bracket-guide source is already configured');
					bracketGuideSource = source;
				},
				register: value => modelStore.add(value),
			});
			const ariaLabel = options.ariaLabel ?? editorLabel(model.uri);
			const view = modelStore.add(new View({
				container: options.container,
				rootDomNode: this.rootDomNode,
				viewModel,
				configuration: this.configuration,
				theme: themeService.getColorTheme(),
				ariaLabel,
				dimension: options.dimension,
				semanticTokenSource,
				bracketGuideSource,
				textDirection: options.textDirection,
				presentation: options.presentation,
				indentation: options.indentation,
				controller: {
					ownerId: this.ownerId,
					...(logService ? { logService } : {}),
					ariaLabel,
					semanticTokenSource,
				},
			}));
			this.modelState = { model, view, viewModel, contributions };
			modelStore.add(view.onDidChangeLayout(() => this.layoutChangeEmitter.fire(this.getLayoutInfo())));
			for (const widget of this.contentWidgets.values()) this.view.addContentWidget(widget);
			for (const widget of this.overlayWidgets.values()) this.view.addOverlayWidget(widget);
			for (const widget of this.glyphWidgets.values()) this.view.addGlyphMarginWidget(widget);
			modelStore.add(this.controller.editContext.onDidCompositionStart(() => this.compositionStartEmitter.fire()));
			modelStore.add(this.controller.editContext.onDidCompositionEnd(() => this.compositionEndEmitter.fire()));
			modelStore.add(this.controller.onDidEdit(event => {
				if (event.insertedText !== undefined) this.typeEmitter.fire(event.insertedText);
			}));
			modelStore.add(this.controller.editContext.onWillPaste(event => this.pasteEmitter.fire(event)));
			modelStore.add(this.view.onWillCopy(event => this.willCopyEmitter.fire(event)));
			modelStore.add(this.view.onWillCut(event => this.willCutEmitter.fire(event)));
			modelStore.add(this.view.onWillPaste(event => this.willPasteEmitter.fire(event)));
			modelStore.add(this.controller.editContext.onDidFocus(() => {
				this.focusEditorTextEmitter.fire();
			}));
			modelStore.add(this.controller.editContext.onDidBlur(() => {
				this.blurEditorTextEmitter.fire();
			}));
			const inputEvents = view.controller.userInputEvents;
			modelStore.add(new EditorContextKeysManager(this, this.contextKeyService, languageFeaturesService));
			modelStore.add(inputEvents.onKeyDown(event => this.keyDownEmitter.fire(event)));
			modelStore.add(inputEvents.onKeyUp(event => this.keyUpEmitter.fire(event)));
			modelStore.add(inputEvents.onContextMenu(event => this.contextMenuEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseMove(event => this.mouseMoveEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseLeave(event => this.mouseLeaveEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseDown(event => this.mouseDownEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseUp(event => this.mouseUpEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseDrag(event => this.mouseDragEmitter.fire(event)));
			modelStore.add(inputEvents.onMouseDrop(event => {
				this.mouseDropEmitter.fire(event);
				const position = event.target?.position;
				if (position) this.dropIntoEditorEmitter.fire({ position, event: event.event.browserEvent as DragEvent });
			}));
			modelStore.add(inputEvents.onMouseDropCanceled(() => this.mouseDropCanceledEmitter.fire()));
			modelStore.add(inputEvents.onMouseWheel(event => this.mouseWheelEmitter.fire(event)));
			modelStore.add(toDisposable(() => {
				if (!model.isDisposed()) model.removeAllDecorationsWithOwnerId(this.decorationOwnerId);
			}));
			// Release contribution controllers before the View, including on later attach failures.
			modelStore.delete(contributions);
			modelStore.add(contributions);
			modelStore.add(new KeyboardNavigationController(view, viewModel, inputEvents));
			const installContext: TextEditorContributionContext = {
				kind: 'text',
				editor: this,
				instantiationService: this.instantiationService,
				options,
				model,
				editorWorker,
				languageFeaturesService,
				configurations: languageConfigurationService,
				controller: this.controller,
				view: this.view,
				viewModel: this.viewModel,
				onLanguageError,
				onDidExecuteCommand: commandEmitter.event,
				executeCommand,
				getService,
				getOptionalService,
				registerBeforeSave: options.registerBeforeSave,
				register: value => modelStore.add(value),
			};
			contributions.initialize(
				this,
				installContext,
				options.onContributionError,
			);
			modelStore.add(contributions.onAfterModelAttached());
		} catch (error) {
			this.modelSlot.clear();
			this.modelState = null;
			throw error;
		}
	}

	private get element(): HTMLDivElement {
		return this.rootDomNode;
	}

	setModel(model: ITextModel | null): void {
		this.assertNotDisposed();
		if (model === this.currentModel) return;
		if (model !== null && (!(model instanceof TextModel) || model.isDisposed())) {
			throw new TypeError('Code editor requires a live TextModel');
		}
		const previousModel = this.currentModel;
		const event: IModelChangedEvent = {
			oldModelUrl: previousModel?.uri ?? null,
			newModelUrl: model?.uri ?? null,
		};
		const hadTextFocus = previousModel !== null && this.view.isFocused();
		this.modelWillChangeEmitter.fire(event);
		if (this.isDisposed) {
			return;
		}
		this.modelGeneration += 1;
		this.modelState = null;
		try {
			this.modelSlot.clear();
		} catch (error) {
			this.failModelChange(previousModel);
			throw error;
		}
		this.instantiationService = this.editorServices;
		try {
			if (model) {
				this.attachModel(model);
			} else {
				this.configuration.setIsDominatedByLongLines(false);
				this.configuration.setModelLineCount(1);
				this.configuration.setViewLineCount(1);
			}
		} catch (error) {
			this.failModelChange(previousModel);
			throw error;
		}
		if (hadTextFocus && model) {
			this.focus();
		}
		this.modelChangeEmitter.fire(event);
	}

	private failModelChange(previousModel: TextModel | null): void {
		this.modelSlot.clear();
		this.modelState = null;
		this.instantiationService = this.editorServices;
		this.rootDomNode.replaceChildren();
		this.configuration.setIsDominatedByLongLines(false);
		this.configuration.setModelLineCount(1);
		this.configuration.setViewLineCount(1);
		this.modelChangeEmitter.fire({ oldModelUrl: previousModel?.uri ?? null, newModelUrl: null });
	}

	get inComposition(): boolean {
		return this.currentModel !== null && this.controller.compositionController.composing;
	}

	layout(dimension: IDimension = getClientArea(this.element)): void {
		if (!this.currentModel) {
			this.rootDomNode.style.width = `${Math.max(0, dimension.width)}px`;
			this.rootDomNode.style.height = `${Math.max(0, dimension.height)}px`;
			return;
		}
		this.view.layout({ width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) });
	}

	focus(): void {
		if (this.currentModel) this.view.focus();
		else this.rootDomNode.focus();
	}

	addContentWidget(widget: IContentWidget): void {
		this.assertNotDisposed();
		if (this.currentModel) this.view.addContentWidget(widget);
		this.contentWidgets.set(widget.getId(), widget);
	}

	getLayoutInfo(): EditorLayoutInfo {
		return this.configuration.options.get(EditorOption.layoutInfo);
	}

	createOverviewRuler(cssClassName: string): IOverviewRuler {
		return this.view.createOverviewRuler(cssClassName);
	}

	updateOptions(newOptions: Readonly<IEditorOptions> | undefined): void {
		this.configuration.updateOptions(newOptions ?? {});
	}

	getOptions(): IComputedEditorOptions {
		return this.configuration.options;
	}

	getOption<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this.configuration.options.get(id);
	}

	getRawOptions(): IEditorOptions {
		return this.configuration.getRawOptions();
	}

	getScrolledVisiblePosition(position: Position): { top: number; left: number; height: number } | null {
		if (!this.currentModel) return null;
		this.view.textModel.offsetAt(position);
		const coordinates = this.view.getPositionContentCoordinates(position);
		const scroll = this.view.currentLayout.scrollPosition;
		return { top: coordinates.top - scroll.top, left: coordinates.left - scroll.left, height: coordinates.height };
	}

	getWidthOfLine(lineNumber: number): number {
		if (!this.currentModel) return 0;
		return this.view.measureTextWidth(this.view.textModel.getLineContent(lineNumber));
	}

	createDecorationsCollection(decorations: IModelDeltaDecoration[] = []): IEditorDecorationsCollection {
		this.assertNotDisposed();
		return new EditorDecorationsCollection(this, () => this.modelGeneration, this.decorationOwnerId, decorations);
	}

	layoutContentWidget(widget: IContentWidget): void {
		if (this.currentModel) this.view.layoutContentWidget(widget);
	}

	removeContentWidget(widget: IContentWidget): void {
		this.contentWidgets.delete(widget.getId());
		this.modelState?.view.removeContentWidget(widget);
	}

	addOverlayWidget(widget: IOverlayWidget): void {
		this.assertNotDisposed();
		if (this.currentModel) this.view.addOverlayWidget(widget);
		this.overlayWidgets.set(widget.getId(), widget);
	}

	layoutOverlayWidget(widget: IOverlayWidget): void {
		if (this.currentModel) this.view.layoutOverlayWidget(widget);
	}

	removeOverlayWidget(widget: IOverlayWidget): void {
		this.overlayWidgets.delete(widget.getId());
		this.modelState?.view.removeOverlayWidget(widget);
	}

	addGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.assertNotDisposed();
		if (this.currentModel) this.view.addGlyphMarginWidget(widget);
		this.glyphWidgets.set(widget.getId(), widget);
	}

	layoutGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		if (this.currentModel) this.view.layoutGlyphMarginWidget(widget);
	}

	removeGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.glyphWidgets.delete(widget.getId());
		this.modelState?.view.removeGlyphMarginWidget(widget);
	}

	changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): void {
		if (this.currentModel) this.view.changeViewZones(callback);
	}

	announceAccessibilityStatus(message: string): void {
		this.view.announceAccessibilityStatus(message);
	}

	getValue(): string {
		return this.currentModel?.getText() ?? '';
	}

	setValue(value: string): void {
		if (!this.currentModel) return;
		this.currentModel.setValue(value);
	}

	revealRange(range: Range, scrollType: ScrollType = ScrollType.Smooth): void {
		if (!this.currentModel) return;
		this.view.textModel.offsetAt(range.getStartPosition());
		this.view.textModel.offsetAt(range.getEndPosition());
		this.viewModel.revealRange('api', true, range, VerticalRevealType.Simple, scrollType);
	}

	saveViewState(): CodeEditorViewState | null {
		if (!this.currentModel) return null;
		return Object.freeze({
			cursorState: this.viewModel.saveCursorState(),
			viewState: this.viewModel.saveState(),
			contributionsState: this.contributions.saveViewState(),
		});
	}

	restoreViewState(state: CodeEditorViewState | null): void {
		if (!this.currentModel || !state) return;
		this.viewModel.restoreCursorState(state.cursorState);
		const scroll = this.viewModel.reduceRestoreState(state.viewState);
		this.view.scrollTo({ left: scroll.scrollLeft, top: scroll.scrollTop });
		this.contributions.restoreViewState(state.contributionsState ?? {});
	}

	getId(): string {
		return this.ownerId;
	}

	hasTextFocus(): boolean {
		return this.currentModel !== null && this.view.isFocused();
	}

	hasWidgetFocus(): boolean {
		return this.currentModel !== null && this.widgetFocus.hasFocus;
	}

	getModel(): TextModel | null {
		return this.currentModel;
	}

	hasModel(): boolean {
		return this.currentModel !== null;
	}

	_getViewModel(): ViewModel | null {
		return this.currentModel ? this.viewModel : null;
	}

	getPosition(): Position | null {
		return this.currentModel ? this.viewModel.getPosition() : null;
	}

	getScrollTop(): number {
		return this.currentModel ? this.view.currentLayout.scrollPosition.top : 0;
	}

	getScrollLeft(): number {
		return this.currentModel ? this.view.currentLayout.scrollPosition.left : 0;
	}

	getContentHeight(): number {
		return this.currentModel ? this.view.currentLayout.contentSize.height : 0;
	}

	getContentWidth(): number {
		return this.currentModel ? this.view.currentLayout.contentSize.width : 0;
	}

	hasPendingScrollAnimation(): boolean {
		return this.currentModel !== null && this.viewModel.viewLayout.hasPendingScrollAnimation();
	}

	getVisibleRanges(): Range[] {
		return this.currentModel ? this.viewModel.getVisibleRanges() : [];
	}

	getTopForPosition(lineNumber: number, column: number): number {
		if (!this.currentModel) return 0;
		const position = this.view.textModel.validatePosition(new Position(lineNumber, column));
		return this.view.getPositionContentCoordinates(position).top;
	}

	getTopForLineNumber(lineNumber: number): number {
		return this.getTopForPosition(lineNumber, 1);
	}

	getBottomForLineNumber(lineNumber: number): number {
		if (!this.currentModel) return 0;
		const model = this.view.textModel;
		const position = model.validatePosition(new Position(lineNumber, model.getLineMaxColumn(lineNumber)));
		const coordinates = this.view.getPositionContentCoordinates(position);
		return coordinates.top + coordinates.height;
	}

	setScrollTop(newScrollTop: number, scrollType: ScrollType = ScrollType.Immediate): void {
		this.setScrollPosition({ scrollTop: newScrollTop }, scrollType);
	}

	setScrollLeft(newScrollLeft: number, scrollType: ScrollType = ScrollType.Immediate): void {
		this.setScrollPosition({ scrollLeft: newScrollLeft }, scrollType);
	}

	setScrollPosition(position: INewScrollPosition, scrollType: ScrollType = ScrollType.Immediate): void {
		if (!this.currentModel) return;
		this.viewModel.viewLayout.setScrollPosition(position, scrollType);
	}

	getSelection(): Selection | null {
		return this.currentModel ? this.viewModel.getSelection() : null;
	}

	getSelections(): Selection[] | null {
		return this.currentModel ? this.viewModel.getSelections() : null;
	}

	setSelection(selection: IRange, source?: string): void;
	setSelection(selection: ISelection, source?: string): void;
	setSelection(selection: IRange | ISelection, source = 'api'): void {
		let cursorSelection: ISelection;
		if (Selection.isISelection(selection)) {
			cursorSelection = selection;
		} else if (Range.isIRange(selection)) {
			cursorSelection = new Selection(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn);
		} else {
			throw new TypeError('Editor selection must be a range or a selection');
		}
		if (!this.currentModel) return;
		this.viewModel.setSelections(source, [cursorSelection]);
	}

	setPosition(position: import('../../../common/core/position.js').IPosition, source?: string): void {
		this.setSelection(Selection.fromPositions(Position.lift(position)), source);
	}

	setSelections(selections: readonly ISelection[], source?: string): void {
		if (!this.currentModel) return;
		this.viewModel.setSelections(source, selections);
	}

	executeCommand(source: string | null | undefined, command: ICommand): void {
		if (!this.currentModel) return;
		this.viewModel.executeCommand(command, source);
	}

	executeEdits(source: string | null | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeEdits(source: TextModelEditSource | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeEdits(source: string | null | undefined | TextModelEditSource, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean {
		if (!this.currentModel) return false;
		if (this.configuration.options.get(EditorOption.readOnly)) return false;
		const reason = source instanceof TextModelEditSource ? source : EditSources.unknown({ name: source });
		const sourceName = source instanceof TextModelEditSource ? source.metadata.source : source;
		const cursorStateComputer: ICursorStateComputer = endCursorState === undefined
			? () => null
			: Array.isArray(endCursorState)
				? () => endCursorState
				: endCursorState;
		this.viewModel.executeEdits(sourceName, edits, cursorStateComputer, reason);
		return true;
	}

	executeCommands(source: string | null | undefined, commands: (ICommand | null)[]): void {
		if (!this.currentModel) return;
		this.viewModel.executeCommands(commands, source);
	}

	pushUndoStop(): boolean {
		if (!this.currentModel) return false;
		if (this.configuration.options.get(EditorOption.readOnly)) return false;
		this.view.textModel.pushStackElement();
		return true;
	}

	trigger(source: string | null | undefined, handlerId: string, payload: unknown): void {
		if (!this.currentModel) return;
		const args = (payload ?? {}) as Record<string, unknown>;
		switch (handlerId) {
			case Handler.CompositionStart:
				this.controller.compositionStart();
				return;
			case Handler.CompositionEnd:
				this.controller.compositionEnd();
				return;
			case Handler.Type:
				this.controller.type((args as Partial<TypePayload>).text ?? '');
				return;
			case Handler.ReplacePreviousChar: {
				const replacement = args as Partial<ReplacePreviousCharPayload>;
				this.controller.compositionType(replacement.text ?? '', replacement.replaceCharCnt ?? 0, 0, 0);
				return;
			}
			case Handler.CompositionType: {
				const composition = args as Partial<CompositionTypePayload>;
				this.controller.compositionType(composition.text ?? '', composition.replacePrevCharCnt ?? 0, composition.replaceNextCharCnt ?? 0, composition.positionDelta ?? 0);
				return;
			}
			case Handler.Paste: {
				const paste = args as Partial<PastePayload>;
				this.controller.paste(paste.text ?? '', paste.pasteOnNewLine ?? false, paste.multicursorText ?? null, paste.mode ?? null);
				return;
			}
			case Handler.Cut:
				this.controller.cut();
				return;
		}
		try {
			const action = this.getAction(handlerId);
			if (action) {
				void action.run(payload).catch(onUnexpectedError);
				return;
			}
			const command = EditorExtensionsRegistry.getEditorCommand(handlerId);
			if (command && this.contextKeyService.contextMatchesRules(command.precondition)) {
				const commandArgs = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...args, source } : payload ?? { source };
				void Promise.resolve(this.invokeWithinContext(accessor => command.runEditorCommand(accessor, this, commandArgs))).catch(onUnexpectedError);
			}
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	getAction(id: string): IEditorAction | null {
		this.assertNotDisposed();
		for (const action of EditorExtensionsRegistry.getEditorActions()) {
			if (action.id !== id) {
				continue;
			}
			return new InternalEditorAction(
				action.id, action.label, action.alias, action.metadata, action.precondition,
				async args => {
					this.assertNotDisposed();
					if (this.currentModel) {
						await this.invokeWithinContext(accessor => action.runEditorCommand(accessor, this, args));
					}
				},
				this.contextKeyService,
			);
		}
		return null;
	}

	invokeWithinContext<T>(fn: (accessor: import('../../../../platform/instantiation/common/instantiation.js').ServicesAccessor) => T): T {
		return this.instantiationService.invokeFunction(fn);
	}

	getContainerDomNode(): HTMLElement {
		return this.element;
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	protected override disposeCore(): void {
		try {
			this.modelSlot.dispose();
		} finally {
			this.modelState = null;
			this.contentWidgets.clear();
			this.overlayWidgets.clear();
			this.glyphWidgets.clear();
			super.disposeCore();
		}
	}

	override dispose(): void {
		if (this.isDisposed) return;
		this.disposeEmitter.fire();
		super.dispose();
	}

	applyFontInfo(target: HTMLElement): void {
		applyFontInfo(target, this.configuration.options.get(EditorOption.fontInfo));
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null {
		return this.currentModel?.changeDecorations(callback, this.decorationOwnerId) ?? null;
	}

	removeDecorations(decorationIds: string[]): void {
		this.currentModel?.changeDecorations(accessor => {
			for (const id of decorationIds) accessor.removeDecoration(id);
		}, this.decorationOwnerId);
	}

	removeDecorationsByType(_key: string): void {
		// Decoration sources are editor-owned disposables and leave with their contribution.
	}

	public getContribution<T extends import('../../../common/editorCommon.js').IEditorContribution>(id: string): T | null {
		return this.currentModel ? this.contributions.get(id) as T | undefined ?? null : null;
	}
}

class EditorContextKeysManager extends Disposable {
	private readonly editorSimpleInput: IContextKey<boolean>;
	private readonly editorFocus: IContextKey<boolean>;
	private readonly textInputFocus: IContextKey<boolean>;
	private readonly editorTextFocus: IContextKey<boolean>;
	private readonly editorReadonly: IContextKey<boolean>;
	private readonly hasMultipleSelections: IContextKey<boolean>;
	private readonly hasNonEmptySelection: IContextKey<boolean>;
	private readonly isComposing: IContextKey<boolean>;
	private readonly languageId: IContextKey<string>;

	constructor(private readonly editor: CodeEditorWidget, contextKeyService: IContextKeyService, languageFeaturesService: ILanguageFeaturesService) {
		super();
		contextKeyService.createKey('editorId', editor.getId());
		this.editorSimpleInput = EditorContextKeys.editorSimpleInput.bindTo(contextKeyService);
		this.editorFocus = EditorContextKeys.focus.bindTo(contextKeyService);
		this.textInputFocus = EditorContextKeys.textInputFocus.bindTo(contextKeyService);
		this.editorTextFocus = EditorContextKeys.editorTextFocus.bindTo(contextKeyService);
		this.editorReadonly = EditorContextKeys.readOnly.bindTo(contextKeyService);
		this.hasMultipleSelections = EditorContextKeys.hasMultipleSelections.bindTo(contextKeyService);
		this.hasNonEmptySelection = EditorContextKeys.hasNonEmptySelection.bindTo(contextKeyService);
		this.isComposing = EditorContextKeys.isComposing.bindTo(contextKeyService);
		this.languageId = EditorContextKeys.languageId.bindTo(contextKeyService);
		this._register(editor.onDidChangeConfiguration(() => this.updateConfiguration()));
		this._register(editor.onDidChangeCursorSelection(() => this.updateSelection()));
		this._register(editor.onDidFocusEditorText(() => this.updateFocus()));
		this._register(editor.onDidBlurEditorText(() => this.updateFocus()));
		this._register(editor.onDidFocusEditorWidget(() => this.updateFocus()));
		this._register(editor.onDidBlurEditorWidget(() => this.updateFocus()));
		this._register(editor.onDidCompositionStart(() => this.isComposing.set(true)));
		this._register(editor.onDidCompositionEnd(() => this.isComposing.set(false)));
		this.editorSimpleInput.set(editor.isSimpleWidget);
		const model = editor.getModel();
		if (!model) throw new ReferenceError('Editor context keys require a text model');
		const documentFormatting = EditorContextKeys.hasDocumentFormattingProvider.bindTo(contextKeyService);
		const selectionFormatting = EditorContextKeys.hasDocumentSelectionFormattingProvider.bindTo(contextKeyService);
		const signatureHelp = EditorContextKeys.hasSignatureHelpProvider.bindTo(contextKeyService);
		const rename = EditorContextKeys.hasRenameProvider.bindTo(contextKeyService);
		const codeActions = EditorContextKeys.hasCodeActionsProvider.bindTo(contextKeyService);
		this._register(toDisposable(() => {
			for (const key of [
				this.editorSimpleInput, this.editorFocus, this.textInputFocus, this.editorTextFocus,
				this.editorReadonly, this.hasMultipleSelections, this.hasNonEmptySelection,
				this.isComposing, this.languageId, documentFormatting, selectionFormatting, signatureHelp, rename, codeActions,
			]) {
				key.reset();
			}
		}));
		const updateLanguageFeatures = () => {
			const hasRangeProvider = languageFeaturesService.documentRangeFormattingEditProvider.has(model);
			selectionFormatting.set(hasRangeProvider);
			documentFormatting.set(hasRangeProvider || languageFeaturesService.documentFormattingEditProvider.has(model));
			signatureHelp.set(languageFeaturesService.signatureHelpProvider.has(model));
			rename.set(languageFeaturesService.renameProvider.has(model));
			codeActions.set(languageFeaturesService.codeActionProvider.has(model));
			this.languageId.set(model.getLanguageId());
		};
		this._register(languageFeaturesService.documentFormattingEditProvider.onDidChange(updateLanguageFeatures));
		this._register(languageFeaturesService.documentRangeFormattingEditProvider.onDidChange(updateLanguageFeatures));
		this._register(languageFeaturesService.signatureHelpProvider.onDidChange(updateLanguageFeatures));
		this._register(languageFeaturesService.renameProvider.onDidChange(updateLanguageFeatures));
		this._register(languageFeaturesService.codeActionProvider.onDidChange(updateLanguageFeatures));
		this._register(model.onDidChangeLanguage(updateLanguageFeatures));
		updateLanguageFeatures();
		this.updateConfiguration();
		this.updateSelection();
		this.updateFocus();
	}

	private updateConfiguration(): void {
		this.editorReadonly.set(this.editor.getOption(EditorOption.readOnly));
	}

	private updateSelection(): void {
		const selections = this.editor.getSelections() ?? [];
		this.hasMultipleSelections.set(selections.length > 1);
		this.hasNonEmptySelection.set(selections.some(selection => !selection.isEmpty()));
	}

	private updateFocus(): void {
		const hasTextFocus = this.editor.hasTextFocus();
		this.editorFocus.set(this.editor.hasWidgetFocus() && !this.editor.isSimpleWidget);
		this.editorTextFocus.set(hasTextFocus && !this.editor.isSimpleWidget);
		this.textInputFocus.set(hasTextFocus);
	}
}

class EditorDecorationsCollection implements IEditorDecorationsCollection {
	private ids: string[] = [];
	private generation: number;
	readonly onDidChange: Event<IModelDecorationsChangedEvent>;

	constructor(private readonly editor: CodeEditorWidget, private readonly readGeneration: () => number, private readonly ownerId: number, decorations: IModelDeltaDecoration[]) {
		this.generation = readGeneration();
		this.onDidChange = editor.onDidChangeModelDecorations;
		this.set(decorations);
	}

	private synchronizeModel(): void {
		const currentGeneration = this.readGeneration();
		if (this.generation === currentGeneration) return;
		this.generation = currentGeneration;
		this.ids = [];
	}

	get length(): number {
		this.synchronizeModel();
		return this.ids.length;
	}

	getRange(index: number): Range | null {
		this.synchronizeModel();
		const id = this.ids[index];
		const model = this.editor.getModel();
		return id === undefined || !model ? null : model.getDecorationRange(id);
	}

	getRanges(): Range[] {
		this.synchronizeModel();
		const model = this.editor.getModel();
		return model ? this.ids.map(id => model.getDecorationRange(id)).filter((range): range is Range => range !== null) : [];
	}

	has(decoration: IModelDecoration): boolean {
		this.synchronizeModel();
		return this.ids.includes(decoration.id);
	}

	set(decorations: readonly IModelDeltaDecoration[]): string[] {
		this.synchronizeModel();
		const model = this.editor.getModel();
		this.ids = model ? model.deltaDecorations(this.ids, [...decorations], this.ownerId) : [];
		return [...this.ids];
	}

	append(decorations: readonly IModelDeltaDecoration[]): string[] {
		this.synchronizeModel();
		const model = this.editor.getModel();
		if (!model) return [];
		const added = model.deltaDecorations([], [...decorations], this.ownerId);
		this.ids.push(...added);
		return added;
	}

	clear(): void {
		this.synchronizeModel();
		if (this.ids.length === 0) return;
		this.editor.getModel()?.deltaDecorations(this.ids, [], this.ownerId);
		this.ids = [];
	}
}

function validateOptions(options: CodeEditorWidgetOptions): void {
	if (!options || typeof options !== "object" || !isHTMLElement(options.container) || (options.model !== null && !(options.model instanceof TextModel))) {
		throw new TypeError("Code editor widget requires a container and a text model or null");
	}
	if (options.onContributionError !== undefined && typeof options.onContributionError !== "function") {
		throw new TypeError("Code editor contribution error handler must be a function");
	}
}

export function isCodeEditorViewState(value: unknown): value is CodeEditorViewState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<CodeEditorViewState>;
	return Array.isArray(state.cursorState)
		&& state.cursorState.length > 0
		&& state.cursorState.every(cursor => Boolean(cursor?.selectionStart && cursor?.position))
		&& Boolean(state.viewState)
		&& typeof state.viewState?.scrollLeft === 'number'
		&& Boolean(state.viewState?.firstPosition)
		&& Boolean(state.contributionsState && typeof state.contributionsState === 'object');
}

function executeEditorCommand<T>(emitter: Emitter<EditorCommandEvent>, commandId: string, operation: () => T): T {
	const result = operation();
	if (result && typeof (result as { readonly then?: unknown }).then === 'function') {
		return Promise.resolve(result).then(value => {
			emitter.fire(Object.freeze({ commandId }));
			return value;
		}) as T;
	}
	emitter.fire(Object.freeze({ commandId }));
	return result;
}

function editorLabel(resource: URI): string {
	const path = decodeURIComponent(resource.path);
	return path.slice(path.lastIndexOf('/') + 1) || 'Text editor';
}

function reportLanguageError(error: unknown): void {
	console.error('Editor language request failed', error);
}
