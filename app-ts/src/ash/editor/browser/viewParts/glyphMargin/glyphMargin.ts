import { h } from '../../../../base/browser/dom.js';
import './glyphMargin.css';
import { createFastDomNode, FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { GlyphMarginLane } from '../../../common/model.js';
import { type IGlyphMarginWidget, type IGlyphMarginWidgetPosition } from '../../editorBrowser.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { Range } from '../../../common/core/range.js';
import { Position } from '../../../common/core/position.js';
import { EditorOption } from '../../../common/config/editorOptions.js';

export class DecorationToRender {
	public readonly _decorationToRenderBrand: void = undefined;
	public readonly zIndex: number;

	constructor(
		public readonly startLineNumber: number,
		public readonly endLineNumber: number,
		public readonly className: string,
		public readonly tooltip: string | null,
		zIndex: number | undefined,
	) {
		this.zIndex = zIndex ?? 0;
	}
}

export class LineDecorationToRender {
	constructor(
		public readonly className: string,
		public readonly zIndex: number,
		public readonly tooltip: string | null,
	) {}
}

export class VisibleLineDecorationsToRender {
	private readonly decorations: LineDecorationToRender[] = [];

	public add(decoration: LineDecorationToRender): void {
		this.decorations.push(decoration);
	}

	public getDecorations(): LineDecorationToRender[] {
		return this.decorations;
	}
}

export abstract class DedupOverlay extends DynamicViewOverlay {
	protected _render(visibleStartLineNumber: number, visibleEndLineNumber: number, decorations: DecorationToRender[]): VisibleLineDecorationsToRender[] {
		const output: VisibleLineDecorationsToRender[] = [];
		for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber += 1) {
			output[lineNumber - visibleStartLineNumber] = new VisibleLineDecorationsToRender();
		}
		if (decorations.length === 0) return output;

		decorations.sort((left, right) => left.className.localeCompare(right.className)
			|| left.startLineNumber - right.startLineNumber
			|| left.endLineNumber - right.endLineNumber);
		let previousClassName: string | null = null;
		let previousEndLineIndex = 0;
		for (const decoration of decorations) {
			let startLineIndex = Math.max(decoration.startLineNumber, visibleStartLineNumber) - visibleStartLineNumber;
			const endLineIndex = Math.min(decoration.endLineNumber, visibleEndLineNumber) - visibleStartLineNumber;
			if (previousClassName === decoration.className) {
				startLineIndex = Math.max(previousEndLineIndex + 1, startLineIndex);
				previousEndLineIndex = Math.max(previousEndLineIndex, endLineIndex);
			} else {
				previousClassName = decoration.className;
				previousEndLineIndex = endLineIndex;
			}
			for (let lineIndex = startLineIndex; lineIndex <= previousEndLineIndex; lineIndex += 1) {
				output[lineIndex]!.add(new LineDecorationToRender(decoration.className, decoration.zIndex, decoration.tooltip));
			}
		}
		return output;
	}
}

/** Renders decoration-backed glyphs in shared, stable margin lanes. */
export class GlyphMarginWidgets extends ViewPart {
	public readonly domNode: FastDomNode<HTMLElement>;
	private lineHeight: number;
	private glyphMargin: boolean;
	private glyphMarginLeft: number;
	private glyphMarginWidth: number;
	private glyphMarginDecorationLaneCount: number;
	private readonly widgets = new Map<string, IWidgetData>();
	private readonly modelDecorationNodes: FastDomNode<HTMLDivElement>[] = [];
	private preparedModelDecorations: PreparedModelDecoration[] = [];

	constructor(context: ViewContext) {
		super(context);
		const options = context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this.domNode = createFastDomNode(h(document, 'div'));
		this.domNode.setClassName('glyph-margin-widgets');
		this.domNode.setPosition('absolute');
		this.domNode.setTop(0);
		this.lineHeight = options.get(EditorOption.lineHeight);
		this.glyphMargin = options.get(EditorOption.glyphMargin);
		this.glyphMarginLeft = layoutInfo.glyphMarginLeft;
		this.glyphMarginWidth = layoutInfo.glyphMarginWidth;
		this.glyphMarginDecorationLaneCount = layoutInfo.glyphMarginDecorationLaneCount;
	}

	public override dispose(): void {
		for (const id of [...this.widgets.keys()]) this.removeWidgetById(id);
		this.modelDecorationNodes.length = 0;
		this.preparedModelDecorations = [];
		super.dispose();
	}

	public getWidgets(): IWidgetData[] {
		return [...this.widgets.values()];
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this.lineHeight = options.get(EditorOption.lineHeight);
		this.glyphMargin = options.get(EditorOption.glyphMargin);
		this.glyphMarginLeft = layoutInfo.glyphMarginLeft;
		this.glyphMarginWidth = layoutInfo.glyphMarginWidth;
		this.glyphMarginDecorationLaneCount = layoutInfo.glyphMarginDecorationLaneCount;
		return true;
	}
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public addWidget(widget: IGlyphMarginWidget): void {
		const id = widget.getId();
		if (!id) throw new TypeError('Glyph margin widget id must not be empty');
		this.removeWidgetById(id);
		const domNode = createFastDomNode(widget.getDomNode());
		domNode.setPosition('absolute');
		domNode.setDisplay('none');
		domNode.setAttribute('widgetId', id);
		this.domNode.appendChild(domNode);
		this.widgets.set(id, { widget, preference: widget.getPosition(), domNode, renderInfo: null });
		this.setShouldRender();
	}

	public setWidgetPosition(widget: IGlyphMarginWidget, preference: IGlyphMarginWidgetPosition): boolean {
		const data = this.widgets.get(widget.getId());
		if (!data || data.widget !== widget) return false;
		if (data.preference.lane === preference.lane && data.preference.zIndex === preference.zIndex && Range.equalsRange(data.preference.range, preference.range)) return false;
		data.preference = preference;
		this.setShouldRender();
		return true;
	}

	public removeWidget(widget: IGlyphMarginWidget): void {
		const data = this.widgets.get(widget.getId());
		if (!data || data.widget !== widget) return;
		this.removeWidgetById(widget.getId());
		this.setShouldRender();
	}

	public prepareRender(context: RenderingContext): void {
		if (!this.glyphMargin) {
			this.preparedModelDecorations = [];
			return;
		}
		for (const data of this.widgets.values()) data.renderInfo = null;
		const candidates: PreparedGlyphCandidate[] = [];
		for (const data of this.widgets.values()) {
			const viewRange = this._context.viewModel.coordinatesConverter.convertModelRangeToViewRange(Range.lift(data.preference.range));
			const lineNumber = Math.max(viewRange.startLineNumber, context.visibleRange.startLineNumber);
			if (lineNumber > viewRange.endLineNumber || lineNumber > context.visibleRange.endLineNumber) continue;
			const modelPosition = this._context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber, 1));
			const laneIndex = this._context.viewModel.glyphLanes.getLanesAtLine(modelPosition.lineNumber).indexOf(data.preference.lane);
			candidates.push({ kind: 'widget', lineNumber, laneIndex, zIndex: data.preference.zIndex, data });
		}
		for (const decoration of context.getDecorationsInViewport()) {
			const className = decoration.options.glyphMarginClassName;
			if (!className) continue;
			const start = Math.max(decoration.range.startLineNumber, context.visibleRange.startLineNumber);
			const end = Math.min(decoration.range.endLineNumber, context.visibleRange.endLineNumber);
			const lane = decoration.options.glyphMargin?.position ?? GlyphMarginLane.Center;
			for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
				const modelPosition = this._context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber, 1));
				const laneIndex = this._context.viewModel.glyphLanes.getLanesAtLine(modelPosition.lineNumber).indexOf(lane);
				candidates.push({ kind: 'decoration', lineNumber, laneIndex, zIndex: decoration.options.zIndex ?? 0, className });
			}
		}
		candidates.sort(comparePreparedGlyphCandidates);
		const winners = new Map<string, PreparedGlyphCandidate>();
		for (const candidate of candidates) {
			const key = `${candidate.lineNumber}:${candidate.laneIndex}`;
			if (!winners.has(key)) winners.set(key, candidate);
		}
		const prepared: PreparedModelDecoration[] = [];
		for (const candidate of winners.values()) {
			if (candidate.kind === 'widget') candidate.data.renderInfo = { lineNumber: candidate.lineNumber, laneIndex: candidate.laneIndex };
			else prepared.push(candidate);
		}
		this.preparedModelDecorations = prepared;
	}

	public render(context: RestrictedRenderingContext): void {
		if (!this.glyphMargin) {
			for (const data of this.widgets.values()) data.domNode.setDisplay('none');
			while (this.modelDecorationNodes.length > 0) this.modelDecorationNodes.pop()?.domNode.remove();
			return;
		}
		const laneWidth = Math.round(this.glyphMarginWidth / Math.max(1, this.glyphMarginDecorationLaneCount));
		for (const data of this.widgets.values()) this.renderWidget(data, context, laneWidth);
		this.renderModelDecorations(context, laneWidth);
	}

	private renderWidget(data: IWidgetData, context: RestrictedRenderingContext, laneWidth: number): void {
		if (!data.renderInfo) {
			data.domNode.setDisplay('none');
			return;
		}
		data.domNode.setDisplay('block');
		data.domNode.setTop(context.viewportData.relativeVerticalOffset[data.renderInfo.lineNumber - context.viewportData.startLineNumber] ?? 0);
		data.domNode.setLeft(this.glyphMarginLeft + data.renderInfo.laneIndex * this.lineHeight);
		data.domNode.setWidth(laneWidth);
		data.domNode.setHeight(this.lineHeight);
	}

	private renderModelDecorations(context: RestrictedRenderingContext, laneWidth: number): void {
		for (let index = 0; index < this.preparedModelDecorations.length; index += 1) {
			const decoration = this.preparedModelDecorations[index];
			const node = this.modelDecorationNodes[index] ?? this.createModelDecorationNode();
			node.setClassName(`cgmr ${decoration.className}`);
			node.setTop(context.viewportData.relativeVerticalOffset[decoration.lineNumber - context.viewportData.startLineNumber] ?? 0);
			node.setLeft(this.glyphMarginLeft + decoration.laneIndex * this.lineHeight);
			node.setWidth(laneWidth);
			node.setHeight(context.getLineHeightForLineNumber(decoration.lineNumber));
		}
		while (this.modelDecorationNodes.length > this.preparedModelDecorations.length) this.modelDecorationNodes.pop()?.domNode.remove();
	}

	private createModelDecorationNode(): FastDomNode<HTMLDivElement> {
		const node = createFastDomNode(h(this.domNode.domNode.ownerDocument, 'div'));
		node.setPosition('absolute');
		node.setAttribute('aria-hidden', 'true');
		this.domNode.appendChild(node);
		this.modelDecorationNodes.push(node);
		return node;
	}

	private removeWidgetById(id: string): void {
		const data = this.widgets.get(id);
		if (!data) return;
		data.domNode.domNode.remove();
		data.domNode.removeAttribute('widgetId');
		this.widgets.delete(id);
	}

}

export interface IWidgetData {
	readonly widget: IGlyphMarginWidget;
	preference: IGlyphMarginWidgetPosition;
	readonly domNode: FastDomNode<HTMLElement>;
	renderInfo: IRenderInfo | null;
}

export interface IRenderInfo {
	readonly lineNumber: number;
	readonly laneIndex: number;
}

type PreparedGlyphCandidate =
	| { readonly kind: 'widget'; readonly lineNumber: number; readonly laneIndex: number; readonly zIndex: number; readonly data: IWidgetData }
	| PreparedModelDecoration;

interface PreparedModelDecoration {
	readonly kind: 'decoration';
	readonly lineNumber: number;
	readonly laneIndex: number;
	readonly zIndex: number;
	readonly className: string;
}

function comparePreparedGlyphCandidates(left: PreparedGlyphCandidate, right: PreparedGlyphCandidate): number {
	return left.lineNumber - right.lineNumber
		|| left.laneIndex - right.laneIndex
		|| right.zIndex - left.zIndex
		|| (left.kind === right.kind ? 0 : left.kind === 'widget' ? -1 : 1);
}
