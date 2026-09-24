import './zoneWidget.css';
import { h } from '../../../../base/browser/dom.js';
import { Sash, SashState, type SashDragEvent } from '../../../../base/browser/ui/sash/sash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Color } from '../../../../base/common/color.js';
import { type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition, type IViewZone } from '../../../browser/editorBrowser.js';
import { EditorOption, type EditorLayoutInfo } from '../../../common/config/editorOptions.js';
import { type Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type IEditorDecorationsCollection, ScrollType } from '../../../common/editorCommon.js';

export interface IOptions {
	showFrame?: boolean;
	showArrow?: boolean;
	frameWidth?: number;
	className?: string;
	isAccessible?: boolean;
	isResizeable?: boolean;
	frameColor?: Color | string;
	arrowColor?: Color;
	keepEditorSelection?: boolean;
	ordinal?: number;
	showInHiddenAreas?: boolean;
}

export interface IStyles {
	frameColor?: Color | string | null;
	arrowColor?: Color | null;
}

interface ResolvedOptions {
	readonly showFrame: boolean;
	readonly showArrow: boolean;
	readonly frameWidth: number | undefined;
	readonly className: string;
	readonly isAccessible: boolean;
	readonly isResizeable: boolean;
	readonly keepEditorSelection: boolean;
	readonly ordinal: number | undefined;
	readonly showInHiddenAreas: boolean;
}

export class OverlayWidgetDelegate implements IOverlayWidget {
	constructor(private readonly _id: string, private readonly _domNode: HTMLElement) {}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return null;
	}
}

/** Anchors an interactive widget in reserved editor space after a text position. */
export abstract class ZoneWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	public container: HTMLDivElement | null = null;
	public readonly editor: ICodeEditor;
	public readonly options: ResolvedOptions;

	private readonly anchor: IEditorDecorationsCollection;
	private viewZoneId: string | undefined;
	private arrowDomNode: HTMLDivElement | undefined;
	private resizeSash: Sash | undefined;
	private frameColor: string | undefined;
	private arrowColor: string | undefined;
	private heightInLines = 0;
	private resizeStartHeightInLines: number | undefined;
	private created = false;
	private layingOut = false;

	protected _viewZone: IViewZone | null = null;
	protected _isShowing = false;

	constructor(editor: ICodeEditor, options: IOptions = {}) {
		super();
		this.editor = editor;
		this.options = readOptions(options);
		this.frameColor = options.frameColor?.toString();
		this.arrowColor = options.arrowColor?.toString();
		this.anchor = editor.createDecorationsCollection();
		this.domNode = h(editor.getContainerDomNode().ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-zone-widget';
		this.domNode.hidden = true;
		if (!this.options.isAccessible) {
			this.domNode.setAttribute('aria-hidden', 'true');
			this.domNode.setAttribute('role', 'presentation');
		}
		this._register(editor.onDidLayoutChange(() => this.layoutZone()));
		const model = editor.getModel();
		if (model) this._register(model.onDidChangeContent(() => this.layoutZone()));
	}

	public get position(): Position | undefined {
		return this.anchor.getRange(0)?.getStartPosition();
	}

	public create(): void {
		this.assertNotDisposed();
		if (this.created) throw new Error('Zone widget has already been created');
		this.created = true;
		for (const className of this.options.className.split(/\s+/u).filter(Boolean)) this.domNode.classList.add(className);
		this.domNode.classList.toggle('show-frame', this.options.showFrame);
		this.domNode.classList.toggle('show-arrow', this.options.showArrow);

		if (this.options.showArrow) {
			this.arrowDomNode = h(this.domNode.ownerDocument, 'div');
			this.arrowDomNode.className = 'stanza-editor-zone-widget-arrow';
			this.arrowDomNode.setAttribute('aria-hidden', 'true');
			this.domNode.append(this.arrowDomNode);
		}

		this.container = h(this.domNode.ownerDocument, 'div');
		this.container.className = 'stanza-editor-zone-widget-container';
		this.domNode.append(this.container);
		this._fillContainer(this.container);
		this._initSash();
		this._applyStyles();
	}

	public style(styles: IStyles): void {
		this.assertNotDisposed();
		if (styles.frameColor !== undefined) this.frameColor = styles.frameColor?.toString();
		if (styles.arrowColor !== undefined) this.arrowColor = styles.arrowColor?.toString();
		this._applyStyles();
	}

	public show(rangeOrPosition: Range | Position, heightInLines: number): void {
		this.assertNotDisposed();
		this.assertCreated();
		const range = normalizeRange(rangeOrPosition);
		validateHeightInLines(heightInLines);
		const model = this.editor.getModel();
		if (!model) throw new Error('Zone widget requires an editor model');
		model.validateRange(range);
		this.hide();
		this._isShowing = true;
		this.heightInLines = this.limitHeightInLines(heightInLines);
		this.anchor.set([{ range, options: { description: 'zone-widget-position', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
		const viewZone: IViewZone = {
			afterLineNumber: range.startLineNumber,
			afterColumn: range.startColumn,
			heightInPx: this.heightInPixels,
			ordinal: this.options.ordinal,
			showInHiddenAreas: this.options.showInHiddenAreas,
			domNode: this.domNode,
		};
		this._viewZone = viewZone;
		this.domNode.hidden = false;
		try {
			this.editor.changeViewZones(accessor => {
				this.viewZoneId = accessor.addZone(viewZone);
			});
		} catch (error) {
			this.viewZoneId = undefined;
			this._viewZone = null;
			this._isShowing = false;
			this.anchor.clear();
			this.domNode.hidden = true;
			throw error;
		}
		this.layoutZone();
		this._isShowing = false;
		if (!this.options.keepEditorSelection) this.editor.setSelection(Selection.fromPositions(range.getStartPosition(), range.getEndPosition()));
		this.revealRange(range, range.endLineNumber === model.getLineCount());
	}

	public updatePositionAndHeight(rangeOrPosition: Range | Position, heightInLines = this.heightInLines): void {
		this.assertNotDisposed();
		if (!this._viewZone) return;
		const range = normalizeRange(rangeOrPosition);
		validateHeightInLines(heightInLines);
		const model = this.editor.getModel();
		if (!model) throw new Error('Zone widget requires an editor model');
		model.validateRange(range);
		this.anchor.set([{ range, options: { description: 'zone-widget-position', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
		this.heightInLines = this.limitHeightInLines(heightInLines);
		this.layoutZone();
	}

	public hide(): void {
		this.assertNotDisposed();
		if (this.viewZoneId !== undefined) {
			const id = this.viewZoneId;
			this.editor.changeViewZones(accessor => accessor.removeZone(id));
		}
		this.viewZoneId = undefined;
		this._viewZone = null;
		this._isShowing = false;
		this.anchor.clear();
		this.domNode.hidden = true;
		this.heightInLines = 0;
		this.resizeStartHeightInLines = undefined;
		this.updateSashState();
	}

	override dispose(): void {
		if (!this.isDisposed) this.hide();
		super.dispose();
	}

	public hasFocus(): boolean {
		return this.domNode.contains(this.domNode.ownerDocument.activeElement);
	}

	protected setCssClass(className: string, classToReplace?: string): void {
		if (!this.container) return;
		if (classToReplace) this.container.classList.remove(classToReplace);
		this.container.classList.add(className);
	}

	protected _getMaximumHeightInLines(): number {
		return Math.max(12, this.editor.getLayoutInfo().height / this.editor.getOption(EditorOption.lineHeight) * 0.8);
	}

	protected _getResizeBounds(): { readonly minLines: number; readonly maxLines: number } {
		return { minLines: 5, maxLines: 35 };
	}

	protected _relayout(heightInLines: number, useMaximum = false): void {
		validateHeightInLines(heightInLines);
		if (!this._viewZone) return;
		this.heightInLines = useMaximum ? this.limitHeightInLines(heightInLines) : heightInLines;
		this.layoutZone();
	}

	protected _onWidth(_widthInPixels: number): void {}

	protected abstract _fillContainer(container: HTMLElement): void;
	protected abstract _doLayout(heightInPixels: number, widthInPixels: number): void;

	protected get _usesResizeHeight(): boolean {
		return this.resizeStartHeightInLines !== undefined;
	}

	getHorizontalSashLeft(): number {
		return 0;
	}

	getHorizontalSashTop(): number {
		return Math.max(0, this.heightInPixels - this._decoratingElementsHeight() / 2);
	}

	getHorizontalSashWidth(): number {
		return this._getWidth(this.editor.getLayoutInfo());
	}

	protected _decoratingElementsHeight(): number {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const arrowHeight = this.options.showArrow ? Math.round(lineHeight / 3) : 0;
		const frameWidth = this.options.showFrame ? this.options.frameWidth ?? Math.round(lineHeight / 9) : 0;
		return 2 * arrowHeight + 2 * frameWidth;
	}

	protected _getWidth(info: EditorLayoutInfo): number {
		return info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth;
	}

	protected revealRange(range: Range, _isLastLine: boolean): void {
		this.editor.revealRange(range, ScrollType.Smooth);
	}

	private get heightInPixels(): number {
		return this.heightInLines * this.editor.getOption(EditorOption.lineHeight);
	}

	private limitHeightInLines(heightInLines: number): number {
		return Math.min(heightInLines, this._getMaximumHeightInLines());
	}

	private assertCreated(): void {
		if (!this.created) throw new Error('Zone widget must be created before it is shown');
	}

	private layoutZone(): void {
		if (!this._viewZone || !this.viewZoneId || this.layingOut) return;
		this.layingOut = true;
		try {
			const anchor = this.anchor.getRange(0)!.getStartPosition();
			const nextAfterLineNumber = anchor.lineNumber;
			const nextHeightInPixels = this.heightInPixels;
			const needsZoneLayout = this._viewZone.afterLineNumber !== nextAfterLineNumber || this._viewZone.afterColumn !== anchor.column || this._viewZone.heightInPx !== nextHeightInPixels;
			this._viewZone.afterLineNumber = nextAfterLineNumber;
			this._viewZone.afterColumn = anchor.column;
			this._viewZone.heightInPx = nextHeightInPixels;
			if (needsZoneLayout) {
				const id = this.viewZoneId;
				this.editor.changeViewZones(accessor => accessor.layoutZone(id));
			}
			this.layoutDom(nextHeightInPixels);
			this.updateSashState();
		} finally {
			this.layingOut = false;
		}
	}

	private layoutDom(heightInPixels: number): void {
		const layout = this.editor.getLayoutInfo();
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const widthInPixels = this._getWidth(layout);
		const arrowHeight = this.options.showArrow ? Math.round(lineHeight / 3) : 0;
		const frameWidth = this.options.showFrame ? this.options.frameWidth ?? Math.round(lineHeight / 9) : 0;
		const containerHeight = Math.max(0, heightInPixels - 2 * arrowHeight - 2 * frameWidth);
		this.domNode.style.left = `${layout.minimap.minimapWidth > 0 && layout.minimap.minimapLeft === 0 ? layout.minimap.minimapWidth : 0}px`;
		this.domNode.style.width = `${widthInPixels}px`;
		this.arrowDomNode?.style.setProperty('--stanza-zone-widget-arrow-size', `${arrowHeight}px`);
		if (this.arrowDomNode) {
			const anchor = this.anchor.getRange(0)!.getStartPosition();
			const coordinates = this.editor.getScrolledVisiblePosition(anchor);
			const relativeLeft = Math.min(Math.max(arrowHeight, coordinates?.left ?? arrowHeight), Math.max(arrowHeight, widthInPixels - arrowHeight));
			this.arrowDomNode.style.left = `${relativeLeft}px`;
		}
		if (this.container) {
			this.container.style.top = `${arrowHeight}px`;
			this.container.style.height = `${containerHeight}px`;
			this.container.style.borderTopWidth = `${frameWidth}px`;
			this.container.style.borderBottomWidth = `${frameWidth}px`;
		}
		if (this.resizeSash) {
			this.resizeSash.element.style.top = `${Math.max(0, heightInPixels - frameWidth)}px`;
			this.resizeSash.element.style.right = '0';
			this.resizeSash.element.style.left = '0';
		}
		this._onWidth(widthInPixels);
		this._doLayout(containerHeight, widthInPixels);
	}

	protected _applyStyles(): void {
		setOptionalCustomProperty(this.domNode, '--stanza-zone-widget-frame-color', this.frameColor);
		setOptionalCustomProperty(this.domNode, '--stanza-zone-widget-arrow-color', this.arrowColor);
	}

	private _initSash(): void {
		const sash = this._register(new Sash(this.domNode, 'horizontal'));
		this.resizeSash = sash;
		this._register(sash.onDidStart(() => {
			this.resizeStartHeightInLines = this.heightInLines;
		}));
		this._register(sash.onDidChange(event => this.handleSashChange(event)));
		this._register(sash.onDidEnd(() => {
			this.resizeStartHeightInLines = undefined;
		}));
		this.updateSashState();
	}

	private handleSashChange(event: SashDragEvent): void {
		if (!this.options.isResizeable || this.resizeStartHeightInLines === undefined || !this._viewZone) return;
		const lineDelta = Math.trunc(event.delta / this.editor.getOption(EditorOption.lineHeight));
		const { minLines, maxLines } = this._getResizeBounds();
		const heightInLines = Math.min(maxLines, Math.max(minLines, this.resizeStartHeightInLines + lineDelta));
		if (heightInLines !== this.heightInLines) this._relayout(heightInLines);
	}

	private updateSashState(): void {
		if (!this.resizeSash) return;
		const isEnabled = this.options.isResizeable && this._viewZone !== null;
		this.resizeSash.element.hidden = !isEnabled;
		if (!isEnabled) {
			this.resizeSash.state = SashState.Disabled;
			return;
		}
		const { minLines, maxLines } = this._getResizeBounds();
		if (minLines >= maxLines) this.resizeSash.state = SashState.Disabled;
		else if (this.heightInLines <= minLines) this.resizeSash.state = SashState.AtMinimum;
		else if (this.heightInLines >= maxLines) this.resizeSash.state = SashState.AtMaximum;
		else this.resizeSash.state = SashState.Enabled;
	}
}

function readOptions(options: IOptions): ResolvedOptions {
	if (!options || typeof options !== 'object') throw new TypeError('Zone widget options must be an object');
	if (options.frameWidth !== undefined && (!Number.isFinite(options.frameWidth) || options.frameWidth < 0)) throw new RangeError('Zone widget frame width must be finite and non-negative');
	if (options.ordinal !== undefined && !Number.isFinite(options.ordinal)) throw new RangeError('Zone widget ordinal must be finite');
	if (options.className !== undefined && typeof options.className !== 'string') throw new TypeError('Zone widget class name must be a string');
	if (options.frameColor !== undefined && typeof options.frameColor !== 'string' && !(options.frameColor instanceof Color)) throw new TypeError('Zone widget frame color must be a color or string');
	if (options.arrowColor !== undefined && !(options.arrowColor instanceof Color)) throw new TypeError('Zone widget arrow color must be a color');
	return Object.freeze({
		showFrame: options.showFrame ?? true,
		showArrow: options.showArrow ?? true,
		frameWidth: options.frameWidth,
		className: options.className ?? '',
		isAccessible: options.isAccessible ?? false,
		isResizeable: options.isResizeable ?? false,
		keepEditorSelection: options.keepEditorSelection ?? false,
		ordinal: options.ordinal,
		showInHiddenAreas: options.showInHiddenAreas ?? false,
	});
}

function normalizeRange(rangeOrPosition: Range | Position): Range {
	return Range.isIRange(rangeOrPosition) ? Range.fromPositions(rangeOrPosition.getStartPosition(), rangeOrPosition.getEndPosition()) : Range.fromPositions(rangeOrPosition);
}

function validateHeightInLines(heightInLines: number): void {
	if (!Number.isFinite(heightInLines) || heightInLines <= 0) throw new RangeError('Zone widget height must be finite and positive');
}

function setOptionalCustomProperty(element: HTMLElement, name: string, value: string | undefined): void {
	if (value === undefined) element.style.removeProperty(name);
	else element.style.setProperty(name, value);
}
