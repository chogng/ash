import { h } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { TokenizationRegistry } from '../../../common/languages.js';
import { OverviewRulerLane } from '../../../common/model.js';
import { OverviewRulerDecorationsGroup } from '../../../common/viewModel.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { ColorId } from '../../../../platform/theme/common/colorTheme.js';

const MINIMUM_DECORATION_HEIGHT = 6;

interface CursorMarker {
	readonly position: Position;
	readonly color: string | null;
}

const enum RenderState {
	Clean,
	Maybe,
	Needed,
}

/** Draws model-owned overview-ruler decorations in their configured lanes. */
export class DecorationsOverviewRuler extends ViewPart {
	private readonly domNode: FastDomNode<HTMLCanvasElement>;
	private readonly tokensColorTrackerListener: IDisposable;
	private settings: OverviewRulerSettings;
	private cursorPositions: CursorMarker[];
	private preparedDecorations: OverviewRulerDecorationsGroup[] = [];
	private renderedDecorations: OverviewRulerDecorationsGroup[] = [];
	private renderedCursorPositions: CursorMarker[] = [];
	private renderState = RenderState.Needed;

	constructor(context: ViewContext) {
		super(context);
		this.domNode = createFastDomNode(h(document, 'canvas'));
		this.domNode.setClassName('decorationsOverviewRuler');
		this.domNode.setPosition('absolute');
		this.domNode.setLayerHinting(true);
		this.domNode.setContain('strict');
		this.domNode.setAttribute('aria-hidden', 'true');
		this.settings = new OverviewRulerSettings(context);
		this.applySettings();
		this.cursorPositions = [{ position: new Position(1, 1), color: this.settings.cursorColorSingle }];
		this.tokensColorTrackerListener = TokenizationRegistry.onDidChange(event => {
			if (!event.changedColorMap || !this.updateSettings()) return;
			this.preparedDecorations = this._context.viewModel.getAllOverviewRulerDecorations(this._context.theme);
			this.paint();
		});
	}

	public override dispose(): void {
		this.tokensColorTrackerListener.dispose();
		super.dispose();
	}

	public getDomNode(): HTMLElement { return this.domNode.domNode; }
	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		return this.updateSettings();
	}
	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		const multiple = event.selections.length > 1;
		this.cursorPositions = event.selections.map((selection, index) => ({
			position: selection.getPosition(),
			color: multiple
				? index === 0 ? this.settings.cursorColorPrimary : this.settings.cursorColorSecondary
				: this.settings.cursorColorSingle,
		})).sort((left, right) => Position.compare(left.position, right.position));
		return this.markMaybe();
	}
	public override onDecorationsChanged(event: viewEvents.ViewDecorationsChangedEvent): boolean {
		return event.affectsOverviewRuler ? this.markMaybe() : false;
	}
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return this.markNeeded(); }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollHeightChanged ? this.markNeeded() : false; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return this.markNeeded(); }
	public override onThemeChanged(_event: viewEvents.ViewThemeChangedEvent): boolean { return this.updateSettings(); }

	public override prepareRender(_context: RenderingContext): void {
		if (this.renderState === RenderState.Clean) return;
		this.preparedDecorations = this._context.viewModel.getAllOverviewRulerDecorations(this._context.theme)
			.sort(OverviewRulerDecorationsGroup.compareByRenderingProps);
		if (
			this.renderState === RenderState.Maybe
			&& OverviewRulerDecorationsGroup.equalsArr(this.renderedDecorations, this.preparedDecorations)
			&& cursorMarkersEqual(this.renderedCursorPositions, this.cursorPositions)
		) {
			this.renderState = RenderState.Clean;
		} else {
			this.renderState = RenderState.Needed;
		}
	}

	public render(context: RestrictedRenderingContext): void {
		this.domNode.setTransform(`translate3d(${context.scrollLeft}px, ${context.scrollTop}px, 0)`);
		if (this.renderState !== RenderState.Needed) return;
		this.paint();
	}

	private paint(): void {
		this.renderState = RenderState.Clean;
		this.renderedDecorations = this.preparedDecorations;
		this.renderedCursorPositions = this.cursorPositions;
		const { lanes, canvasWidth, canvasHeight, backgroundColor } = this.settings;
		this.domNode.setDisplay(lanes === 0 || canvasWidth === 0 || canvasHeight === 0 ? 'none' : 'block');
		if (lanes === 0 || canvasWidth === 0 || canvasHeight === 0) return;
		const painter = this.domNode.domNode.getContext('2d');
		if (!painter) return;
		painter.clearRect(0, 0, canvasWidth, canvasHeight);
		if (backgroundColor) {
			painter.fillStyle = backgroundColor;
			painter.fillRect(0, 0, canvasWidth, canvasHeight);
		}
		const viewLayout = this._context.viewLayout;
		const scaleY = canvasHeight / Math.max(1, viewLayout.getScrollHeight());
		const minimumHeight = Math.max(1, Math.floor(MINIMUM_DECORATION_HEIGHT * this.settings.pixelRatio));
		for (const group of this.preparedDecorations) {
			painter.fillStyle = group.color;
			for (let index = 0; index < group.data.length; index += 3) {
				const lane = group.data[index]!;
				const startLineNumber = group.data[index + 1]!;
				const endLineNumber = group.data[index + 2]!;
				const top = Math.floor(viewLayout.getVerticalOffsetForLineNumber(startLineNumber) * scaleY);
				const bottom = Math.ceil((viewLayout.getVerticalOffsetForLineNumber(endLineNumber) + this.settings.lineHeight) * scaleY);
				const horizontal = this.settings.laneBounds(lane);
				const marker = verticallyCenter(top, bottom, minimumHeight, canvasHeight);
				painter.fillRect(horizontal.left, marker.top, horizontal.width, marker.height);
			}
		}
		this.paintCursors(painter, scaleY);
		if (this.settings.renderBorder && this.settings.borderColor) {
			painter.beginPath();
			painter.lineWidth = 1;
			painter.strokeStyle = this.settings.borderColor;
			painter.moveTo(0, 0);
			painter.lineTo(0, canvasHeight);
			painter.moveTo(1, 0);
			painter.lineTo(canvasWidth, 0);
			painter.stroke();
		}
	}

	private paintCursors(painter: CanvasRenderingContext2D, scaleY: number): void {
		if (this.settings.hideCursor) return;
		const height = Math.max(1, Math.floor(2 * this.settings.pixelRatio));
		const horizontal = this.settings.laneBounds(OverviewRulerLane.Full);
		for (const cursor of this.cursorPositions) {
			if (!cursor.color) continue;
			const center = Math.floor(this._context.viewLayout.getVerticalOffsetForLineNumber(cursor.position.lineNumber) * scaleY);
			const top = Math.max(0, Math.min(this.settings.canvasHeight - height, center - Math.floor(height / 2)));
			painter.fillStyle = cursor.color;
			painter.fillRect(horizontal.left, top, horizontal.width, height);
		}
	}

	private updateSettings(): boolean {
		const next = new OverviewRulerSettings(this._context);
		if (this.settings.equals(next)) return false;
		this.settings = next;
		this.cursorPositions = this.cursorPositions.map((cursor, index) => ({
			position: cursor.position,
			color: this.cursorPositions.length > 1
				? index === 0 ? next.cursorColorPrimary : next.cursorColorSecondary
				: next.cursorColorSingle,
		}));
		this.applySettings();
		return this.markNeeded();
	}

	private applySettings(): void {
		this.domNode.setTop(this.settings.top);
		this.domNode.setRight(this.settings.right);
		this.domNode.setWidth(this.settings.domWidth);
		this.domNode.setHeight(this.settings.domHeight);
		this.domNode.domNode.width = this.settings.canvasWidth;
		this.domNode.domNode.height = this.settings.canvasHeight;
	}

	private markMaybe(): true {
		if (this.renderState !== RenderState.Needed) this.renderState = RenderState.Maybe;
		return true;
	}

	private markNeeded(): true {
		this.renderState = RenderState.Needed;
		return true;
	}
}

class OverviewRulerSettings {
	readonly lineHeight: number;
	readonly pixelRatio: number;
	readonly lanes: number;
	readonly renderBorder: boolean;
	readonly borderColor: string | null;
	readonly backgroundColor: string | null;
	readonly hideCursor: boolean;
	readonly cursorColorSingle: string | null;
	readonly cursorColorPrimary: string | null;
	readonly cursorColorSecondary: string | null;
	readonly top: number;
	readonly right: number;
	readonly domWidth: number;
	readonly domHeight: number;
	readonly canvasWidth: number;
	readonly canvasHeight: number;

	constructor(context: ViewContext) {
		const options = context.configuration.options;
		const position = options.get(EditorOption.layoutInfo).overviewRuler;
		this.lineHeight = options.get(EditorOption.lineHeight);
		this.pixelRatio = options.get(EditorOption.pixelRatio);
		this.lanes = options.get(EditorOption.overviewRulerLanes);
		this.renderBorder = options.get(EditorOption.overviewRulerBorder);
		this.borderColor = context.theme.getColor(ColorId.editorOverviewRulerBorder)?.toString() ?? null;
		const configuredBackground = context.theme.getColor(ColorId.editorOverviewRulerBackground);
		this.backgroundColor = configuredBackground && !configuredBackground.isTransparent()
			? configuredBackground.toString()
			: (options.get(EditorOption.minimap).enabled && options.get(EditorOption.minimap).side === 'right'
				? TokenizationRegistry.getDefaultBackground()?.toString() ?? null
				: null);
		this.hideCursor = options.get(EditorOption.hideCursorInOverviewRuler);
		this.cursorColorSingle = context.theme.getColor(ColorId.editorCursorForeground)?.transparent(0.7).toString() ?? null;
		this.cursorColorPrimary = context.theme.getColor(ColorId.editorMultiCursorPrimaryForeground)?.transparent(0.7).toString() ?? null;
		this.cursorColorSecondary = context.theme.getColor(ColorId.editorMultiCursorSecondaryForeground)?.transparent(0.7).toString() ?? null;
		this.top = position.top;
		this.right = position.right;
		this.domWidth = position.width;
		this.domHeight = position.height;
		this.canvasWidth = this.lanes === 0 ? 0 : Math.max(0, Math.floor(this.domWidth * this.pixelRatio));
		this.canvasHeight = this.lanes === 0 ? 0 : Math.max(0, Math.floor(this.domHeight * this.pixelRatio));
	}

	laneBounds(lane: number): { readonly left: number; readonly width: number } {
		const laneCount = Math.max(1, Math.min(3, this.lanes));
		if (laneCount === 1 || lane === OverviewRulerLane.Full) return { left: 0, width: this.canvasWidth };
		const leftWidth = Math.floor(this.canvasWidth / laneCount);
		const centerWidth = laneCount === 3 ? this.canvasWidth - 2 * leftWidth : leftWidth;
		const rightLeft = laneCount === 3 ? leftWidth + centerWidth : leftWidth;
		const rightWidth = this.canvasWidth - rightLeft;
		if (laneCount === 2) {
			if (lane === OverviewRulerLane.Right) return { left: rightLeft, width: rightWidth };
			return { left: 0, width: lane === OverviewRulerLane.Left || lane === OverviewRulerLane.Center ? leftWidth : this.canvasWidth };
		}
		const first = lane & OverviewRulerLane.Left ? 0 : lane & OverviewRulerLane.Center ? leftWidth : rightLeft;
		const last = lane & OverviewRulerLane.Right ? this.canvasWidth : lane & OverviewRulerLane.Center ? rightLeft : leftWidth;
		return { left: first, width: Math.max(0, last - first) };
	}

	equals(other: OverviewRulerSettings): boolean {
		return this.lineHeight === other.lineHeight
			&& this.pixelRatio === other.pixelRatio
			&& this.lanes === other.lanes
			&& this.renderBorder === other.renderBorder
			&& this.borderColor === other.borderColor
			&& this.backgroundColor === other.backgroundColor
			&& this.hideCursor === other.hideCursor
			&& this.cursorColorSingle === other.cursorColorSingle
			&& this.cursorColorPrimary === other.cursorColorPrimary
			&& this.cursorColorSecondary === other.cursorColorSecondary
			&& this.top === other.top
			&& this.right === other.right
			&& this.domWidth === other.domWidth
			&& this.domHeight === other.domHeight;
	}
}

function verticallyCenter(top: number, bottom: number, minimumHeight: number, canvasHeight: number): { readonly top: number; readonly height: number } {
	const height = Math.max(minimumHeight, bottom - top);
	const centeredTop = top - Math.floor((height - (bottom - top)) / 2);
	return { top: Math.max(0, Math.min(canvasHeight - height, centeredTop)), height: Math.min(canvasHeight, height) };
}

function cursorMarkersEqual(left: readonly CursorMarker[], right: readonly CursorMarker[]): boolean {
	return left.length === right.length && left.every((marker, index) => {
		const other = right[index]!;
		return marker.position.lineNumber === other.position.lineNumber && marker.color === other.color;
	});
}
