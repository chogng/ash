import '../viewParts/viewLines/viewLines.css';
import { h } from '../../../base/browser/dom.js';
import { FastDomNode } from '../../../base/browser/fastDomNode.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { type EditorVisualLine, type EditorVisualLineProjection } from '../../common/viewModel/modelLineProjection.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { type RestrictedRenderingContext } from './renderingContext.js';
import { type EditorLineRange } from '../../common/viewModel.js';

export interface ViewLayerLineRenderer<TLine> {
	createLine(visualLineIndex: number): TLine;
	getDomNode(line: TLine): HTMLElement;
	renderLine(line: TLine, visualLine: EditorVisualLine): void;
	layoutLine(line: TLine, lineHeight: number): void;
}

export interface ViewLayerOptions<TLine> {
	readonly host: HTMLElement;
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly readProjectionRevision: () => number;
	readonly lineRenderer: ViewLayerLineRenderer<TLine>;
}

/**
 * Reconciles the virtualized visual-line window and owns only its layer DOM.
 *
 * Content-specific rendering belongs to the ViewLines part; overlays consume
 * the stable line objects exposed by this layer.
 */
export class ViewLayer<TLine> extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly root: FastDomNode<HTMLDivElement>;
	private readonly readVisualProjection: () => EditorVisualLineProjection;
	private readonly readProjectionRevision: () => number;
	private readonly lineRenderer: ViewLayerLineRenderer<TLine>;
	private lines = new Map<number, TLine>();
	private renderedRange: EditorLineRange = { startLineIndex: 0, endLineIndexExclusive: 0 };
	private renderedModelVersion = -1;
	private renderedLineHeight = -1;
	private renderedProjectionRevision = -1;
	private renderedVerticalOffsets: readonly number[] | undefined;

	constructor(options: ViewLayerOptions<TLine>) {
		super();
		this.readVisualProjection = options.readVisualProjection;
		this.readProjectionRevision = options.readProjectionRevision;
		this.lineRenderer = options.lineRenderer;
		const domNode = h(options.host.ownerDocument, 'div');
		this._register(toDisposable(() => domNode.remove()));
		this.domNode = domNode;
		this.root = new FastDomNode(this.domNode);
		this.root.setClassName('view-lines');
	}

	get renderedLines(): ReadonlyMap<number, TLine> {
		return this.lines;
	}

	get renderedLineRange(): EditorLineRange {
		return this.renderedRange;
	}

	render(viewportData: ViewportData): void {
		this.root.setTop(viewportData.bigNumbersDelta);
		const visualProjection = this.readVisualProjection();
		const projectionRevision = this.readProjectionRevision();
		const renderRange = { startLineIndex: viewportData.startLineNumber - 1, endLineIndexExclusive: viewportData.endLineNumber };
		if (
			this.renderedModelVersion === visualProjection.modelVersion &&
			this.renderedLineHeight === viewportData.lineHeight &&
			this.renderedProjectionRevision === projectionRevision &&
			numberArraysEqual(this.renderedVerticalOffsets, viewportData.relativeVerticalOffset) &&
			lineRangesEqual(this.renderedRange, renderRange)
		) return;

		const ordered: HTMLElement[] = [];
		const next = new Map<number, TLine>();
		for (let visualLineIndex = renderRange.startLineIndex; visualLineIndex < renderRange.endLineIndexExclusive; visualLineIndex += 1) {
			const visualLine = visualProjection.lineAt(visualLineIndex);
			if (!visualLine) throw new Error('Viewport render range exceeds the visual line projection');
			const existing = this.lines.get(visualLineIndex);
			const line = existing ?? this.lineRenderer.createLine(visualLineIndex);
			const needsLineRender = !existing || this.renderedModelVersion !== visualProjection.modelVersion || this.renderedProjectionRevision !== projectionRevision;
			if (needsLineRender) this.lineRenderer.renderLine(line, visualLine);
			if (!existing || this.renderedLineHeight !== viewportData.lineHeight) this.lineRenderer.layoutLine(line, viewportData.lineHeight);
			const domNode = this.lineRenderer.getDomNode(line);
			domNode.style.top = `${viewportData.relativeVerticalOffset[visualLineIndex - renderRange.startLineIndex]}px`;
			next.set(visualLineIndex, line);
			ordered.push(domNode);
		}
		reconcileChildren(this.domNode, ordered);
		this.lines = next;
		this.renderedRange = renderRange;
		this.renderedModelVersion = visualProjection.modelVersion;
		this.renderedLineHeight = viewportData.lineHeight;
		this.renderedProjectionRevision = projectionRevision;
		this.renderedVerticalOffsets = viewportData.relativeVerticalOffset;
	}
}

function numberArraysEqual(left: readonly number[] | undefined, right: readonly number[]): boolean {
	return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function lineRangesEqual(left: EditorLineRange, right: EditorLineRange): boolean {
	return left.startLineIndex === right.startLineIndex && left.endLineIndexExclusive === right.endLineIndexExclusive;
}
export class ViewPartRows extends Disposable {
	public readonly domNode: FastDomNode<HTMLDivElement>;
	private rows = new Map<number, FastDomNode<HTMLDivElement>>();

	constructor(host: HTMLElement, className: string, private readonly rowClassName: string) {
		super();
		const element = h(host.ownerDocument, 'div');
		this.domNode = new FastDomNode(element);
		this.domNode.setClassName(`stanza-editor-row-layer ${className}`);
		element.setAttribute('role', 'presentation');
		element.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => element.remove()));
	}

	public hasViewport(startLineNumber: number, endLineNumber: number): boolean {
		const count = endLineNumber - startLineNumber + 1;
		if (this.rows.size !== count) return false;
		if (count === 0) return true;
		return this.rows.has(startLineNumber - 1) && this.rows.has(endLineNumber - 1);
	}

	public render(context: RestrictedRenderingContext): ReadonlyMap<number, HTMLElement> {
		const ordered: HTMLElement[] = [];
		const next = new Map<number, FastDomNode<HTMLDivElement>>();
		const projected = new Map<number, HTMLElement>();
		this.domNode.setTop(context.bigNumbersDelta);
		for (let lineNumber = context.viewportData.startLineNumber; lineNumber <= context.viewportData.endLineNumber; lineNumber += 1) {
			const lineIndex = lineNumber - 1;
			let row = this.rows.get(lineIndex);
			if (!row) {
				const element = h(this.domNode.domNode.ownerDocument, 'div');
				element.className = this.rowClassName;
				element.dataset.lineIndex = String(lineIndex);
				row = new FastDomNode(element);
			}
			row.setHeight(context.viewportData.lineHeight);
			row.setLineHeight(context.viewportData.lineHeight);
			row.setPosition('absolute');
			row.setTop(context.viewportData.relativeVerticalOffset[lineNumber - context.viewportData.startLineNumber]!);
			next.set(lineIndex, row);
			projected.set(lineIndex, row.domNode);
			ordered.push(row.domNode);
		}
		reconcileChildren(this.domNode.domNode, ordered);
		this.rows = next;
		return projected;
	}
}

function reconcileChildren(parent: HTMLElement, ordered: readonly HTMLElement[]): void {
	const retained = new Set<Node>(ordered);
	for (const child of [...parent.childNodes]) {
		if (!retained.has(child)) child.remove();
	}
	let next = parent.firstChild;
	for (const child of ordered) {
		if (child === next) {
			next = next.nextSibling;
		} else {
			parent.insertBefore(child, next);
		}
	}
}

export function renderViewPartRows(context: RestrictedRenderingContext, ownerDocument: Document, project: (rows: ReadonlyMap<number, HTMLElement>) => void): string[] {
	const rows = new Map<number, HTMLElement>();
	for (let lineNumber = context.viewportData.startLineNumber; lineNumber <= context.viewportData.endLineNumber; lineNumber += 1) {
		rows.set(lineNumber - 1, h(ownerDocument, 'div'));
	}
	project(rows);
	return [...rows.values()].map(row => row.innerHTML);
}
