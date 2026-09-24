import { type IPointerHandlerHelper } from './mouseHandler.js';
import { type CoordinatesRelativeToEditor, type EditorMouseEvent, type EditorPagePosition, type PageCoordinates } from '../editorDom.js';
import { type IMouseTarget, type IMouseTargetContentEmptyData, type IMouseTargetContentTextData, type IMouseTargetContentWidget, type IMouseTargetMargin, type IMouseTargetMarginData, type IMouseTargetOutsideEditor, type IMouseTargetOverlayWidget, type IMouseTargetScrollbar, type IMouseTargetTextarea, type IMouseTargetUnknown, type IMouseTargetViewZone, type IMouseTargetViewZoneData, MouseTargetType } from '../editorBrowser.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { GlyphMarginLane, TextDirection } from '../../common/model.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { type IViewCursorRenderData } from '../viewParts/viewCursors/viewCursor.js';
import { PartFingerprint, PartFingerprints } from '../view/viewPart.js';

export class PointerHandlerLastRenderData {
	constructor(
		public readonly lastViewCursorsRenderData: IViewCursorRenderData[],
		public readonly lastTextareaPosition: Position | null,
	) {}
}

/** Creates the public editor mouse-target variants without an intermediate target protocol. */
export class MouseTarget {
	public static createUnknown(element: HTMLElement | null, mouseColumn: number, position: Position | null): IMouseTargetUnknown {
		return { type: MouseTargetType.UNKNOWN, element, mouseColumn, position, range: position ? Range.fromPositions(position) : null };
	}

	public static createTextarea(element: HTMLElement | null, mouseColumn: number): IMouseTargetTextarea {
		return { type: MouseTargetType.TEXTAREA, element, mouseColumn, position: null, range: null };
	}

	public static createMargin(type: MouseTargetType.GUTTER_GLYPH_MARGIN | MouseTargetType.GUTTER_LINE_NUMBERS | MouseTargetType.GUTTER_LINE_DECORATIONS, element: HTMLElement | null, mouseColumn: number, position: Position, range: Range, detail: IMouseTargetMarginData): IMouseTargetMargin {
		return { type, element, mouseColumn, position, range, detail };
	}

	public static createViewZone(type: MouseTargetType.GUTTER_VIEW_ZONE | MouseTargetType.CONTENT_VIEW_ZONE, element: HTMLElement | null, mouseColumn: number, position: Position, detail: IMouseTargetViewZoneData): IMouseTargetViewZone {
		return { type, element, mouseColumn, position, range: Range.fromPositions(position), detail };
	}

	public static createContentText(element: HTMLElement | null, mouseColumn: number, position: Position, range: Range | null, detail: IMouseTargetContentTextData): IMouseTarget {
		return { type: MouseTargetType.CONTENT_TEXT, element, mouseColumn, position, range: range ?? Range.fromPositions(position), detail };
	}

	public static createContentEmpty(element: HTMLElement | null, mouseColumn: number, position: Position, detail: IMouseTargetContentEmptyData): IMouseTarget {
		return { type: MouseTargetType.CONTENT_EMPTY, element, mouseColumn, position, range: Range.fromPositions(position), detail };
	}

	public static createContentWidget(element: HTMLElement | null, mouseColumn: number, detail: string): IMouseTargetContentWidget {
		return { type: MouseTargetType.CONTENT_WIDGET, element, mouseColumn, position: null, range: null, detail };
	}

	public static createScrollbar(element: HTMLElement | null, mouseColumn: number, position: Position): IMouseTargetScrollbar {
		return { type: MouseTargetType.SCROLLBAR, element, mouseColumn, position, range: Range.fromPositions(position) };
	}

	public static createOverlayWidget(element: HTMLElement | null, mouseColumn: number, detail: string): IMouseTargetOverlayWidget {
		return { type: MouseTargetType.OVERLAY_WIDGET, element, mouseColumn, position: null, range: null, detail };
	}

	public static createOutsideEditor(mouseColumn: number, position: Position, outsidePosition: 'above' | 'below' | 'left' | 'right', outsideDistance: number): IMouseTargetOutsideEditor {
		return { type: MouseTargetType.OUTSIDE_EDITOR, element: null, mouseColumn, position, range: Range.fromPositions(position), outsidePosition, outsideDistance };
	}

	public static toString(target: IMouseTarget): string {
		return `${mouseTargetTypeName(target.type)}: ${target.position?.toString() ?? 'null'} - ${target.range?.toString() ?? 'null'}`;
	}
}

function mouseTargetTypeName(type: MouseTargetType): string {
	switch (type) {
		case MouseTargetType.TEXTAREA: return 'TEXTAREA';
		case MouseTargetType.GUTTER_GLYPH_MARGIN: return 'GUTTER_GLYPH_MARGIN';
		case MouseTargetType.GUTTER_LINE_NUMBERS: return 'GUTTER_LINE_NUMBERS';
		case MouseTargetType.GUTTER_LINE_DECORATIONS: return 'GUTTER_LINE_DECORATIONS';
		case MouseTargetType.GUTTER_VIEW_ZONE: return 'GUTTER_VIEW_ZONE';
		case MouseTargetType.CONTENT_TEXT: return 'CONTENT_TEXT';
		case MouseTargetType.CONTENT_EMPTY: return 'CONTENT_EMPTY';
		case MouseTargetType.CONTENT_VIEW_ZONE: return 'CONTENT_VIEW_ZONE';
		case MouseTargetType.CONTENT_WIDGET: return 'CONTENT_WIDGET';
		case MouseTargetType.OVERVIEW_RULER: return 'OVERVIEW_RULER';
		case MouseTargetType.SCROLLBAR: return 'SCROLLBAR';
		case MouseTargetType.OVERLAY_WIDGET: return 'OVERLAY_WIDGET';
		case MouseTargetType.OUTSIDE_EDITOR: return 'OUTSIDE_EDITOR';
		default: return 'UNKNOWN';
	}
}

/** Resolves one editor-relative coordinate operation directly into the public target contract. */
export class MouseTargetFactory {
	constructor(
		private readonly context: ViewContext,
		private readonly viewHelper: IPointerHandlerHelper,
	) {}

	public mouseTargetIsWidget(event: EditorMouseEvent): boolean {
		const element = eventTargetElement(event.target, this.viewHelper.viewDomNode.ownerDocument);
		const kind = classifyElement(element, this.viewHelper.viewDomNode)?.kind;
		return kind === ElementTargetKind.ContentWidget || kind === ElementTargetKind.OverlayWidget;
	}

	public createMouseTarget(
		_lastRenderData: PointerHandlerLastRenderData,
		_editorPos: EditorPagePosition,
		_pos: PageCoordinates,
		relativePos: CoordinatesRelativeToEditor,
		target: HTMLElement | null,
	): IMouseTarget {
		const mouseColumn = this.getMouseColumn(relativePos);
		const elementTarget = classifyElement(target, this.viewHelper.viewDomNode);
		const domPosition = target ? this.viewHelper.getPositionFromDOMInfo(target, 0) : null;
		const position = domPosition ?? this.positionAt(relativePos);
		if (elementTarget?.kind === ElementTargetKind.Textarea) return MouseTarget.createTextarea(target, mouseColumn);
		if (elementTarget?.kind === ElementTargetKind.ContentWidget) return MouseTarget.createContentWidget(target, mouseColumn, elementTarget.widgetId ?? '');
		if (elementTarget?.kind === ElementTargetKind.OverlayWidget) return MouseTarget.createOverlayWidget(target, mouseColumn, elementTarget.widgetId ?? '');
		if (!position) return MouseTarget.createUnknown(target, mouseColumn, null);
		if (elementTarget?.kind === ElementTargetKind.Scrollbar) return MouseTarget.createScrollbar(target, mouseColumn, position);
		if (elementTarget?.kind === ElementTargetKind.OverviewRuler) {
			return { type: MouseTargetType.OVERVIEW_RULER, element: target, mouseColumn, position, range: Range.fromPositions(position) };
		}
		const zone = this.viewZoneData(relativePos, elementTarget?.viewZoneId);
		if (elementTarget?.kind === ElementTargetKind.ViewZone || zone) {
			const detail = zone ?? this.fallbackViewZoneData(position, elementTarget?.viewZoneId ?? '');
			const contentLeft = this.context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
			return MouseTarget.createViewZone(
				relativePos.x < contentLeft ? MouseTargetType.GUTTER_VIEW_ZONE : MouseTargetType.CONTENT_VIEW_ZONE,
				target,
				mouseColumn,
				detail.position,
				detail,
			);
		}
		if (domPosition && target && this.viewHelper.viewLinesDomNode.contains(target)) {
			const injectedText = this.context.viewModel.getInjectedTextAt(domPosition);
			return MouseTarget.createContentText(target, domPosition.column, domPosition, null, { mightBeForeignElement: !!injectedText, injectedText });
		}
		if (elementTarget?.kind === ElementTargetKind.LineNumbers || elementTarget?.kind === ElementTargetKind.LineDecorations || elementTarget?.kind === ElementTargetKind.GlyphMargin) {
			return MouseTarget.createMargin(
				elementTarget.kind === ElementTargetKind.LineNumbers
					? MouseTargetType.GUTTER_LINE_NUMBERS
					: elementTarget.kind === ElementTargetKind.GlyphMargin ? MouseTargetType.GUTTER_GLYPH_MARGIN : MouseTargetType.GUTTER_LINE_DECORATIONS,
				target,
				mouseColumn,
				position,
				Range.fromPositions(position),
				this.marginData(relativePos, elementTarget.glyphMarginLane),
			);
		}
		const layout = this.context.configuration.options.get(EditorOption.layoutInfo);
		if (relativePos.x < layout.contentLeft) {
			return MouseTarget.createMargin(MouseTargetType.GUTTER_LINE_DECORATIONS, target, mouseColumn, position, Range.fromPositions(position), this.marginData(relativePos));
		}
		const injectedText = this.context.viewModel.getInjectedTextAt(position);
		const lineWidth = this.viewHelper.getLineWidth(position.lineNumber);
		const horizontalOffset = this.context.viewLayout.getCurrentScrollLeft() + relativePos.x - layout.contentLeft;
		if (this.context.viewLayout.isAfterLines(this.context.viewLayout.getCurrentScrollTop() + relativePos.y)) {
			const lineNumber = this.context.viewModel.getLineCount();
			const afterLinesPosition = new Position(lineNumber, this.context.viewModel.getLineMaxColumn(lineNumber));
			return MouseTarget.createContentEmpty(target, mouseColumn, afterLinesPosition, { isAfterLines: true });
		}
		if (horizontalOffset > lineWidth) {
			const emptyPosition = new Position(position.lineNumber, this.context.viewModel.getLineMaxColumn(position.lineNumber));
			return MouseTarget.createContentEmpty(target, mouseColumn, emptyPosition, { isAfterLines: false, horizontalDistanceToText: horizontalOffset - lineWidth });
		}
		return MouseTarget.createContentText(target, mouseColumn, position, null, { mightBeForeignElement: !!injectedText, injectedText });
	}

	public getMouseColumn(relativePos: CoordinatesRelativeToEditor): number {
		const options = this.context.configuration.options;
		const layout = options.get(EditorOption.layoutInfo);
		const horizontalOffset = this.context.viewLayout.getCurrentScrollLeft() + relativePos.x - layout.contentLeft;
		return MouseTargetFactory._getMouseColumn(horizontalOffset, options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth);
	}

	public static _getMouseColumn(mouseContentHorizontalOffset: number, typicalHalfwidthCharacterWidth: number): number {
		if (mouseContentHorizontalOffset < 0) return 1;
		return Math.round(mouseContentHorizontalOffset / Math.max(1, typicalHalfwidthCharacterWidth)) + 1;
	}

	private positionAt(relativePos: CoordinatesRelativeToEditor): Position | null {
		const viewModel = this.context.viewModel;
		const layout = this.context.viewLayout;
		if (viewModel.getLineCount() === 0) return null;
		const verticalOffset = layout.getCurrentScrollTop() + relativePos.y;
		const lineNumber = Math.min(viewModel.getLineCount(), Math.max(1, layout.getLineNumberAtVerticalOffset(Math.max(0, verticalOffset))));
		const maxColumn = viewModel.getLineMaxColumn(lineNumber);
		const contentLeft = this.context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
		if (relativePos.x < contentLeft) return new Position(lineNumber, 1);
		const expectedLeft = layout.getCurrentScrollLeft() + relativePos.x - contentLeft;
		const nearestColumn = this.nearestRenderedColumn(lineNumber, maxColumn, expectedLeft)
			?? Math.min(maxColumn, this.getMouseColumn(relativePos));
		return new Position(lineNumber, nearestColumn);
	}

	private nearestRenderedColumn(lineNumber: number, maxColumn: number, expectedLeft: number): number | undefined {
		const direction = this.context.viewModel.getTextDirection(lineNumber) === TextDirection.RTL ? -1 : 1;
		let low = 1;
		let high = maxColumn;
		let nearestColumn: number | undefined;
		let nearestDistance = Number.POSITIVE_INFINITY;
		while (low <= high) {
			const column = Math.floor((low + high) / 2);
			const visible = this.viewHelper.visibleRangeForPosition(lineNumber, column);
			if (!visible) return undefined;
			const delta = visible.left - expectedLeft;
			const distance = Math.abs(delta);
			if (distance < nearestDistance) {
				nearestColumn = column;
				nearestDistance = distance;
			}
			if (distance < 1) break;
			if (delta * direction < 0) low = column + 1;
			else high = column - 1;
		}
		if (nearestColumn === undefined) return undefined;
		for (const column of [nearestColumn - 1, nearestColumn + 1]) {
			if (column < 1 || column > maxColumn) continue;
			const visible = this.viewHelper.visibleRangeForPosition(lineNumber, column);
			if (!visible) continue;
			const distance = Math.abs(visible.left - expectedLeft);
			if (distance < nearestDistance) {
				nearestColumn = column;
				nearestDistance = distance;
			}
		}
		return nearestColumn;
	}

	private viewZoneData(relativePos: CoordinatesRelativeToEditor, expectedId: string | undefined): IMouseTargetViewZoneData | undefined {
		const verticalOffset = this.context.viewLayout.getCurrentScrollTop() + relativePos.y;
		const whitespace = this.context.viewLayout.getWhitespaceAtVerticalOffset(verticalOffset)
			?? (expectedId ? this.context.viewLayout.getWhitespaceViewportData().find(candidate => candidate.id === expectedId) : undefined);
		if (!whitespace) return undefined;
		const lineCount = this.context.viewModel.getLineCount();
		const afterLineNumber = Math.min(lineCount, Math.max(0, whitespace.afterLineNumber));
		const positionBefore = afterLineNumber === 0 ? null : new Position(afterLineNumber, this.context.viewModel.getLineMaxColumn(afterLineNumber));
		const positionAfter = afterLineNumber >= lineCount ? null : new Position(afterLineNumber + 1, 1);
		const position = positionBefore ?? positionAfter ?? new Position(1, 1);
		return { viewZoneId: whitespace.id, positionBefore, positionAfter, position, afterLineNumber };
	}

	private fallbackViewZoneData(position: Position, viewZoneId: string): IMouseTargetViewZoneData {
		return { viewZoneId, positionBefore: position, positionAfter: position, position, afterLineNumber: position.lineNumber };
	}

	private marginData(relativePos: CoordinatesRelativeToEditor, glyphMarginLane?: GlyphMarginLane): IMouseTargetMarginData {
		const layout = this.context.configuration.options.get(EditorOption.layoutInfo);
		return {
			isAfterLines: this.context.viewLayout.isAfterLines(this.context.viewLayout.getCurrentScrollTop() + relativePos.y),
			glyphMarginLeft: layout.glyphMarginLeft,
			glyphMarginWidth: layout.glyphMarginWidth,
			...(glyphMarginLane === undefined ? {} : { glyphMarginLane }),
			lineNumbersWidth: layout.lineNumbersWidth,
			offsetX: relativePos.x,
		};
	}
}

function eventTargetElement(target: EventTarget | null, ownerDocument: Document): Element | undefined {
	const ElementConstructor = ownerDocument.defaultView?.Element;
	return ElementConstructor && target instanceof ElementConstructor ? target : undefined;
}

const enum ElementTargetKind {
	Textarea,
	LineNumbers,
	LineDecorations,
	GlyphMargin,
	ContentWidget,
	OverlayWidget,
	Scrollbar,
	ViewZone,
	OverviewRuler,
}

interface ElementMouseTarget {
	readonly kind: ElementTargetKind;
	readonly glyphMarginLane?: GlyphMarginLane;
	readonly viewZoneId?: string;
	readonly widgetId?: string;
}

function classifyElement(element: Element | null | undefined, editorDomNode: HTMLElement): ElementMouseTarget | undefined {
	if (!element) return undefined;
	const fingerprints = PartFingerprints.collect(element, editorDomNode);
	if (fingerprints.includes(PartFingerprint.TextArea)) return { kind: ElementTargetKind.Textarea };
	if (element.closest('.stanza-editor-scrollbar-track, .ash-scrollbar-track, [role="scrollbar"]')) {
		return { kind: ElementTargetKind.Scrollbar };
	}
	if (element.closest('.decorationsOverviewRuler, .overviewRuler')) return { kind: ElementTargetKind.OverviewRuler };
	const viewZone = element.closest<HTMLElement>('[data-view-zone-id]');
	if (viewZone) return { kind: ElementTargetKind.ViewZone, viewZoneId: viewZone.dataset.viewZoneId };
	if (element.closest('.stanza-editor-view-zones, .stanza-editor-margin-view-zones')) return { kind: ElementTargetKind.ViewZone };
	const widget = element.closest<HTMLElement>('[widgetId], .stanza-editor-widget, .stanza-editor-content-widget, .stanza-editor-overlay-widget');
	if (widget) return { kind: widget.closest('.stanza-editor-overlay-widget') ? ElementTargetKind.OverlayWidget : ElementTargetKind.ContentWidget, widgetId: widget.getAttribute('widgetId') ?? widget.id };
	if (
		fingerprints.includes(PartFingerprint.ContentWidgets)
		|| fingerprints.includes(PartFingerprint.OverflowingContentWidgets)
	) {
		const widgetHost = closestWidgetHost(element, editorDomNode);
		return { kind: ElementTargetKind.ContentWidget, ...(widgetHost ? { widgetId: widgetHost.getAttribute('widgetId') ?? widgetHost.id } : {}) };
	}
	if (fingerprints.includes(PartFingerprint.OverlayWidgets) || fingerprints.includes(PartFingerprint.OverflowingOverlayWidgets)) {
		const widgetHost = closestWidgetHost(element, editorDomNode);
		return { kind: ElementTargetKind.OverlayWidget, ...(widgetHost ? { widgetId: widgetHost.getAttribute('widgetId') ?? widgetHost.id } : {}) };
	}
	if (element.closest('.line-numbers')) return { kind: ElementTargetKind.LineNumbers };
	const lineDecoration = element.closest<HTMLElement>('.stanza-editor-line-decoration');
	if (lineDecoration) {
		return { kind: ElementTargetKind.LineDecorations };
	}
	const glyph = element.closest<HTMLElement>('.stanza-editor-glyph-margin-decoration');
	const lane = element.closest<HTMLElement>('.stanza-editor-glyph-margin-lane');
	if (glyph || lane) {
		const glyphMarginLane = readGlyphMarginLane(lane?.dataset.glyphMarginLane);
		return {
			kind: ElementTargetKind.GlyphMargin,
			...(glyphMarginLane === undefined ? {} : { glyphMarginLane }),
		};
	}
	return undefined;
}

function closestWidgetHost(element: Element, editorDomNode: HTMLElement): HTMLElement | undefined {
	let candidate: Element | null = element;
	while (candidate && candidate !== editorDomNode) {
		if (candidate.hasAttribute('widgetId')) return candidate as HTMLElement;
		candidate = candidate.parentElement;
	}
	return undefined;
}

function readGlyphMarginLane(value: string | undefined): GlyphMarginLane | undefined {
	const lane = Number(value);
	return lane === GlyphMarginLane.Left || lane === GlyphMarginLane.Center || lane === GlyphMarginLane.Right ? lane : undefined;
}
