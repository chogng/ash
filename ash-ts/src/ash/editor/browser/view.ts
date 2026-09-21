import type { IMouseWheelEvent } from '../../base/browser/mouseEvent.js';
import { Event } from '../../base/common/event.js';
import { addDisposableListener, getClientArea, h, runWhenWindowIdle } from '../../base/browser/dom.js';
import { FastDomNode } from '../../base/browser/fastDomNode.js';
import { PixelRatio, type IPixelRatioMonitor } from '../../base/browser/pixelRatio.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import { type ISize } from '../../base/common/layout.js';
import { clamp, isFiniteNumber } from '../../base/common/numbers.js';
import { resolveEditorIndentationOptions, type EditorIndentationOptions, type ResolvedEditorIndentationOptions } from '../common/core/misc/indentation.js';
import { Position } from '../common/core/position.js';
import { type IDimension } from '../common/core/2d/dimension.js';
import { ScrollType } from '../common/editorCommon.js';
import { Range } from '../common/core/range.js';
import { TextModel } from '../common/model/textModel.js';
import { type IViewModel, type EditorScrollPosition, type TextMeasurer } from '../common/viewModel.js';
import { ViewEventHandler } from '../common/viewEventHandler.js';
import * as viewEvents from '../common/viewEvents.js';
import { EditorVisualLineProjection } from '../common/viewModel/modelLineProjection.js';
import { ComputeOptionsMemory, EditorLayoutInfoComputer, EditorLineWrapping, EditorOption, type EditorLayoutInfo, type EditorMinimapLayoutInfo, type EditorMinimapOptions, type FindComputedEditorOptionValueById, RenderLineNumbersType, isWrappingIndent, WrappingIndent } from '../common/config/editorOptions.js';
import { type FontInfo } from '../common/config/fontInfo.js';
import { type EditorViewportChange, type EditorViewportLayout, ViewLayout } from '../common/viewLayout/viewLayout.js';
import { type ClientPoint, type EditorHitTarget, EditorHitTargetKind, hitTestStanzaVisualEditorPoint } from '../common/viewModel/pointerHitTest.js';
import { applyFontInfo } from './config/domFontInfo.js';
import { EditorConfiguration } from './config/editorConfiguration.js';
import { DecorationsOverlay } from './viewParts/decorations/decorations.js';
import { type SemanticTokenSource } from './viewParts/viewLines/viewLine.js';
import { getTextGraphemeBoundaries } from '../common/core/textSegmentation.js';
import { Margin } from './viewParts/margin/margin.js';
import { GlyphMarginWidgets } from './viewParts/glyphMargin/glyphMargin.js';
import { GlyphMarginLane } from '../common/model.js';
import { Rulers } from './viewParts/rulers/rulers.js';
import { GpuMarkOverlay } from './viewParts/gpuMark/gpuMark.js';
import { MinimapTokensColorTracker } from '../common/viewModel/minimapTokensColorTracker.js';
import { RulersGpu } from './viewParts/rulersGpu/rulersGpu.js';
import { EditorScrollbar } from './viewParts/editorScrollbar/editorScrollbar.js';
import { LineNumbersOverlay } from './viewParts/lineNumbers/lineNumbers.js';
import { BlockDecorations } from './viewParts/blockDecorations/blockDecorations.js';
import { CurrentLineHighlightOverlay, CurrentLineMarginHighlightOverlay } from './viewParts/currentLineHighlight/currentLineHighlight.js';
import { IndentGuidesOverlay, type BracketGuideSource } from './viewParts/indentGuides/indentGuides.js';
import { LinesDecorationsOverlay } from './viewParts/linesDecorations/linesDecorations.js';
import { MarginViewLineDecorationsOverlay } from './viewParts/marginDecorations/marginDecorations.js';
import { SelectionsOverlay } from './viewParts/selections/selections.js';
import { ViewCursors } from './viewParts/viewCursors/viewCursors.js';
import { WhitespaceOverlay } from './viewParts/whitespace/whitespace.js';
import { Minimap } from './viewParts/minimap/minimap.js';
import { DecorationsOverviewRuler } from './viewParts/overviewRuler/decorationsOverviewRuler.js';
import { OverviewRuler } from './viewParts/overviewRuler/overviewRuler.js';
import { ScrollDecorationViewPart } from './viewParts/scrollDecoration/scrollDecoration.js';
import { ViewContentWidgets } from './viewParts/contentWidgets/contentWidgets.js';
import { ViewOverlayWidgets } from './viewParts/overlayWidgets/overlayWidgets.js';
import { type ViewPart } from './view/viewPart.js';
import { ViewContext } from '../common/viewModel/viewContext.js';
import { type IColorTheme } from '../../platform/theme/common/colorTheme.js';
import type { IContentWidget, IEditorAriaOptions, IGlyphMarginWidget, IOverlayWidget, IViewZoneChangeAccessor } from './editorBrowser.js';
import { ContentViewOverlays, MarginViewOverlays } from './view/viewOverlays.js';
import { LineWidthIndex, ViewLines } from './viewParts/viewLines/viewLines.js';
import { ViewLinesGpu } from './viewParts/viewLinesGpu/viewLinesGpu.js';
import { ViewGpuContext } from './gpu/viewGpuContext.js';
import { ViewZones } from './viewParts/viewZones/viewZones.js';
import { type HorizontalPosition, RenderingContext } from './view/renderingContext.js';
import { ViewportData } from '../common/viewLayout/viewLinesViewportData.js';
import { ViewController, type ViewControllerOptions } from './view/viewController.js';
import { type AbstractEditContext, type EditContextCharacterBounds, type EditContextOptions } from './controller/editContext/editContext.js';
import { type IClipboardCopyEvent, type IClipboardPasteEvent } from './controller/editContext/clipboardUtils.js';
import { NativeEditContext, type NativeEditContextOptions } from './controller/editContext/native/nativeEditContext.js';
import { TextAreaEditContext } from './controller/editContext/textArea/textAreaEditContext.js';
import { MouseHandler, type IPointerHandlerHelper } from './controller/mouseHandler.js';
import { PointerHandlerLastRenderData } from './controller/mouseTarget.js';
import './widget/codeEditor/editor.css';

interface BrowserCaretPosition {
	readonly offsetNode: Node;
	readonly offset: number;
}

interface BrowserCaretRange {
	readonly startContainer: Node;
	readonly startOffset: number;
}

interface BrowserCaretDocument {
	caretPositionFromPoint?(x: number, y: number): BrowserCaretPosition | null;
	caretRangeFromPoint?(x: number, y: number): BrowserCaretRange | null;
}

export type EditorViewportPresentation = "document" | "embedded";

export enum EditorTextDirection {
	Auto = 'auto',
	LeftToRight = 'ltr',
	RightToLeft = 'rtl',
}

/** Chooses which component renders the visible focus outline for an Stanza viewport. */
export type EditorFocusOutlineOwner = "editor" | "host";

/** Space reserved around the editor's projected text rows. */
export interface EditorViewportPadding {
	readonly right: number;
	readonly left: number;
}

export interface EditorViewportOptions {
	readonly container: HTMLElement;
	/** Reused by the Widget across model attachments; View owns its children. */
	readonly rootDomNode?: HTMLDivElement;
	readonly viewModel: IViewModel;
	readonly controller?: ViewControllerOptions;
	readonly configuration: EditorConfiguration;
	readonly theme: IColorTheme;
	readonly dimension?: IDimension;
	readonly padding?: EditorViewportPadding;
	readonly ariaLabel?: string;
	readonly textMeasurer?: TextMeasurer & { refresh?(): boolean };
	readonly semanticTokenSource?: SemanticTokenSource;
	readonly bracketGuideSource?: BracketGuideSource;
	readonly presentation?: EditorViewportPresentation;
	/** `host` delegates the visible focus outline to the viewport's direct host. */
	readonly focusOutlineOwner?: EditorFocusOutlineOwner;
	readonly indentation?: EditorIndentationOptions;
	/** Browser text-direction input; automatic direction is the default. */
	readonly textDirection?: EditorTextDirection;
}

export interface EditorContentPosition {
	readonly left: number;
	readonly top: number;
	readonly height: number;
}

/**
 * Read-only browser projection of one Stanza text model.
 *
 * The common viewport owns layout math. This component owns the scroll host,
 * measurement inputs, and ordered visual-part lifecycle; individual parts own
 * their projected DOM and canvas surfaces.
 */
export class View extends ViewEventHandler {
	readonly domNode: FastDomNode<HTMLDivElement>;
	readonly onDidChangeLayout: Event<EditorViewportChange>;
	readonly onWillCopy: Event<IClipboardCopyEvent>;
	readonly onWillCut: Event<IClipboardCopyEvent>;
	readonly onWillPaste: Event<IClipboardPasteEvent>;
	readonly controller: ViewController;
	private _fontInfo: FontInfo;
	private readonly model: TextModel;
	private readonly viewport: ViewLayout;
	private readonly contentElement: HTMLDivElement;
	private readonly contentNode: FastDomNode<HTMLDivElement>;
	private readonly textMetricsElement: HTMLSpanElement;
	private readonly accessibilityStatusElement: HTMLDivElement;
	private readonly viewContext: ViewContext;
	private readonly viewParts: ViewPart[] = [];
	private readonly scrollbar: EditorScrollbar;
	private readonly viewGpuContext: ViewGpuContext | undefined;
	private readonly viewLines: ViewLines;
	private readonly viewLinesGpu: ViewLinesGpu | undefined;
	private readonly viewZones: ViewZones;
	private readonly contentWidgets: ViewContentWidgets;
	private readonly overlayWidgets: ViewOverlayWidgets;
	private readonly glyphMarginWidgets: GlyphMarginWidgets;
	private readonly margin: Margin;
	private readonly contentViewOverlays: ContentViewOverlays;
	private readonly marginViewOverlays: MarginViewOverlays;
	private readonly decorations: DecorationsOverlay;
	private readonly viewCursors: ViewCursors;
	private readonly textMeasurer: TextMeasurer & { refresh?(): boolean };
	private readonly lineWidths: LineWidthIndex;
	private readonly viewModel: IViewModel;
	readonly coordinatesConverter: IViewModel['coordinatesConverter'];
	readonly cursorConfig: IViewModel['cursorConfig'];
	private readonly presentation: EditorViewportPresentation;
	private readonly focusOutlineOwner: EditorFocusOutlineOwner;
	private readonly padding: EditorViewportPadding;
	private readonly indentation: ResolvedEditorIndentationOptions;
	private readonly minimapLayoutMemory = new ComputeOptionsMemory();
	private readonly textDirection: EditorTextDirection;
	private readonly editorConfiguration: EditorConfiguration;
	private readonly pixelRatio: IPixelRatioMonitor;
	private changingLayout = false;
	private syncedScrollLeft = 0;
	private syncedScrollTop = 0;
	private projectionRevision = 0;
	private projectionScheduled = false;

	get currentLayout(): EditorViewportLayout {
		return this.viewport.layout;
	}

	getLayoutInfo(): EditorLayoutInfo {
		return this.editorConfiguration.options.get(EditorOption.layoutInfo);
	}

	getOption<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
		return this.editorConfiguration.options.get(id);
	}

	get fontInfo(): FontInfo {
		return this._fontInfo;
	}

	constructor(options: EditorViewportOptions) {
		validateEditorViewportOptions(options);
		super();
		const ownerDocument = options.container.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) throw new ReferenceError('Editor viewport requires a browser window');
		this.pixelRatio = PixelRatio.getInstance(ownerWindow);
		if (!(options.viewModel.model instanceof TextModel)) throw new TypeError('Editor view requires the editor text model implementation');
		const viewport = options.viewModel.viewLayout;
		if (!(viewport instanceof ViewLayout)) throw new TypeError('Editor view requires the editor view layout implementation');
		if (options.rootDomNode && (options.rootDomNode.parentElement !== options.container || options.rootDomNode.childNodes.length > 0)) {
			throw new TypeError('Editor view requires an empty root in its container');
		}
		this.viewModel = options.viewModel;
		this.model = options.viewModel.model;
		this.domNode = new FastDomNode(options.rootDomNode ?? h(ownerDocument, "div"));
		this.contentElement = h(ownerDocument, "div");
		this.contentNode = new FastDomNode(this.contentElement);
		this.textMetricsElement = h(ownerDocument, "span");
		this.accessibilityStatusElement = h(ownerDocument, "div");
		this.presentation = options.presentation ?? "document";
		this.focusOutlineOwner = options.focusOutlineOwner ?? "editor";
		this.editorConfiguration = options.configuration;
		const mouseStyle = this.editorConfiguration.options.get(EditorOption.mouseStyle);
		this.padding = resolveEditorViewportPadding(options.padding);
		this.indentation = resolveEditorIndentationOptions(options.indentation);
		this.textDirection = options.textDirection ?? EditorTextDirection.Auto;
		this.domNode.domNode.className = "stanza-editor";
		this.domNode.domNode.classList.add(`stanza-editor-${this.presentation}`);
		this.domNode.domNode.classList.add(`stanza-editor-focus-owner-${this.focusOutlineOwner}`);
		this.domNode.domNode.classList.add(`stanza-editor-direction-${this.textDirection}`);
		this.domNode.domNode.classList.add(`stanza-editor-mouse-${mouseStyle}`);
		this.domNode.domNode.classList.toggle("hide-line-numbers", options.configuration.options.get(EditorOption.lineNumbers).renderType === RenderLineNumbersType.Off);
		this.domNode.domNode.style.tabSize = String(this.indentation.tabSize);
		this.domNode.domNode.style.setProperty("--stanza-editor-padding-left", `${this.padding.left}px`);
		this.domNode.domNode.style.setProperty("--stanza-editor-padding-right", `${this.padding.right}px`);
		this.domNode.domNode.dir = this.textDirection;
		this.domNode.domNode.classList.toggle("word-wrapped", this.softWrapping);
		this.domNode.domNode.tabIndex = 0;
		this.domNode.domNode.setAttribute("role", "region");
		this.domNode.domNode.setAttribute("aria-label", options.ariaLabel ?? "Stanza editor");
		this.contentNode.setClassName("stanza-editor-content");
		this.textMetricsElement.className =
			"stanza-editor-text-metrics";
		this.textMetricsElement.setAttribute("aria-hidden", "true");
		this.accessibilityStatusElement.className = "stanza-editor-accessibility-status";
		this.accessibilityStatusElement.setAttribute("aria-live", "polite");
		this.accessibilityStatusElement.setAttribute("aria-atomic", "true");
		this.domNode.domNode.append(this.contentElement, this.textMetricsElement, this.accessibilityStatusElement);
		if (options.rootDomNode) {
			this._register(toDisposable(() => {
				this.domNode.domNode.replaceChildren();
				this.domNode.domNode.scrollLeft = 0;
				this.domNode.domNode.scrollTop = 0;
			}));
		} else {
			options.container.append(this.domNode.domNode);
			this._register(toDisposable(() => this.domNode.domNode.remove()));
		}
		this.textMeasurer =
			options.textMeasurer ??
			new BrowserTextMeasurer(this.textMetricsElement);
		this._fontInfo = this.editorConfiguration.options.get(EditorOption.fontInfo);
		applyFontInfo(this.domNode.domNode, this.fontInfo);
		const spaceWidth = this.fontInfo.spaceWidth;
		this.cursorConfig = this.viewModel.cursorConfig;
		this.lineWidths = this._register(new LineWidthIndex(
			this.model,
			this.textMeasurer,
			{
				initialMeasurement: {
					...(this.model.largeFile.tooLargeForTokenization ? { maximumMeasuredLineCount: 2_048 } : {}),
					schedule: callback => runWhenWindowIdle(
						ownerWindow,
						() => callback(),
						250,
					),
				},
			},
		));
		this.coordinatesConverter = this.viewModel.coordinatesConverter;
		this.viewport = viewport;
		this.onDidChangeLayout = viewport.onDidChange;
		this.viewContext = new ViewContext(this.editorConfiguration, options.theme, this.viewModel);
		this.viewGpuContext = this.editorConfiguration.options.get(EditorOption.experimentalGpuAcceleration) === 'on'
			? this._register(new ViewGpuContext(this.viewContext))
			: undefined;
		this.controller = this._register(new ViewController(this, options.viewModel, options.controller ?? {}, controller => {
			const input = createEditContext(this.viewContext, this.domNode.domNode, {
				...options.controller,
				readOnly: options.viewModel.cursorConfig.readOnly,
				textDirection: this.editorTextDirection,
				ownerId: controller.ownerId,
				characterBoundsProvider: modelOffset => this.characterBoundsAt(modelOffset),
				viewController: controller,
				viewport: this,
			});
			this.domNode.domNode.append(input.domNode.domNode);
			return this.registerViewPart(input);
		}));
		this.onWillCopy = this.controller.editContext.onWillCopy;
		this.onWillCut = this.controller.editContext.onWillCut;
		this.onWillPaste = this.controller.editContext.onWillPaste;
		this.viewZones = this.registerViewPart(new ViewZones(this.viewContext));
		this.contentWidgets = this.registerViewPart(new ViewContentWidgets(this.viewContext, this.domNode));
		this.overlayWidgets = this.registerViewPart(new ViewOverlayWidgets(this.viewContext, {
			viewDomNode: this.domNode.domNode,
			requestRender: () => {
				if (!this.isDisposed) this.project(this.viewport.layout);
			},
		}));
		this.viewLines = this.registerViewPart(new ViewLines(this.viewContext, {
			host: this.contentElement,
			model: this.model,
			readVisualProjection: () => this.visualProjection,
			readProjectionRevision: () => this.projectionRevision,
			semanticTokenSource: options.semanticTokenSource,
			configuration: this.editorConfiguration,
			themeType: options.theme.colorScheme,
			tabSize: this.indentation.tabSize,
			typicalHalfwidthCharacterWidth: Math.max(1, this.textMeasurer.measureLineWidth(' ')),
			viewGpuContext: this.viewGpuContext,
		}));
		this.viewLinesGpu = this.viewGpuContext
			? this.registerViewPart(new ViewLinesGpu(this.viewContext, this.viewGpuContext))
			: undefined;
		this.contentViewOverlays = this.registerViewPart(new ContentViewOverlays(this.viewContext, this.contentElement));
		this.decorations = new DecorationsOverlay(this.viewContext);
		this.contentViewOverlays.addDynamicOverlay(new CurrentLineHighlightOverlay(this.viewContext));
		this.contentViewOverlays.addDynamicOverlay(new SelectionsOverlay(this.viewContext, this.viewModel, this.model, this.contentElement, () => this.visualProjection, () => this.textLeft, this.textMeasurer));
		this.contentViewOverlays.addDynamicOverlay(new IndentGuidesOverlay(this.viewContext, {
			bracketGuideSource: options.bracketGuideSource,
			viewModel: this.viewModel,
			host: this.contentElement,
			readVisualProjection: () => this.visualProjection,
			readTextLeft: () => this.textLeft,
			textMeasurer: this.textMeasurer,
		}));
		this.contentViewOverlays.addDynamicOverlay(this.decorations);
		this.contentViewOverlays.addDynamicOverlay(new WhitespaceOverlay(
			this.viewContext,
			this.model,
			this.viewModel,
			this.contentElement,
			() => this.visualProjection,
			() => this.textLeft,
			this.textMeasurer,
		));
		this.viewCursors = this.registerViewPart(new ViewCursors(this.viewContext, {
			host: this.contentElement,
			semanticTokenSource: options.semanticTokenSource,
			readVisualProjection: () => this.visualProjection,
			readTextLeft: () => this.textLeft,
			textMeasurer: this.textMeasurer,
		}, this.model, this.viewModel));
		const blockDecorations = this.registerViewPart(new BlockDecorations(this.viewContext));
		this.margin = this.registerViewPart(new Margin(this.viewContext));
		this.marginViewOverlays = this.registerViewPart(new MarginViewOverlays(this.viewContext, this.contentElement));
		this.marginViewOverlays.addDynamicOverlay(new CurrentLineMarginHighlightOverlay(this.viewContext));
		this.marginViewOverlays.addDynamicOverlay(new MarginViewLineDecorationsOverlay(this.viewContext));
		this.marginViewOverlays.addDynamicOverlay(new LinesDecorationsOverlay(this.viewContext));
		this.marginViewOverlays.addDynamicOverlay(new LineNumbersOverlay(this.viewContext, {
			viewModel: this.viewModel,
			readVisualProjection: () => this.visualProjection,
			host: this.contentElement,
		}));
		this.glyphMarginWidgets = this.registerViewPart(new GlyphMarginWidgets(this.viewContext));
		this.margin.getDomNode().domNode.append(this.viewZones.marginDomNode.domNode, this.marginViewOverlays.getDomNode().domNode, this.glyphMarginWidgets.domNode.domNode);
		let rulersDomNode: HTMLElement | undefined;
		if (this.viewLinesGpu) {
			this.marginViewOverlays.addDynamicOverlay(new GpuMarkOverlay(this.viewContext, this.viewGpuContext!));
			this.registerViewPart(new RulersGpu(
				this.viewContext,
				this.viewGpuContext!,
			));
		} else {
			rulersDomNode = this.registerViewPart(new Rulers(this.viewContext, {
				host: this.contentElement,
				readTextLeft: () => this.textLeft,
			})).domNode.domNode;
		}
		this.scrollbar = this.registerViewPart(new EditorScrollbar(this.viewContext, this.contentNode, this.domNode, this.domNode));
		this.domNode.domNode.prepend(this.scrollbar.getDomNode().domNode);
		const minimapPart = this.registerViewPart(new Minimap(this.viewContext, {
			host: this.domNode.domNode,
			model: this.model,
			semanticTokenSource: options.semanticTokenSource,
			readLayout: () => this.viewport.layout,
			readMinimapLayout: () => this.computeMinimapLayout(this.viewport.layout.viewportSize.width, this.viewport.layout.viewportSize.height),
			readVisualProjection: () => this.visualProjection,
			readProjectionRevision: () => this.projectionRevision,
			scrollTo: position => this.scrollTo(position),
		}));
		const decorationsOverviewRuler = this.registerViewPart(new DecorationsOverviewRuler(this.viewContext));
		const scrollDecoration = this.registerViewPart(new ScrollDecorationViewPart(this.viewContext, this.domNode.domNode));

		// Root order is the visual stacking contract; Parts own nodes but do not choose their host.
		this.contentElement.append(
			this.viewLines.getDomNode().domNode,
			this.contentViewOverlays.getDomNode().domNode,
			this.viewCursors.getDomNode().domNode,
			this.contentWidgets.domNode.domNode,
			this.margin.getDomNode().domNode,
			blockDecorations.domNode.domNode,
			...(rulersDomNode ? [rulersDomNode] : []),
		);
		this.domNode.domNode.append(
			...(this.viewGpuContext ? [this.viewGpuContext.canvas.domNode] : []),
			this.overlayWidgets.getDomNode().domNode,
			minimapPart.getDomNode().domNode,
			scrollDecoration.getDomNode().domNode,
			this.viewZones.domNode.domNode,
		);
		const overviewRulerLayout = this.scrollbar.getOverviewRulerLayoutInfo();
		overviewRulerLayout.parent.insertBefore(decorationsOverviewRuler.getDomNode(), overviewRulerLayout.insertBefore);
		this._register(addDisposableListener(decorationsOverviewRuler.getDomNode(), 'pointerdown', (event: PointerEvent) => this.delegateVerticalScrollbarPointerDown(event)));
		this._register(new MouseHandler(this.viewContext, this.controller, this.createPointerHandlerHelper()));
		ownerDocument.body.append(
			this.contentWidgets.overflowingContentWidgetsDomNode.domNode,
			this.overlayWidgets.overflowingOverlayWidgetsDomNode.domNode,
		);
		viewport.setMaxLineWidth(this.measuredContentWidth);

		this._register(MinimapTokensColorTracker.getInstance().onDidChange(() => this.project(viewport.layout)));
		this._register(this.lineWidths.onDidChange(() => {
			viewport.setMaxLineWidth(this.measuredContentWidth);
			this.scheduleProjection();
		}));
		this._register(addDisposableListener(this.domNode.domNode, "scroll", () => {
			if (this.domNode.domNode.scrollLeft === this.syncedScrollLeft && this.domNode.domNode.scrollTop === this.syncedScrollTop) return;
			viewport.setScrollPosition({
				scrollLeft: this.domNode.domNode.scrollLeft,
				scrollTop: this.domNode.domNode.scrollTop,
			}, ScrollType.Immediate);
			this.syncScrollPosition(viewport.layout);
		}));
		this._register(this.model.onDidChangeContent(change => {
			this.lineWidths.applyModelChange(change);
			viewport.setMaxLineWidth(this.measuredContentWidth);
		}));
		this.updateAccessibilityStatus();
		const semanticTokenSource = options.semanticTokenSource;
		if (semanticTokenSource) {
			this._register(semanticTokenSource.onDidChange(() => {
				this.viewLines.onTokensChanged();
				this.viewCursors.forceShouldRender();
				minimapPart.forceShouldRender();
				this.scheduleProjection();
			}));
		}
		const fontSet = ownerDocument.fonts;
		if (fontSet) {
			this._register(addDisposableListener(fontSet, "loadingdone", () => {
				this.refreshFontMetrics();
			}));
		}

		this._register(this.editorConfiguration.onDidChange(event => {
			if (event.hasChanged(EditorOption.mouseStyle)) {
				for (const style of ['text', 'default', 'copy']) {
					this.domNode.domNode.classList.toggle(`stanza-editor-mouse-${style}`, style === this.editorConfiguration.options.get(EditorOption.mouseStyle));
				}
			}
			if (event.hasChanged(EditorOption.fontInfo)) this.applyFontConfiguration();
			if (event.hasChanged(EditorOption.wrappingInfo)) {
				this.domNode.domNode.classList.toggle("word-wrapped", this.softWrapping);
			}
			if (!this.changingLayout && event.hasChanged(EditorOption.layoutInfo)) {
				const layoutInfo = this.editorConfiguration.options.get(EditorOption.layoutInfo);
				this.domNode.setWidth(layoutInfo.width);
				this.domNode.setHeight(layoutInfo.height);
				this.project(viewport.layout);
			}
		}));
		this._register(this.pixelRatio.onDidChange(() => this.project(viewport.layout)));
		this.viewModel.addViewEventHandler(this);
		this._register(toDisposable(() => this.viewModel.removeViewEventHandler(this)));
		this.layout(options.dimension ?? getClientArea(this.domNode.domNode));
		this.onDidRender();
	}

	private get softWrapping(): boolean {
		return this.editorConfiguration.options.get(EditorOption.wrappingInfo).wrappingColumn > 0;
	}

	private get minimap(): EditorMinimapOptions {
		return this.editorConfiguration.options.get(EditorOption.minimap);
	}

	get viewportLayout(): EditorViewportLayout {
		return this.viewport.layout;
	}

	get textModel(): TextModel {
		return this.model;
	}

	get lineWrapping(): EditorLineWrapping {
		return this.softWrapping
			? EditorLineWrapping.On
			: EditorLineWrapping.Off;
	}

	get wrappingIndent(): WrappingIndent {
		return this.editorConfiguration.options.get(EditorOption.wrappingIndent);
	}

	/** Returns the browser paragraph direction used by the text projection. */
	get editorTextDirection(): EditorTextDirection {
		return this.textDirection;
	}

	/** Changes only this viewport's visual row projection; document text is unaffected. */
	setLineWrapping(lineWrapping: EditorLineWrapping): EditorViewportLayout {
		if (!Object.values(EditorLineWrapping).includes(lineWrapping)) {
			throw new TypeError("Unknown Stanza editor line wrapping mode");
		}
		const nextSoftWrapping = lineWrapping === EditorLineWrapping.On;
		if (nextSoftWrapping === this.softWrapping) return this.viewport.layout;
		this.editorConfiguration.updateOptions({ wordWrap: nextSoftWrapping ? 'on' : 'off' });
		this.domNode.domNode.classList.toggle("word-wrapped", nextSoftWrapping);
		this.viewport.setMaxLineWidth(this.measuredContentWidth);
		const layout = this.viewport.layout;
		this.project(layout);
		return layout;
	}

	setWrappingIndent(wrappingIndent: WrappingIndent): EditorViewportLayout {
		if (!isWrappingIndent(wrappingIndent)) {
			throw new TypeError("Unknown Stanza wrapping indent mode");
		}
		if (wrappingIndent === this.wrappingIndent) return this.viewport.layout;
		this.editorConfiguration.updateOptions({ wrappingIndent: rawWrappingIndent(wrappingIndent) });
		this.viewport.setMaxLineWidth(this.measuredContentWidth);
		const layout = this.viewport.layout;
		this.project(layout);
		return layout;
	}

	/** Returns the current measured visual-row mapping for browser interactions. */
	getVisualLineProjection(): EditorVisualLineProjection {
		return this.visualProjection;
	}

	/** Measures text with the same font metrics used by the rendered viewport. */
	measureTextWidth(text: string): number {
		return this.textMeasurer.measureLineWidth(text);
	}

	getLineWidth(lineNumber: number): number {
		return this.viewLines.getLineWidth(lineNumber);
	}

	resetLineWidthCaches(): void {
		this.viewLines.resetLineWidthCaches();
		this.lineWidths.refresh();
	}

	layout(size: ISize = getClientArea(this.domNode.domNode)): EditorViewportLayout {
		this.changingLayout = true;
		try {
			this.editorConfiguration.observeContainer(size);
			return this.layoutViewport(size);
		} finally {
			this.changingLayout = false;
		}
	}

	writeScreenReaderContent(reason: string): void {
		this.controller.editContext.writeScreenReaderContent(reason);
	}

	focus(): void {
		this.controller.editContext.focus();
	}

	isFocused(): boolean {
		return this.controller.editContext.isFocused();
	}

	isWidgetFocused(): boolean {
		const activeElement = this.domNode.domNode.ownerDocument.activeElement;
		return activeElement !== null && this.domNode.domNode.contains(activeElement);
	}

	refreshFocusState(): void {
		this.controller.editContext.refreshFocusState();
	}

	setAriaOptions(options: IEditorAriaOptions): void {
		this.controller.editContext.setAriaOptions(options);
	}

	render(_now: boolean, everything: boolean): void {
		if (everything) {
			this.forceShouldRender();
			for (const viewPart of this.viewParts) viewPart.forceShouldRender();
		}
		this.project(this.viewport.layout);
	}

	private layoutViewport(size: ISize): EditorViewportLayout {
		this.domNode.setWidth(size.width);
		this.domNode.setHeight(size.height);
		this.refreshFontMetrics();
		const layout = this.viewport.layout;
		this.project(layout);
		return layout;
	}

	/** Announces one editor status message through the viewport's live region. */
	announceAccessibilityStatus(message: string): void {
		if (typeof message !== "string" || message.trim().length === 0) {
			throw new TypeError("Stanza accessibility status must be a non-empty string");
		}
		this.accessibilityStatusElement.textContent = message.trim();
	}

	refreshFontMetrics(force = false): EditorViewportLayout {
		if (!this.textMeasurer.refresh?.() && !force) return this.viewport.layout;
		this.lineWidths.refresh();
		this.viewport.setMaxLineWidth(this.measuredContentWidth);
		const layout = this.viewport.layout;
		this.project(layout);
		return layout;
	}

	private applyFontConfiguration(): void {
		this._fontInfo = this.editorConfiguration.options.get(EditorOption.fontInfo);
		applyFontInfo(this.domNode.domNode, this._fontInfo);
		this.refreshFontMetrics(true);
	}

	setLineHeight(lineHeight: number): EditorViewportLayout {
		this.editorConfiguration.updateOptions({ lineHeight });
		return this.viewport.layout;
	}

	changeViewZones(callback: (accessor: IViewZoneChangeAccessor) => void): void {
		if (this.viewZones.changeViewZones(callback)) this.project(this.viewport.layout);
	}

	createOverviewRuler(cssClassName: string): OverviewRuler {
		return new OverviewRuler(this.viewContext, cssClassName);
	}

	addContentWidget(widget: IContentWidget): void {
		this.contentWidgets.addWidget(widget);
		this.layoutContentWidget(widget);
	}

	layoutContentWidget(widget: IContentWidget): void {
		this.contentWidgets.setWidgetPosition(widget, widget.getPosition());
		this.project(this.viewport.layout);
	}

	removeContentWidget(widget: IContentWidget): void {
		this.contentWidgets.removeWidget(widget);
	}

	addOverlayWidget(widget: IOverlayWidget): void {
		this.overlayWidgets.addWidget(widget);
		this.layoutOverlayWidget(widget);
	}

	layoutOverlayWidget(widget: IOverlayWidget): void {
		if (this.overlayWidgets.setWidgetPosition(widget, widget.getPosition())) {
			this.project(this.viewport.layout);
		}
	}

	removeOverlayWidget(widget: IOverlayWidget): void {
		this.overlayWidgets.removeWidget(widget);
		this.project(this.viewport.layout);
	}

	addGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.glyphMarginWidgets.addWidget(widget);
		this.project(this.viewport.layout);
	}

	layoutGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		if (this.glyphMarginWidgets.setWidgetPosition(widget, widget.getPosition())) this.project(this.viewport.layout);
	}

	removeGlyphMarginWidget(widget: IGlyphMarginWidget): void {
		this.glyphMarginWidgets.removeWidget(widget);
		this.project(this.viewport.layout);
	}

	scrollTo(position: EditorScrollPosition): EditorViewportLayout {
		this.viewport.setScrollPosition({ scrollLeft: position.left, scrollTop: position.top }, ScrollType.Immediate);
		const layout = this.viewport.layout;
		this.project(layout);
		return layout;
	}

	revealPosition(position: Position): EditorViewportLayout {
		this.model.offsetAt(position);
		const layout = this.viewport.layout;
		const visualProjection = this.visualProjection;
		const visualLineIndex = visualProjection.visualLineIndexAt(position);
		const visualLine = visualProjection.lineAt(visualLineIndex)!;
		const lineTop = this.viewport.getVerticalOffsetForLineIndex(visualLineIndex);
		const lineBottom = lineTop + layout.lineHeight;
		let top = layout.scrollPosition.top;
		if (lineTop < top) {
			top = lineTop;
		} else if (lineBottom > top + layout.viewportSize.height) {
			top = lineBottom - layout.viewportSize.height;
		}

		const line = this.model.getLineContent((visualLine.logicalLineIndex) + 1);
		const columnIndex = position.column - 1;
		const domCaretLeft = this.domCaretLeft(visualLineIndex, columnIndex - visualLine.startColumn);
		const caretLeft = domCaretLeft ?? (this.contentTextLeft + (visualLine.wrappedTextIndentWidth ?? 0) +
			this.textMeasurer.measureLineWidth(line.slice(visualLine.startColumn, columnIndex)));
		const caretRight = caretLeft + Math.max(
			1,
			this.textMeasurer.measureLineWidth(" "),
		);
		let left = this.softWrapping ? 0 : layout.scrollPosition.left;
		if (caretLeft < left + this.contentTextLeft) {
			left = caretLeft - this.contentTextLeft;
		} else if (caretRight > left + layout.viewportSize.width) {
			left = caretRight - layout.viewportSize.width;
		}
		return this.scrollTo({ left, top });
	}

	getPositionContentCoordinates(position: Position): EditorContentPosition {
		this.model.offsetAt(position);
		const visualProjection = this.visualProjection;
		const visualLineIndex = visualProjection.visualLineIndexAt(position);
		const visualLine = visualProjection.lineAt(visualLineIndex)!;
		const columnIndex = position.column - 1;
		const domCaretLeft = this.domCaretLeft(visualLineIndex, columnIndex - visualLine.startColumn);
		return Object.freeze({
			left: domCaretLeft ?? (this.contentTextLeft + (visualLine.wrappedTextIndentWidth ?? 0) + this.textMeasurer.measureLineWidth(
				this.model.getLineContent((visualLine.logicalLineIndex) + 1).slice(visualLine.startColumn, columnIndex),
			)),
			top: this.viewport.getVerticalOffsetForLineIndex(visualLineIndex),
			height: this.viewport.layout.lineHeight,
		});
	}

	/** Returns a browser-shaped x-coordinate for one rendered visual cursor, when available. */
	getVisualHorizontalOffset(position: Position): number | undefined {
		this.model.offsetAt(position);
		const viewPosition = this.viewModel.coordinatesConverter.convertModelPositionToViewPosition(position);
		return this.viewLines.visibleRangeForPosition(viewPosition)?.left;
	}

	/** Resolves the nearest browser-shaped cursor on one currently rendered visual line. */
	getNearestPositionAtVisualHorizontalOffset(visualLineIndex: number, horizontalOffset: number): Position | undefined {
		if (!isFiniteNumber(horizontalOffset)) throw new RangeError("Stanza visual cursor horizontal offset must be finite");
		if (this.editorTextDirection === EditorTextDirection.LeftToRight) return undefined;
		const visualLine = this.visualProjection.lineAt(visualLineIndex);
		if (!visualLine) return undefined;
		const text = this.model.getLineContent((visualLine.logicalLineIndex) + 1).slice(visualLine.startColumn, visualLine.endColumn);
		let nearestColumn: number | undefined;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const column of getTextGraphemeBoundaries(text)) {
			const position = new Position((visualLine.logicalLineIndex) + 1, visualLine.startColumn + column + 1);
			const left = this.viewLines.visibleRangeForPosition(new Position(visualLineIndex + 1, column + 1))?.left;
			if (left === undefined) return undefined;
			const distance = Math.abs(left - horizontalOffset);
			if (distance < nearestDistance) {
				nearestColumn = column;
				nearestDistance = distance;
			}
		}
		return nearestColumn === undefined
			? undefined
			: new Position((visualLine.logicalLineIndex) + 1, (visualLine.startColumn + nearestColumn) + 1);
	}

	public delegateVerticalScrollbarPointerDown(event: PointerEvent): void {
		this.scrollbar.delegateVerticalScrollbarPointerDown(event);
	}

	public delegateScrollFromMouseWheelEvent(event: IMouseWheelEvent): void {
		this.scrollbar.delegateScrollFromMouseWheelEvent(event);
	}

	private createPointerHandlerHelper(): IPointerHandlerHelper {
		return {
			viewDomNode: this.domNode.domNode,
			linesContentDomNode: this.contentElement,
			viewLinesDomNode: this.viewLines.getDomNode().domNode,
			viewLinesGpu: this.viewLinesGpu,
			delegateScrollFromMouseWheelEvent: event => this.delegateScrollFromMouseWheelEvent(event),
			focusTextArea: () => this.controller.editContext.focus(),
			dispatchTextAreaEvent: event => this.controller.element.dispatchEvent(event),
			getLastRenderData: () => new PointerHandlerLastRenderData(this.viewCursors.getLastRenderData(), this.controller.editContext.getLastRenderData()),
			renderNow: () => {
				if (!this.isDisposed) this.project(this.viewport.layout);
			},
			shouldSuppressMouseDownOnViewZone: id => this.viewZones.shouldSuppressMouseDownOnViewZone(id),
			shouldSuppressMouseDownOnWidget: id => this.contentWidgets.shouldSuppressMouseDownOnWidget(id),
			getPositionFromDOMInfo: (spanNode, offset) => this.getPositionFromDOMInfo(spanNode, offset),
			visibleRangeForPosition: (lineNumber, column): HorizontalPosition | null => {
				const position = new Position(lineNumber, column);
				return this.viewLines.visibleRangeForPosition(position) ?? this.viewLinesGpu?.visibleRangeForPosition(position) ?? null;
			},
			getLineWidth: lineNumber => this.viewLinesGpu?.getLineWidth(lineNumber) ?? this.viewLines.getLineWidth(lineNumber),
		};
	}

	getTargetAtClientPoint(
		point: ClientPoint,
	): EditorHitTarget | undefined {
		validateClientPoint(point);
		const domTarget = this.editorTextDirection === EditorTextDirection.LeftToRight
			? undefined
			: this.getDomTargetAtClientPoint(point);
		if (domTarget) return domTarget;
		const bounds = this.domNode.domNode.getBoundingClientRect();
		return this.hitTestViewportPoint(
			point.clientX - bounds.left,
			point.clientY - bounds.top,
		);
	}

	getNearestTargetAtClientPoint(point: ClientPoint): EditorHitTarget | undefined {
		validateClientPoint(point);
		const domTarget = this.editorTextDirection === EditorTextDirection.LeftToRight
			? undefined
			: this.getDomTargetAtClientPoint(point);
		if (domTarget) return domTarget;
		const layout = this.viewport.layout;
		if (
			layout.viewportSize.width === 0 ||
			layout.viewportSize.height === 0
		) {
			return undefined;
		}
		const bounds = this.domNode.domNode.getBoundingClientRect();
		return this.hitTestViewportPoint(
			clamp(point.clientX - bounds.left, 0, layout.viewportSize.width - 0.5),
			clamp(point.clientY - bounds.top, 0, layout.viewportSize.height - 0.5),
		);
	}

	private hitTestViewportPoint(left: number, top: number): EditorHitTarget | undefined {
		return hitTestStanzaVisualEditorPoint(
			this.model,
			this.visualProjection,
			this.viewport.layout,
			{ left: left - this.contentOffsetLeft, top },
			{
				gutterWidth: this.gutterWidth,
				textLeft: this.textLeft,
				paddingTop: this.editorConfiguration.options.get(EditorOption.padding).top,
				getLineIndexAtVerticalOffset: offset => this.viewport.getLineIndexAtVerticalOffset(offset),
			},
			this.textMeasurer,
		);
	}

	private getDomTargetAtClientPoint(point: ClientPoint): EditorHitTarget | undefined {
		const document = this.domNode.domNode.ownerDocument as unknown as BrowserCaretDocument;
		const caret = document.caretPositionFromPoint?.(point.clientX, point.clientY) ?? document.caretRangeFromPoint?.(point.clientX, point.clientY);
		if (!caret) return undefined;
		const node = 'offsetNode' in caret ? caret.offsetNode : caret.startContainer;
		const offset = 'offsetNode' in caret ? caret.offset : caret.startOffset;
		const element = node.nodeType === node.TEXT_NODE ? node.parentElement : node as HTMLElement;
		if (!element) return undefined;
		const viewPosition = this.getPositionFromDOMInfo(element, offset);
		return viewPosition ? Object.freeze({
			kind: EditorHitTargetKind.Text,
			position: this.coordinatesConverter.convertViewPositionToModelPosition(viewPosition),
			viewPosition,
			injectedText: this.viewModel.getInjectedTextAt(viewPosition),
		}) : undefined;
	}

	getPositionFromDOMInfo(spanNode: HTMLElement, offset: number): Position | null {
		return this.viewLines.getPositionFromDOMInfo(spanNode, offset);
	}

	getInjectedTextAt(viewPosition: Position): ReturnType<IViewModel['getInjectedTextAt']> {
		return this.viewModel.getInjectedTextAt(viewPosition);
	}

	private domCaretLeft(visualLineIndex: number, offset: number): number | undefined {
		if (this.editorTextDirection === EditorTextDirection.LeftToRight) return undefined;
		const visualLine = this.visualProjection.lineAt(visualLineIndex);
		if (!visualLine) return undefined;
		return this.viewLines.visibleRangeForPosition(new Position(visualLineIndex + 1, offset + 1))?.left;
	}

	private get measuredContentWidth(): number {
		const textContentWidth = this.softWrapping ? 0 : Math.ceil(
			this.gutterWidth +
			this.lineWidths.maximumLineWidth +
			this.textMeasurer.horizontalPadding,
		);
		return textContentWidth;
	}

	private get gutterWidth(): number {
		return Math.max(0, this.editorConfiguration.options.get(EditorOption.layoutInfo).contentLeft - this.contentOffsetLeft);
	}

	private get textLeft(): number {
		return this.gutterWidth + this.textMeasurer.contentLeftPadding;
	}

	private get contentTextLeft(): number {
		return this.contentOffsetLeft + this.textLeft;
	}

	private get contentOffsetLeft(): number {
		return this.minimap.side === 'left'
			? this.editorConfiguration.options.get(EditorOption.layoutInfo).minimap.minimapWidth
			: 0;
	}

	private computeMinimapLayout(viewportWidth: number, viewportHeight: number): EditorMinimapLayoutInfo {
		return EditorLayoutInfoComputer._computeMinimapLayout({
			outerWidth: viewportWidth,
			outerHeight: viewportHeight,
			lineHeight: this.viewport.layout.lineHeight,
			typicalHalfwidthCharacterWidth: Math.max(1, this.textMeasurer.measureLineWidth('n')),
			pixelRatio: this.pixelRatio.value,
			scrollBeyondLastLine: false,
			paddingTop: this.editorConfiguration.options.get(EditorOption.padding).top,
			paddingBottom: this.editorConfiguration.options.get(EditorOption.padding).bottom,
			minimap: this.minimap,
			verticalScrollbarWidth: this.editorConfiguration.options.get(EditorOption.layoutInfo).verticalScrollbarWidth,
			viewLineCount: this.visualProjection.visualLineCount,
			remainingWidth: Math.max(0, viewportWidth - this.gutterWidth),
			isViewportWrapping: this.softWrapping,
		}, this.minimapLayoutMemory);
	}

	private project(layout: EditorViewportLayout): void {
		this.observeRenderedLineWidths(layout);
		if (layout !== this.viewport.layout) return;
		this.computeGlyphMarginLanes();
		const startLineNumber = layout.visibleLines.startLineIndex + 1;
		const endLineNumber = layout.visibleLines.endLineIndexExclusive;
		if (startLineNumber <= endLineNumber) {
			this.viewModel.setViewport(startLineNumber, endLineNumber, Math.floor((startLineNumber + endLineNumber) / 2));
			this.viewModel.visibleLinesStabilized();
		}
		const viewportData = this.createViewportData();
		const context = this.createRenderingContext(viewportData);
		this.domNode.domNode.classList.toggle("horizontally-scrollable", layout.maximumScrollPosition.left > 0);
		this.domNode.domNode.classList.toggle("vertically-scrollable", layout.maximumScrollPosition.top > 0);
		this.contentNode.setWidth(layout.contentSize.width);
		this.contentNode.setHeight(layout.contentSize.height);
		const contentOffsetLeft = this.contentOffsetLeft;
		this.contentNode.setTransform(contentOffsetLeft > 0 ? `translate3d(${contentOffsetLeft}px, 0, 0)` : '');
		for (const part of this.viewParts) part.onBeforeRender(context.viewportData);
		// Text rows must exist before overlays measure their visible horizontal ranges.
		// This is the same render boundary used by VS Code's coordinated renderer.
		this.viewLines.render(context);
		this.viewLines.onDidRender();
		if (this.viewLinesGpu) {
			this.viewLinesGpu.render(context);
			this.viewLinesGpu.onDidRender();
		}
		for (const part of this.viewParts) {
			if (part === this.viewLines || part === this.viewLinesGpu) continue;
			part.prepareRender(context);
		}
		for (const part of this.viewParts) {
			if (part === this.viewLines || part === this.viewLinesGpu) continue;
			part.render(context);
			part.onDidRender();
		}
		this.syncScrollPosition(layout);
		this.onDidRender();
	}

	private computeGlyphMarginLanes(): void {
		const glyphs: { readonly range: Range; readonly lane: GlyphMarginLane; readonly persist?: boolean }[] = [];
		let maxLineNumber = 0;
		for (const decoration of this.model.getAllMarginDecorations()) {
			const lane = decoration.options.glyphMargin?.position ?? GlyphMarginLane.Center;
			maxLineNumber = Math.max(maxLineNumber, decoration.range.endLineNumber);
			glyphs.push({ range: decoration.range, lane, persist: decoration.options.glyphMargin?.persistLane });
		}
		for (const widget of this.glyphMarginWidgets.getWidgets()) {
			const range = this.model.validateRange(widget.preference.range);
			maxLineNumber = Math.max(maxLineNumber, range.endLineNumber);
			glyphs.push({ range, lane: widget.preference.lane });
		}
		glyphs.sort((left, right) => Range.compareRangesUsingStarts(left.range, right.range));
		this.viewModel.glyphLanes.reset(maxLineNumber);
		for (const glyph of glyphs) this.viewModel.glyphLanes.push(glyph.lane, glyph.range, glyph.persist);
		this.editorConfiguration.setGlyphMarginDecorationLaneCount(this.viewModel.glyphLanes.requiredLanes);
	}

	private scheduleProjection(): void {
		if (this.projectionScheduled || this.isDisposed) return;
		this.projectionScheduled = true;
		queueMicrotask(() => {
			this.projectionScheduled = false;
			if (!this.isDisposed) this.project(this.viewport.layout);
		});
	}

	private observeRenderedLineWidths(layout: EditorViewportLayout): void {
		if (this.lineWidths.complete) return;
		const projection = this.visualProjection;
		const logicalLineIndexes = new Set<number>();
		for (let visualLineIndex = layout.renderLines.startLineIndex; visualLineIndex < layout.renderLines.endLineIndexExclusive; visualLineIndex += 1) {
			const visualLine = projection.lineAt(visualLineIndex);
			if (visualLine) logicalLineIndexes.add(visualLine.logicalLineIndex);
		}
		this.lineWidths.observeLines([...logicalLineIndexes]);
	}

	private updateAccessibilityStatus(): void {
		const selectionSet = this.viewModel.getCursorStates().map(state => state.modelState.selection);
		const selection = selectionSet[0]!;
		if (!selection) return;
		const position = selection.getPosition();
		const selectedLength = this.model.offsetAt(selection.getEndPosition()) - this.model.offsetAt(selection.getStartPosition());
		if (selectionSet.length > 1) {
			const totalSelectedLength = selectionSet.reduce((length, current) =>
				length + this.model.offsetAt(current.getEndPosition()) - this.model.offsetAt(current.getStartPosition()), 0);
			const summary = totalSelectedLength === 0
				? `${selectionSet.length} cursors`
				: `${selectionSet.length} selections, ${totalSelectedLength} characters selected`;
			this.announceAccessibilityStatus(`${summary}; primary at Line ${position.lineNumber}, column ${position.column}`);
			return;
		}
		this.announceAccessibilityStatus(selectedLength === 0
			? `Line ${position.lineNumber}, column ${position.column}`
			: `Line ${position.lineNumber}, column ${position.column}, ${selectedLength} characters selected`);
	}

	private createViewportData(): ViewportData {
		return new ViewportData(
			this.viewModel.getCursorStates().map(state => state.viewState.selection),
			this.viewport.getLinesViewportData(),
			this.viewport.getWhitespaceViewportData(),
			this.viewModel,
		);
	}

	private createRenderingContext(viewportData: ViewportData): RenderingContext {
		return new RenderingContext(this.viewport, viewportData, this.viewLines, this.viewLinesGpu);
	}

	private characterBoundsAt(modelOffset: number): EditContextCharacterBounds | undefined {
		if (!Number.isSafeInteger(modelOffset) || modelOffset < 0 || modelOffset >= this.model.length) return undefined;
		const position = this.model.positionAt(modelOffset);
		const next = this.model.positionAt(Math.min(this.model.length, modelOffset + 1));
		const start = this.getPositionContentCoordinates(position);
		const end = this.getPositionContentCoordinates(next);
		return Object.freeze({
			left: Math.min(start.left, end.left),
			top: start.top,
			width: position.lineNumber === next.lineNumber ? Math.max(1, Math.abs(end.left - start.left)) : Math.max(1, this.measureTextWidth(' ')),
			height: start.height,
		});
	}

	private get visualProjection(): EditorVisualLineProjection {
		return createVisualProjection(this.model, this.viewModel, this.fontInfo.spaceWidth);
	}

	private registerViewPart<T extends ViewPart>(part: T): T {
		this.viewParts.push(part);
		return this._register(part);
	}

	private syncScrollPosition(layout: EditorViewportLayout): void {
		if (this.domNode.domNode.scrollLeft !== layout.scrollPosition.left) {
			this.domNode.domNode.scrollLeft = layout.scrollPosition.left;
		}
		if (this.domNode.domNode.scrollTop !== layout.scrollPosition.top) {
			this.domNode.domNode.scrollTop = layout.scrollPosition.top;
		}
		this.syncedScrollLeft = this.domNode.domNode.scrollLeft;
		this.syncedScrollTop = this.domNode.domNode.scrollTop;
	}

	public override handleEvents(events: viewEvents.ViewEvent[]): void {
		super.handleEvents(events);
		if (this.changingLayout || this.isDisposed) return;
		if (!this.shouldRender() && !this.viewParts.some(part => part.shouldRender())) return;
		this.project(this.viewport.layout);
	}

	public override onConfigurationChanged(): boolean {
		this.domNode.domNode.classList.toggle(
			'hide-line-numbers',
			this.editorConfiguration.options.get(EditorOption.lineNumbers).renderType === RenderLineNumbersType.Off,
		);
		this.projectionRevision += 1;
		return true;
	}

	public override onThemeChanged(event: viewEvents.ViewThemeChangedEvent): boolean {
		this.viewContext.theme.update(event.theme);
		return false;
	}

	public override onCursorStateChanged(): boolean {
		this.updateAccessibilityStatus();
		return true;
	}

	public override onFocusChanged(): boolean {
		return true;
	}

	public override onFlushed(): boolean {
		this.projectionRevision += 1;
		return true;
	}

	public override onLineMappingChanged(): boolean {
		this.projectionRevision += 1;
		return true;
	}
}

function validateEditorViewportOptions(options: EditorViewportOptions): void {
	if (!(options.viewModel.model instanceof TextModel)) throw new TypeError('Editor view requires the editor text model implementation');
	if (!(options.viewModel.viewLayout instanceof ViewLayout)) throw new TypeError('Editor view requires the editor view layout implementation');
	resolveEditorIndentationOptions(options.indentation);
	const textDirection = options.textDirection ?? EditorTextDirection.Auto;
	if (!Object.values(EditorTextDirection).includes(textDirection)) throw new TypeError('Unknown Stanza editor text direction');
	const focusOutlineOwner = options.focusOutlineOwner ?? 'editor';
	if (focusOutlineOwner !== 'editor' && focusOutlineOwner !== 'host') throw new TypeError('Unknown Stanza editor focus outline owner');
	if (options.semanticTokenSource && options.semanticTokenSource.textModel !== options.viewModel.model) {
		throw new TypeError('Stanza viewport and semantic token source must share one text model');
	}
	if (options.bracketGuideSource && options.bracketGuideSource.textModel !== options.viewModel.model) {
		throw new TypeError('Stanza viewport and bracket guide source must share one text model');
	}
}

function createVisualProjection(model: TextModel, viewModel: IViewModel, spaceWidth: number): EditorVisualLineProjection {
	const lines = Array.from({ length: viewModel.getLineCount() }, (_, index) => {
		const lineNumber = index + 1;
		const data = viewModel.getViewLineData(lineNumber);
		const start = viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber, data.minColumn));
		const end = viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber, data.maxColumn));
		return {
			visualLineIndex: index,
			logicalLineIndex: start.lineNumber - 1,
			startColumn: start.column - 1,
			endColumn: end.column - 1,
			firstForLogicalLine: index === 0 || viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(index, viewModel.getLineMaxColumn(index))).lineNumber !== start.lineNumber,
			lastForLogicalLine: !data.continuesWithWrappedLine,
			...(data.minColumn > 1 ? { wrappedTextIndentWidth: (data.minColumn - 1) * spaceWidth } : {}),
		};
	});
	const anchors = Array.from({ length: model.lineCount }, (_, index) => viewModel.coordinatesConverter.getViewLineNumberOfModelPosition(index + 1, 1) - 1);
	return EditorVisualLineProjection.fromVisibleLines(model.version, model.lineCount, lines, anchors);
}

type EditorEditContextOptions = EditContextOptions & Partial<Pick<NativeEditContextOptions, 'logService'>>;

function createEditContext(context: ViewContext, container: HTMLElement, options: EditorEditContextOptions): AbstractEditContext {
	const ownerWindow = container.ownerDocument.defaultView;
	if (typeof ownerWindow?.EditContext !== 'function') return new TextAreaEditContext(context, container, options);
	const logService = options.logService;
	if (!logService) throw new ReferenceError('Native EditContext requires the editor log service');
	return new NativeEditContext(context, container, { ...options, logService });
}

function rawWrappingIndent(value: WrappingIndent): 'none' | 'same' | 'indent' | 'deepIndent' {
	switch (value) {
		case WrappingIndent.None: return 'none';
		case WrappingIndent.Same: return 'same';
		case WrappingIndent.Indent: return 'indent';
		case WrappingIndent.DeepIndent: return 'deepIndent';
	}
}

interface BrowserTextMetrics {
	readonly signature: string;
	readonly font: string;
	readonly fontSize: number;
	readonly letterSpacing: number;
	readonly spaceWidth: number;
	readonly tabSize: number;
	readonly horizontalPadding: number;
	readonly contentLeftPadding: number;
}

class BrowserTextMeasurer implements TextMeasurer {
	private readonly context: CanvasRenderingContext2D | undefined;
	private metrics: BrowserTextMetrics;

	constructor(private readonly referenceElement: HTMLElement) {
		try {
			this.context = h(referenceElement.ownerDocument, 'canvas').getContext('2d') ?? undefined;
		} catch {
			this.context = undefined;
		}
		this.metrics = this.readMetrics();
	}

	get horizontalPadding(): number { return this.metrics.horizontalPadding; }
	get contentLeftPadding(): number { return this.metrics.contentLeftPadding; }

	refresh(): boolean {
		const metrics = this.readMetrics();
		if (metrics.signature === this.metrics.signature) return false;
		this.metrics = metrics;
		return true;
	}

	measureLineWidth(text: string): number {
		const tabStopWidth = Math.max(1, this.metrics.spaceWidth * this.metrics.tabSize);
		let width = 0;
		const segments = text.split('\t');
		for (let index = 0; index < segments.length; index += 1) {
			width += this.measureSegment(segments[index]!);
			if (index + 1 < segments.length) width = (Math.floor(width / tabStopWidth) + 1) * tabStopWidth;
		}
		return width;
	}

	private readMetrics(): BrowserTextMetrics {
		const ownerWindow = this.referenceElement.ownerDocument.defaultView;
		if (!ownerWindow) throw new ReferenceError('Editor text measurement requires a browser window');
		const style = ownerWindow.getComputedStyle(this.referenceElement);
		const fontSize = cssNumber(style.fontSize, 14);
		const letterSpacing = style.letterSpacing === 'normal' ? 0 : cssNumber(style.letterSpacing, 0);
		const tabSize = Math.max(1, cssNumber(style.tabSize, 4));
		const contentLeftPadding = cssNumber(style.paddingLeft, 0);
		const horizontalPadding = contentLeftPadding + cssNumber(style.paddingRight, 0);
		const font = `${style.fontStyle || 'normal'} ${style.fontVariantCaps || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || `${fontSize}px`} ${style.fontFamily || 'monospace'}`;
		if (this.context) {
			this.context.font = font;
			this.context.textBaseline = 'alphabetic';
		}
		const spaceWidth = positiveNumber(this.context?.measureText(' ').width, fontSize * 0.6);
		return Object.freeze({
			signature: JSON.stringify([font, letterSpacing, style.fontFeatureSettings, style.fontVariationSettings, tabSize, horizontalPadding, spaceWidth]),
			font,
			fontSize,
			letterSpacing,
			spaceWidth,
			tabSize,
			horizontalPadding,
			contentLeftPadding,
		});
	}

	private measureSegment(text: string): number {
		if (!text) return 0;
		const characterCount = [...text].length;
		const width = this.context?.measureText(text).width ?? characterCount * this.metrics.fontSize * 0.6;
		return Math.max(0, width + characterCount * this.metrics.letterSpacing);
	}
}

function cssNumber(value: string, fallback: number): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function validateClientPoint(point: ClientPoint): void {
	if (
		!point ||
		!isFiniteNumber(point.clientX) ||
		!isFiniteNumber(point.clientY)
	) {
		throw new RangeError(
			"Stanza client point must contain finite coordinates",
		);
	}
}

function resolveEditorViewportPadding(padding: EditorViewportPadding | undefined): EditorViewportPadding {
	return Object.freeze({
		right: nonNegativePaddingValue(padding?.right ?? 12, "right"),
		left: nonNegativePaddingValue(padding?.left ?? 12, "left"),
	});
}

function nonNegativePaddingValue(value: number, side: keyof EditorViewportPadding): number {
	if (!isFiniteNumber(value) || value < 0) {
		throw new RangeError(`Stanza editor padding.${side} must be non-negative and finite`);
	}
	return value;
}
