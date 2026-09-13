import { getClientArea, isHTMLElement, scheduleAtNextAnimationFrame } from "../../../../base/browser/dom.js";
import { type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { type IMouseWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { CursorsController } from "../../../common/cursor/cursor.js";
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { Selection, type ISelection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type ICursorStateComputer, type IIdentifiedSingleEditOperation, type IModelDecoration, type IModelDecorationsChangeAccessor, type IModelDeltaDecoration } from '../../../common/model.js';
import { type IModelDecorationsChangedEvent } from '../../../common/textModelEvents.js';
import { Handler, ScrollType, type CompositionTypePayload, type ICommand, type ICodeEditorViewState, type IEditorDecorationsCollection, type INewScrollPosition, type ReplacePreviousCharPayload, type TypePayload } from '../../../common/editorCommon.js';
import { VerticalRevealType } from '../../../common/viewEvents.js';
import type { ICodeEditor, IContentWidget, IEditorMouseEvent, IGlyphMarginWidget, IOverlayWidget, IOverviewRuler, IPartialEditorMouseEvent, PastePayload, IViewZoneChangeAccessor } from '../../editorBrowser.js';
import { View, type EditorViewportOptions } from "../../view.js";
import { KeyboardNavigationController, ViewController } from "../../view/viewController.js";
import { ServiceContainer, type IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { CodeEditorContributions } from "./codeEditorContributions.js";
import { observableCodeEditor } from '../../observableCodeEditor.js';
import { EditorConfiguration, type IEditorConstructionOptions } from '../../config/editorConfiguration.js';
import { migrateOptions } from '../../config/migrateOptions.js';
import { EditorExtensionsRegistry, getTextEditorCapabilityContributions, type EditorCapability, type EditorCommandEvent, type IEditorContributionDescription, type TextEditorContributionContext } from '../../editorExtensions.js';
import { VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from '../../services/editorWorkerService.js';
import { EditorWorkerRequestExecutor } from '../../../common/services/editorWorkerRequestExecutor.js';
import { createBuiltinLanguageConfigurationService } from '../../../common/languages/languageBuiltinConfigurations.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import type { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../common/services/languageFeaturesService.js';
import { ResolvedSemanticTokensService } from '../../../common/services/resolvedSemanticTokensService.js';
import { LanguageEditingAdapter } from '../../view/viewController.js';
import { type EditorIndentationOptions } from '../../../common/core/misc/indentation.js';
import { type ConfigurationChangedEvent, EditorLineWrapping, EditorOption, type EditorLayoutInfo, type FindComputedEditorOptionValueById, type IComputedEditorOptions, type IEditorOptions, WrappingIndent } from '../../../common/config/editorOptions.js';
import { type LanguageCompletionWorkerFactory } from '../../../common/languages/completion/languageCompletionService.js';
import { type ILanguageDiagnosticsService } from '../../../common/services/languageDiagnosticsService.js';
import { isCompletionsEnablement, type CompletionsEnablement } from '../../../common/services/completionsEnablement.js';
import { type LanguageLocation } from '../../../common/languages.js';
import { type LanguageWorkspaceEdit } from '../../../common/languages/languageWorkspaceEdit.js';
import { type EditorLineVisibilitySource } from '../../../common/viewModel/viewModelLines.js';
import { type LanguageLexicalContextSource } from '../../../common/languages/languageLexicalContext.js';
import { type BracketColorizationSource, type SemanticTokenSource } from '../../viewParts/viewLines/viewLine.js';
import { type EditorTextDirection, type EditorViewportPresentation } from '../../view.js';
import { type IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { type ICodeEditorService } from '../../services/codeEditorService.js';
import { applyFontInfo } from '../../config/domFontInfo.js';
import { type URI } from '../../../../base/common/uri.js';
import { type IClipboardCopyEvent, type IClipboardPasteEvent } from '../../controller/editContext/clipboardUtils.js';
import { DOMLineBreaksComputerFactory } from '../../view/domLineBreaksComputer.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';
import { getViewModelCursorController, ViewModel } from '../../../common/viewModel/viewModelImpl.js';
import { OutgoingViewModelEventKind } from '../../../common/viewModelEventDispatcher.js';
import { IThemeService, ThemeService } from '../../../../platform/theme/common/themeService.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EditSources, TextModelEditSource } from '../../../common/textModelEditSource.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { type ICursorPositionChangedEvent, type ICursorSelectionChangedEvent } from '../../../common/cursorEvents.js';

export type CodeEditorWidgetViewportOptions = Omit<EditorViewportOptions, 'container' | 'viewModel' | 'configuration' | 'lineHeight' | 'ariaLabel'>;

export interface EditorSectionHeaderOptions {
	readonly showRegionSectionHeaders?: boolean;
	readonly showMarkSectionHeaders?: boolean;
	readonly markSectionHeaderRegex?: string;
}

/** Internal services and host callbacks used while constructing one code editor widget. */
export interface ICodeEditorWidgetOptions extends IEditorConstructionOptions {
	readonly container: HTMLElement;
	readonly input: {
		readonly resource: URI;
		readonly label?: string;
		readonly languageId?: string;
		readonly readOnly?: boolean;
		readonly initialText?: string;
	};
	readonly languageId: string;
	readonly model: TextModel;
	readonly ownerId?: string;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly instantiationService?: IInstantiationService;
	readonly codeEditorService?: ICodeEditorService;
	readonly accessibilityService?: IAccessibilityService;
	readonly editorWorkerFactory?: VersionedEditorWorkerFactory;
	readonly completionWorkerFactory?: LanguageCompletionWorkerFactory;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly onLanguageError?: (error: unknown) => void;
	readonly onOpenLink?: (target: string) => void | Promise<void>;
	readonly onExecuteEditorCommand?: (id: string, args: readonly unknown[] | undefined) => void | Promise<void>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
	readonly registerBeforeSave?: (hook: () => void | Promise<void>) => IDisposable;
	readonly onContributionError?: (error: unknown) => void;
	readonly contributions?: readonly IEditorContributionDescription[];
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

export type CodeEditorWidgetOptions = ICodeEditorWidgetOptions;

export type CodeEditorViewState = ICodeEditorViewState;

let decorationOwnerPool = 0;

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
	readonly onDidDispose = this.disposeEmitter.event;
	readonly onDidChangeConfiguration: Event<ConfigurationChangedEvent>;
	readonly onDidChange: Event<void>;
	readonly onDidAttemptReadOnlyEdit: Event<void>;
	readonly onDidLayoutChange: Event<EditorLayoutInfo>;
	readonly onDidChangeCursorPosition: Event<ICursorPositionChangedEvent>;
	readonly onDidChangeCursorSelection: Event<ICursorSelectionChangedEvent>;
	readonly onDidFocusEditorText = this.focusEditorTextEmitter.event;
	readonly onDidBlurEditorText = this.blurEditorTextEmitter.event;
	readonly onDidFocusEditorWidget = this.focusEditorWidgetEmitter.event;
	readonly onDidBlurEditorWidget = this.blurEditorWidgetEmitter.event;
	readonly onDidCompositionStart: Event<void>;
	readonly onDidCompositionEnd: Event<void>;
	readonly onDidType: Event<string>;
	readonly onDidPaste: Event<IClipboardPasteEvent>;
	readonly onWillCopy: Event<IClipboardCopyEvent>;
	readonly onWillCut: Event<IClipboardCopyEvent>;
	readonly onWillPaste: Event<IClipboardPasteEvent>;
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
	readonly selections: CursorsController;
	private readonly ownerId: string;
	readonly view: ViewController;
	readonly viewport: View;
	private readonly userInputEvents: ViewController['userInputEvents'];
	private readonly contributions: CodeEditorContributions;
	private readonly instantiationService: IInstantiationService;
	private readonly viewModel: ViewModel;
	private readonly configuration: EditorConfiguration;
	private readonly decorationOwnerId = ++decorationOwnerPool;

	constructor(options: CodeEditorWidgetOptions) {
		super();
		options.codeEditorService?.willCreateCodeEditor();
		try {
			validateOptions(options);
			migrateOptions(options);
			const services = this._register(options.instantiationService?.createChild() ?? new ServiceContainer());
			this.instantiationService = services;
			const logService = services.getOptional(ILogService);
			const inheritedThemeService = services.getOptional(IThemeService);
			const themeService = inheritedThemeService ?? this._register(new ThemeService(darkColorTheme));
			if (!inheritedThemeService) services.registerInstance(IThemeService, themeService);
			const onLanguageError = options.onLanguageError ?? options.onContributionError ?? reportLanguageError;
			const editorWorker = this._register(options.editorWorkerFactory
				? options.editorWorkerFactory(options.model)
				: new VersionedEditorWorkerClient(options.model, () => new EditorWorkerRequestExecutor()));
			this.onDidChange = listener => options.model.onDidChangeContent(() => listener());
			if (options.languageFeaturesService && !options.languageConfigurationService) {
				throw new TypeError('Editor language features require their language configuration service');
			}
			const inheritedLanguageConfigurationService = services.getOptional(ILanguageConfigurationService);
			const languageConfigurationService = options.languageConfigurationService
				?? inheritedLanguageConfigurationService
				?? this._register(createBuiltinLanguageConfigurationService());
			if (languageConfigurationService !== inheritedLanguageConfigurationService) {
				services.registerInstance(ILanguageConfigurationService, languageConfigurationService);
			}
			const languageFeaturesService = options.languageFeaturesService ?? this._register(new LanguageFeaturesService(languageConfigurationService));
			const resolvedSemanticTokensService = this._register(new ResolvedSemanticTokensService());
			this.configuration = this._register(new EditorConfiguration(
				options.isSimpleWidget ?? false,
				options.contextMenuId ?? (options.isSimpleWidget ? MenuId.SimpleEditorContext : MenuId.EditorContext),
				{
				...options,
				readOnly: options.input.readOnly,
				lineNumbers: options.lineNumbers ?? (options.presentation === 'embedded' ? 'off' : undefined),
				guides: {
					...options.guides,
					indentation: options.guides?.indentation ?? options.presentation !== 'embedded',
				},
				renderLineHighlight: options.renderLineHighlight ?? (options.presentation === 'embedded' ? 'none' : undefined),
				wordWrap: options.lineWrapping === EditorLineWrapping.On ? 'on' : 'off',
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
			this.configuration.setModelLineCount(options.model.lineCount);
			const attachedView = options.model.onBeforeAttached();
			this._register(toDisposable(() => options.model.onBeforeDetached(attachedView)));
			const ownerWindow = options.container.ownerDocument.defaultView;
			if (!ownerWindow) throw new ReferenceError('Code editor requires a browser window');
			this.viewModel = this._register(new ViewModel(
				this.decorationOwnerId,
				this.configuration,
				options.model,
				DOMLineBreaksComputerFactory.create(ownerWindow),
				MonospaceLineBreaksComputerFactory.create(this.configuration.options),
				callback => scheduleAtNextAnimationFrame(ownerWindow, callback),
				languageConfigurationService,
				themeService,
				attachedView,
				{ batchChanges: callback => callback() },
			));
			this.selections = getViewModelCursorController(this.viewModel);
			this.onDidAttemptReadOnlyEdit = listener => this.viewModel.onEvent(event => {
				if (event.kind === OutgoingViewModelEventKind.ReadOnlyEditAttempt) listener();
			});
			this.onDidChangeCursorPosition = listener => this.viewModel.onEvent(event => {
				if (event.kind !== OutgoingViewModelEventKind.CursorStateChanged) return;
				const primary = event.selections[0];
				if (!primary) return;
				listener({
					position: primary.getPosition(),
					secondaryPositions: event.selections.slice(1).map(selection => selection.getPosition()),
					reason: event.reason,
					source: event.source,
				});
			});
			this.onDidChangeCursorSelection = listener => this.viewModel.onEvent(event => {
				if (event.kind !== OutgoingViewModelEventKind.CursorStateChanged) return;
				const primary = event.selections[0];
				if (!primary) return;
				listener({
					selection: primary,
					secondarySelections: event.selections.slice(1),
					modelVersionId: event.modelVersionId,
					oldSelections: event.oldSelections,
					oldModelVersionId: event.oldModelVersionId,
					source: event.source,
					reason: event.reason,
				});
			});
			const capabilities = new Map<string, unknown>();
			const commandEmitter = this._register(new Emitter<EditorCommandEvent>());
			const executeCommand = <T>(commandId: string, operation: () => T): T => executeEditorCommand(commandEmitter, commandId, operation);
			const getCapability = <T>(capability: EditorCapability<T>): T => {
				if (!capabilities.has(capability.id)) throw new ReferenceError(`Text editor capability '${capability.id}' is unavailable`);
				return capabilities.get(capability.id) as T;
			};
			const getOptionalCapability = <T>(capability: EditorCapability<T>): T | undefined => capabilities.get(capability.id) as T | undefined;
			const provideCapability = <T>(capability: EditorCapability<T>, value: T): void => {
				if (capabilities.has(capability.id)) throw new RangeError(`Text editor capability '${capability.id}' is already provided`);
				capabilities.set(capability.id, value);
			};
			let lineProjection: { readonly visibilitySource: EditorLineVisibilitySource } | undefined;
			let semanticTokenSource: SemanticTokenSource | undefined;
			let bracketColorizationSource: BracketColorizationSource | undefined;
			let languageLexicalContext: LanguageLexicalContextSource | undefined;
			const selectedContributions = getTextEditorCapabilityContributions();
			for (const contribution of selectedContributions) {
				contribution.configure?.({
					kind: 'text',
					options,
					model: options.model,
					viewModel: this.viewModel,
					selectionController: this.selections,
					editorWorker,
					languageId: options.languageId,
					languageFeaturesService,
					resolvedSemanticTokensService,
					configurations: languageConfigurationService,
					onLanguageError,
					getCapability,
					getOptionalCapability,
					provideCapability,
					setLineProjection: projection => {
						if (lineProjection) throw new Error('Text editor line projection is already configured');
						lineProjection = projection;
					},
					setSemanticTokenSource: source => {
						if (semanticTokenSource) throw new Error('Text editor semantic-token source is already configured');
						semanticTokenSource = source;
					},
					setBracketColorizationSource: source => {
						if (bracketColorizationSource) throw new Error('Text editor bracket-colorization source is already configured');
						bracketColorizationSource = source;
					},
					setLanguageLexicalContext: source => {
						if (languageLexicalContext) throw new Error('Text editor lexical context is already configured');
						languageLexicalContext = source;
					},
					register: value => this._register(value),
				});
			}
			if (lineProjection) {
				const syncHiddenAreas = (): void => this.viewModel.setHiddenAreas(readHiddenAreas(options.model, lineProjection!.visibilitySource));
				syncHiddenAreas();
				this._register(lineProjection.visibilitySource.onDidChange(syncHiddenAreas));
			}
			const languageEditing = this._register(new LanguageEditingAdapter(
				options.model,
				this.selections,
				options.languageId,
				languageConfigurationService,
				languageLexicalContext,
				options.indentation,
			));
			this.viewport = this._register(new View({
				container: options.container,
				viewModel: this.viewModel,
				configuration: this.configuration,
				theme: themeService.getColorTheme(),
				lineHeight: options.lineHeight,
				ariaLabel: options.ariaLabel ?? editorLabel(options.input),
				dimension: options.dimension,
					automaticLayout: options.automaticLayout,
					cursorOptions: { readOnly: options.input.readOnly, stickyTabStops: options.stickyTabStops },
					languageId: options.languageId,
					semanticTokenSource,
					bracketColorizationSource,
					lineWrapping: options.lineWrapping,
					wrappingIndent: resolveWrappingIndent(options.wrappingIndent),
					fontFamily: options.fontFamily,
					fontSize: options.fontSize,
					fontLigatures: options.fontLigatures === true,
					lineNumbers: options.lineNumbers,
					glyphMargin: options.glyphMargin,
					guides: options.guides,
					minimap: options.minimap,
					renderLineHighlight: options.renderLineHighlight,
					renderLineHighlightOnlyWhenFocus: options.renderLineHighlightOnlyWhenFocus,
					textDirection: options.textDirection,
					experimentalGpuAcceleration: options.experimentalGpuAcceleration,
					renderWhitespace: options.renderWhitespace,
					mouseStyle: options.mouseStyle,
					cursorStyle: options.cursorStyle,
					overtypeCursorStyle: options.overtypeCursorStyle,
					cursorBlinking: options.cursorBlinking,
					cursorSmoothCaretAnimation: options.cursorSmoothCaretAnimation,
					cursorWidth: options.cursorWidth,
					cursorHeight: options.cursorHeight,
					allowOverflow: options.allowOverflow,
					fixedOverflowWidgets: options.fixedOverflowWidgets,
					presentation: options.presentation,
					padding: options.padding === undefined ? undefined : {
						top: options.padding.top ?? 0,
						right: 12,
						bottom: options.padding.bottom ?? 0,
						left: 12,
					},
					indentation: options.indentation,
					controller: {
						ownerId: options.ownerId,
						...(logService ? { logService } : {}),
						ariaLabel: options.ariaLabel ?? editorLabel(options.input),
						accessibilityService: options.accessibilityService,
						semanticTokenSource,
						bracketColorizationSource,
						languageEditing,
					},
			}));
			this.onDidLayoutChange = listener => this.viewport.onDidChangeLayout(() => listener(this.getLayoutInfo()));
			this.view = this.viewport.controller;
			this.ownerId = this.view.ownerId;
			this.onDidCompositionStart = listener => this.view.editContext.onDidCompositionStart(() => listener());
			this.onDidCompositionEnd = listener => this.view.editContext.onDidCompositionEnd(() => listener());
			this.onDidType = listener => this.view.onDidEdit(event => {
				if (event.insertedText !== undefined) listener(event.insertedText);
			});
			this.onDidPaste = listener => this.view.editContext.onWillPaste(listener);
			this.onWillCopy = this.viewport.onWillCopy;
			this.onWillCut = this.viewport.onWillCut;
			this.onWillPaste = this.viewport.onWillPaste;
			this._register(this.view.editContext.onDidFocus(() => {
				this.focusEditorTextEmitter.fire();
				this.focusEditorWidgetEmitter.fire();
			}));
			this._register(this.view.editContext.onDidBlur(() => {
				this.blurEditorTextEmitter.fire();
				this.blurEditorWidgetEmitter.fire();
			}));
			this.userInputEvents = this.view.userInputEvents;
			const parentContextKeyService = services.getOptional(IContextKeyService);
			if (parentContextKeyService) {
				const scopedContextKeyService = this._register(parentContextKeyService.createScoped(this.viewport.domNode.domNode));
				services.registerInstance(IContextKeyService, scopedContextKeyService);
				this._register(new EditorContextKeysManager(this, scopedContextKeyService));
			}
			const handleKeyDown = (event: IKeyboardEvent): void => this.keyDownEmitter.fire(event);
			const handleKeyUp = (event: IKeyboardEvent): void => this.keyUpEmitter.fire(event);
			const handleContextMenu = (event: IEditorMouseEvent): void => this.contextMenuEmitter.fire(event);
			const handleMouseMove = (event: IEditorMouseEvent): void => this.mouseMoveEmitter.fire(event);
			const handleMouseLeave = (event: IPartialEditorMouseEvent): void => this.mouseLeaveEmitter.fire(event);
			const handleMouseDown = (event: IEditorMouseEvent): void => this.mouseDownEmitter.fire(event);
			const handleMouseUp = (event: IEditorMouseEvent): void => this.mouseUpEmitter.fire(event);
			const handleMouseDrag = (event: IEditorMouseEvent): void => this.mouseDragEmitter.fire(event);
			const handleMouseDrop = (event: IPartialEditorMouseEvent): void => {
				this.mouseDropEmitter.fire(event);
				const position = event.target?.position;
				if (position) this.dropIntoEditorEmitter.fire({ position, event: event.event.browserEvent as DragEvent });
			};
			const handleMouseDropCanceled = (): void => this.mouseDropCanceledEmitter.fire();
			const handleMouseWheel = (event: IMouseWheelEvent): void => this.mouseWheelEmitter.fire(event);
			this.userInputEvents.onKeyDown = handleKeyDown;
			this.userInputEvents.onKeyUp = handleKeyUp;
			this.userInputEvents.onContextMenu = handleContextMenu;
			this.userInputEvents.onMouseMove = handleMouseMove;
			this.userInputEvents.onMouseLeave = handleMouseLeave;
			this.userInputEvents.onMouseDown = handleMouseDown;
			this.userInputEvents.onMouseUp = handleMouseUp;
			this.userInputEvents.onMouseDrag = handleMouseDrag;
			this.userInputEvents.onMouseDrop = handleMouseDrop;
			this.userInputEvents.onMouseDropCanceled = handleMouseDropCanceled;
			this.userInputEvents.onMouseWheel = handleMouseWheel;
			this._register(toDisposable(() => {
				if (this.userInputEvents.onKeyDown === handleKeyDown) this.userInputEvents.onKeyDown = null;
				if (this.userInputEvents.onKeyUp === handleKeyUp) this.userInputEvents.onKeyUp = null;
				if (this.userInputEvents.onContextMenu === handleContextMenu) this.userInputEvents.onContextMenu = null;
				if (this.userInputEvents.onMouseMove === handleMouseMove) this.userInputEvents.onMouseMove = null;
				if (this.userInputEvents.onMouseLeave === handleMouseLeave) this.userInputEvents.onMouseLeave = null;
				if (this.userInputEvents.onMouseDown === handleMouseDown) this.userInputEvents.onMouseDown = null;
				if (this.userInputEvents.onMouseUp === handleMouseUp) this.userInputEvents.onMouseUp = null;
				if (this.userInputEvents.onMouseDrag === handleMouseDrag) this.userInputEvents.onMouseDrag = null;
				if (this.userInputEvents.onMouseDrop === handleMouseDrop) this.userInputEvents.onMouseDrop = null;
				if (this.userInputEvents.onMouseDropCanceled === handleMouseDropCanceled) this.userInputEvents.onMouseDropCanceled = null;
				if (this.userInputEvents.onMouseWheel === handleMouseWheel) this.userInputEvents.onMouseWheel = null;
			}));
			this._register(toDisposable(() => {
				if (!options.model.isDisposed()) options.model.removeAllDecorationsWithOwnerId(this.decorationOwnerId);
			}));
			this._register(observableCodeEditor(this));
			this.contributions = this._register(new CodeEditorContributions());
			this._register(new KeyboardNavigationController(this.viewport, this.viewModel, this.userInputEvents));
			if (options.codeEditorService) {
				options.codeEditorService.addCodeEditor(this);
				this._register(toDisposable(() => options.codeEditorService?.removeCodeEditor(this)));
			}
			const installContext: TextEditorContributionContext = {
				kind: 'text',
				editor: this,
				instantiationService: this.instantiationService,
				options,
				model: options.model,
				editorWorker,
				languageId: options.languageId,
				languageFeaturesService,
				configurations: languageConfigurationService,
				view: this.view,
				viewport: this.viewport,
				viewModel: this.viewModel,
				selectionController: this.selections,
				onLanguageError,
				onDidExecuteCommand: commandEmitter.event,
				executeCommand,
				getCapability,
				getOptionalCapability,
				registerBeforeSave: options.registerBeforeSave,
				register: value => this._register(value),
			};
			for (const contribution of selectedContributions) contribution.install?.(installContext);
			this.contributions.initialize(
				this,
				options.contributions ?? EditorExtensionsRegistry.getEditorContributions(),
				this.instantiationService,
				options.onContributionError,
			);
			this._register(this.contributions.onAfterModelAttached());
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private get element(): HTMLDivElement {
		return this.viewport.domNode.domNode;
	}

	get inComposition(): boolean {
		return this.view.compositionController.composing;
	}

	layout(dimension: IDimension = getClientArea(this.element)): void {
		this.viewport.layout({ width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) });
	}

	focus(): void {
		this.viewport.focus();
	}

	addContentWidget(widget: IContentWidget): void {
		this.viewport.addContentWidget(widget);
	}

	getLayoutInfo(): EditorLayoutInfo {
		return this.viewport.getLayoutInfo();
	}

	createOverviewRuler(cssClassName: string): IOverviewRuler {
		return this.viewport.createOverviewRuler(cssClassName);
	}

	updateOptions(newOptions: Readonly<IEditorOptions> | undefined): void {
		this.configuration.updateOptions(newOptions ?? {});
	}

	getOptions(): IComputedEditorOptions {
		return this.configuration.options;
	}

	getOption<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this.viewport.getOption(id);
	}

	getRawOptions(): IEditorOptions {
		return this.configuration.getRawOptions();
	}

	getScrolledVisiblePosition(position: Position): { top: number; left: number; height: number } | null {
		this.viewport.textModel.offsetAt(position);
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		const scroll = this.viewport.currentLayout.scrollPosition;
		return { top: coordinates.top - scroll.top, left: coordinates.left - scroll.left, height: coordinates.height };
	}

	getWidthOfLine(lineNumber: number): number {
		return this.viewport.measureTextWidth(this.viewport.textModel.getLineContent(lineNumber));
	}

	createDecorationsCollection(decorations: IModelDeltaDecoration[] = []): IEditorDecorationsCollection {
		return this._register(new EditorDecorationsCollection(this.viewport.textModel, this.decorationOwnerId, decorations));
	}

	layoutContentWidget(widget: IContentWidget): void {
		this.viewport.layoutContentWidget(widget);
	}

	removeContentWidget(widget: IContentWidget): void {
		this.viewport.removeContentWidget(widget);
	}

	addOverlayWidget(widget: IOverlayWidget): void {
		this.viewport.addOverlayWidget(widget);
	}

	layoutOverlayWidget(widget: IOverlayWidget): void {
		this.viewport.layoutOverlayWidget(widget);
	}

	removeOverlayWidget(widget: IOverlayWidget): void {
		this.viewport.removeOverlayWidget(widget);
	}

	addGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.viewport.addGlyphMarginWidget(widget);
	}

	layoutGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.viewport.layoutGlyphMarginWidget(widget);
	}

	removeGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.viewport.removeGlyphMarginWidget(widget);
	}

	changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): void {
		this.viewport.changeViewZones(callback);
	}

	announceAccessibilityStatus(message: string): void {
		this.viewport.announceAccessibilityStatus(message);
	}

	getValue(): string {
		return this.viewport.textModel.getText();
	}

	setValue(value: string): void {
		if (this.getValue() === value) return;
		this.viewport.textModel.reset(value);
	}

	revealRange(range: Range, scrollType: ScrollType = ScrollType.Smooth): void {
		this.viewport.textModel.offsetAt(range.getStartPosition());
		this.viewport.textModel.offsetAt(range.getEndPosition());
		this.viewModel.revealRange('api', true, range, VerticalRevealType.Simple, scrollType);
	}

	saveViewState(): CodeEditorViewState {
		return Object.freeze({
			cursorState: this.viewModel.saveCursorState(),
			viewState: this.viewModel.saveState(),
			contributionsState: this.contributions.saveViewState(),
		});
	}

	restoreViewState(state: CodeEditorViewState): void {
		this.viewModel.restoreCursorState(state.cursorState);
		const scroll = this.viewModel.reduceRestoreState(state.viewState);
		this.viewport.scrollTo({ left: scroll.scrollLeft, top: scroll.scrollTop });
		this.contributions.restoreViewState(state.contributionsState ?? {});
	}

	getId(): string {
		return this.ownerId;
	}

	hasTextFocus(): boolean {
		return this.viewport.isFocused();
	}

	hasWidgetFocus(): boolean {
		return this.viewport.isWidgetFocused();
	}

	getModel(): TextModel {
		return this.viewport.textModel;
	}

	hasModel(): boolean {
		return true;
	}

	_getViewModel(): ViewModel {
		return this.viewModel;
	}

	getPosition(): Position | null {
		return this.viewModel.getPosition();
	}

	getScrollTop(): number {
		return this.viewport.currentLayout.scrollPosition.top;
	}

	getScrollLeft(): number {
		return this.viewport.currentLayout.scrollPosition.left;
	}

	getContentHeight(): number {
		return this.viewport.currentLayout.contentSize.height;
	}

	getContentWidth(): number {
		return this.viewport.currentLayout.contentSize.width;
	}

	hasPendingScrollAnimation(): boolean {
		return false;
	}

	getVisibleRanges(): Range[] {
		return this.viewModel.getVisibleRanges();
	}

	getTopForPosition(lineNumber: number, column: number): number {
		const position = this.viewport.textModel.validatePosition(new Position(lineNumber, column));
		return this.viewport.getPositionContentCoordinates(position).top;
	}

	getTopForLineNumber(lineNumber: number): number {
		return this.getTopForPosition(lineNumber, 1);
	}

	getBottomForLineNumber(lineNumber: number): number {
		const model = this.viewport.textModel;
		const position = model.validatePosition(new Position(lineNumber, model.getLineMaxColumn(lineNumber)));
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		return coordinates.top + coordinates.height;
	}

	setScrollTop(newScrollTop: number, _scrollType?: ScrollType): void {
		const layout = this.viewport.currentLayout;
		this.viewport.scrollTo({ left: layout.scrollPosition.left, top: newScrollTop });
	}

	setScrollLeft(newScrollLeft: number, _scrollType?: ScrollType): void {
		const layout = this.viewport.currentLayout;
		this.viewport.scrollTo({ left: newScrollLeft, top: layout.scrollPosition.top });
	}

	setScrollPosition(position: INewScrollPosition, _scrollType?: ScrollType): void {
		const layout = this.viewport.currentLayout;
		this.viewport.scrollTo({
			left: position.scrollLeft ?? layout.scrollPosition.left,
			top: position.scrollTop ?? layout.scrollPosition.top,
		});
	}

	getSelection(): Selection | null {
		return this.viewModel.getSelection();
	}

	getSelections(): Selection[] {
		return this.viewModel.getSelections();
	}

	setSelection(selection: ISelection, source?: string): void {
		this.viewModel.setSelections(source, [selection]);
	}

	setPosition(position: import('../../../common/core/position.js').IPosition, source?: string): void {
		this.setSelection(Selection.fromPositions(Position.lift(position)), source);
	}

	setSelections(selections: readonly ISelection[], source?: string): void {
		this.viewModel.setSelections(source, selections);
	}

	executeCommand(source: string | null | undefined, command: ICommand): void {
		this.viewModel.executeCommand(command, source);
	}

	executeEdits(source: string | null | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeEdits(source: TextModelEditSource | undefined, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean;
	executeEdits(source: string | null | undefined | TextModelEditSource, edits: IIdentifiedSingleEditOperation[], endCursorState?: ICursorStateComputer | Selection[]): boolean {
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
		this.viewModel.executeCommands(commands, source);
	}

	pushUndoStop(): boolean {
		if (this.configuration.options.get(EditorOption.readOnly)) return false;
		this.viewport.textModel.pushStackElement();
		return true;
	}

	trigger(source: string | null | undefined, handlerId: string, payload: unknown): void {
		const args = (payload ?? {}) as Record<string, unknown>;
		switch (handlerId) {
			case Handler.CompositionStart:
				this.view.compositionStart();
				return;
			case Handler.CompositionEnd:
				this.view.compositionEnd();
				return;
			case Handler.Type:
				this.view.type((args as Partial<TypePayload>).text ?? '');
				return;
			case Handler.ReplacePreviousChar: {
				const replacement = args as Partial<ReplacePreviousCharPayload>;
				this.view.compositionType(replacement.text ?? '', replacement.replaceCharCnt ?? 0, 0, 0);
				return;
			}
			case Handler.CompositionType: {
				const composition = args as Partial<CompositionTypePayload>;
				this.view.compositionType(composition.text ?? '', composition.replacePrevCharCnt ?? 0, composition.replaceNextCharCnt ?? 0, composition.positionDelta ?? 0);
				return;
			}
			case Handler.Paste: {
				const paste = args as Partial<PastePayload>;
				this.view.paste(paste.text ?? '', paste.pasteOnNewLine ?? false, paste.multicursorText ?? null, paste.mode ?? null);
				return;
			}
			case Handler.Cut:
				this.view.cut();
				return;
		}
		void source;
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

	override dispose(): void {
		if (this.isDisposed) return;
		this.disposeEmitter.fire();
		super.dispose();
	}

	applyFontInfo(target: HTMLElement): void {
		applyFontInfo(target, this.viewport.fontInfo);
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null {
		return this.viewport.textModel.changeDecorations(callback, this.decorationOwnerId);
	}

	removeDecorations(decorationIds: string[]): void {
		this.viewport.textModel.changeDecorations(accessor => {
			for (const id of decorationIds) accessor.removeDecoration(id);
		}, this.decorationOwnerId);
	}

	removeDecorationsByType(_key: string): void {
		// Decoration sources are editor-owned disposables and leave with their contribution.
	}

	public getContribution<T extends import('../../../common/editorCommon.js').IEditorContribution>(id: string): T | null {
		return this.contributions.get(id) as T | undefined ?? null;
	}
}

function readHiddenAreas(model: TextModel, source: EditorLineVisibilitySource): Range[] {
	const ranges: Range[] = [];
	let startLineNumber: number | undefined;
	for (let lineIndex = 0; lineIndex < model.lineCount; lineIndex += 1) {
		if (!source.isLineVisible(lineIndex)) {
			startLineNumber ??= lineIndex + 1;
			continue;
		}
		if (startLineNumber === undefined) continue;
		const endLineNumber = lineIndex;
		ranges.push(new Range(startLineNumber, 1, endLineNumber, model.getLineMaxColumn(endLineNumber)));
		startLineNumber = undefined;
	}
	if (startLineNumber !== undefined) ranges.push(new Range(startLineNumber, 1, model.lineCount, model.getLineMaxColumn(model.lineCount)));
	return ranges;
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

	constructor(private readonly editor: CodeEditorWidget, contextKeyService: IContextKeyService) {
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
		this._register(editor.onDidCompositionStart(() => this.isComposing.set(true)));
		this._register(editor.onDidCompositionEnd(() => this.isComposing.set(false)));
		this.editorSimpleInput.set(editor.isSimpleWidget);
		this.languageId.set(editor.getModel().getLanguageId());
		this.updateConfiguration();
		this.updateSelection();
		this.updateFocus();
	}

	private updateConfiguration(): void {
		this.editorReadonly.set(this.editor.getOption(EditorOption.readOnly));
	}

	private updateSelection(): void {
		const selections = this.editor.getSelections();
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

class EditorDecorationsCollection extends Disposable implements IEditorDecorationsCollection {
	private ids: string[] = [];
	private readonly changeEmitter = this._register(new Emitter<IModelDecorationsChangedEvent>());
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly model: TextModel, private readonly ownerId: number, decorations: IModelDeltaDecoration[]) {
		super();
		this._register(model.onDidChangeDecorations(event => this.changeEmitter.fire(event)));
		this.ids = model.deltaDecorations([], decorations, ownerId);
	}

	get length(): number {
		return this.ids.length;
	}

	getRange(index: number): Range | null {
		const id = this.ids[index];
		return id === undefined ? null : this.model.getDecorationRange(id);
	}

	getRanges(): Range[] {
		return this.ids.map(id => this.model.getDecorationRange(id)).filter((range): range is Range => range !== null);
	}

	has(decoration: IModelDecoration): boolean {
		return this.ids.includes(decoration.id);
	}

	set(decorations: readonly IModelDeltaDecoration[]): string[] {
		this.ids = this.model.deltaDecorations(this.ids, [...decorations], this.ownerId);
		return [...this.ids];
	}

	append(decorations: readonly IModelDeltaDecoration[]): string[] {
		const added = this.model.deltaDecorations([], [...decorations], this.ownerId);
		this.ids.push(...added);
		return added;
	}

	clear(): void {
		if (this.ids.length === 0) return;
		this.model.deltaDecorations(this.ids, [], this.ownerId);
		this.ids = [];
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}

function validateOptions(options: CodeEditorWidgetOptions): void {
	if (!options || typeof options !== "object" || !isHTMLElement(options.container) || !options.model || !options.input || !options.languageId) {
		throw new TypeError("Code editor widget requires a container, input, language, and text model");
	}
	if (options.instantiationService !== undefined && typeof options.instantiationService.createInstance !== "function") {
		throw new TypeError("Code editor instantiation service must create instances");
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

function editorLabel(input: ICodeEditorWidgetOptions['input']): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path);
	return path.slice(path.lastIndexOf('/') + 1) || 'Text editor';
}

function resolveWrappingIndent(value: IEditorConstructionOptions['wrappingIndent']): WrappingIndent | undefined {
	switch (value) {
		case 'none': return WrappingIndent.None;
		case 'same': return WrappingIndent.Same;
		case 'indent': return WrappingIndent.Indent;
		case 'deepIndent': return WrappingIndent.DeepIndent;
		default: return undefined;
	}
}

function reportLanguageError(error: unknown): void {
	console.error('Editor language request failed', error);
}
