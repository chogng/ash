import { addDisposableListener, fragment as createFragment, h, reset } from '../../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../../base/browser/fastDomNode.js';
import { StandardWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { createScrollbarAxisMetrics } from '../../../../../base/browser/ui/scrollbar/scrollbarState.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { type IDimension } from '../../../../common/core/2d/dimension.js';
import { LineDiffKind, type LineDiffRow } from '../../../../common/diff/lineDiff.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

export class OverviewRulerFeature extends Disposable {
	private static readonly ONE_OVERVIEW_WIDTH = 15;
	public static readonly ENTIRE_DIFF_OVERVIEW_WIDTH = OverviewRulerFeature.ONE_OVERVIEW_WIDTH * 2;
	private enabled = true;
	private rows: readonly LineDiffRow[] = [];
	private originalVersion = 0;
	private modifiedVersion = 0;
	public get width(): number {
		return this.enabled ? OverviewRulerFeature.ENTIRE_DIFF_OVERVIEW_WIDTH : 0;
	}

	private readonly domNode: HTMLDivElement;
	private readonly root: FastDomNode<HTMLDivElement>;
	private readonly originalLane: HTMLDivElement;
	private readonly modifiedLane: HTMLDivElement;
	private readonly viewportNode: FastDomNode<HTMLDivElement>;
	private viewportWidth = 0;
	private viewportHeight = 0;

	constructor(private readonly rootElement: HTMLElement, private readonly original: CodeEditorWidget, private readonly modified: CodeEditorWidget) {
		super();
		const ownerDocument = rootElement.ownerDocument;
		this.domNode = h(ownerDocument, 'div');
		this.root = new FastDomNode(this.domNode);
		this.originalLane = h(ownerDocument, 'div');
		this.modifiedLane = h(ownerDocument, 'div');
		const viewport = h(ownerDocument, 'div');
		this.viewportNode = new FastDomNode(viewport);

		this.root.setClassName('stanza-diff-overview');
		this.domNode.setAttribute('aria-hidden', 'true');
		this.originalLane.className = 'stanza-diff-overview-lane original';
		this.modifiedLane.className = 'stanza-diff-overview-lane modified';
		this.viewportNode.setClassName('stanza-diff-overview-viewport');
		this.domNode.append(this.originalLane, this.modifiedLane, viewport);
		this.rootElement.classList.add('has-diff-overview');
		this.rootElement.append(this.domNode);
		for (const editor of [original, modified]) {
			this._register(editor.onDidLayoutChange(() => {
				this.renderRows();
				this.updateViewport(this.modified.getContentHeight(), this.modified.getScrollTop());
			}));
		}
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => this.modified.delegateVerticalScrollbarPointerDown(event)));
		this._register(addDisposableListener(this.domNode, 'wheel', event => {
			if (this.modified.getOption(EditorOption.scrollbar).handleMouseWheel) this.modified.delegateScrollFromMouseWheelEvent(new StandardWheelEvent(event));
		}, { passive: false }));

		this._register(toDisposable(() => {
			this.rootElement.classList.remove('has-diff-overview');
			this.domNode.remove();
		}));
	}

	public setRows(rows: readonly LineDiffRow[]): void {
		this.rows = rows;
		this.originalVersion = this.original.getModel()!.getVersionId();
		this.modifiedVersion = this.modified.getModel()!.getVersionId();
		this.renderRows();
	}

	private renderRows(): void {
		// Text layout changes before the new diff arrives; old rows belong to the old versions.
		const rows = this.originalVersion === this.original.getModel()!.getVersionId()
			&& this.modifiedVersion === this.modified.getModel()!.getVersionId() ? this.rows : [];
		reset(this.originalLane, createMarkers(this.domNode.ownerDocument, rows, 'original', this.original));
		reset(this.modifiedLane, createMarkers(this.domNode.ownerDocument, rows, 'modified', this.modified));
	}

	public setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.domNode.hidden = !enabled;
		this.rootElement.classList.toggle('has-diff-overview', enabled);
	}

	public layout(size: IDimension): void {
		this.viewportWidth = size.width;
		this.viewportHeight = size.height;
		this.renderRows();
	}

	public updateViewport(contentHeight: number, scrollTop: number): void {
		this.root.setLeft(Math.max(0, this.viewportWidth - this.width));
		this.root.setHeight(this.viewportHeight);
		const metrics = createScrollbarAxisMetrics(this.viewportHeight, contentHeight, scrollTop, this.viewportHeight, 2);
		this.viewportNode.setHeight(metrics.thumbSize);
		this.viewportNode.setTransform(`translate3d(0, ${metrics.thumbPosition}px, 0)`);
	}
}

function createMarkers(ownerDocument: Document, rows: readonly LineDiffRow[], side: 'original' | 'modified', editor: CodeEditorWidget): DocumentFragment {
	const fragment = createFragment(ownerDocument);
	if (rows.length === 0) return fragment;
	for (const range of changedRanges(rows, side)) {
		const marker = h(ownerDocument, 'span');
		marker.className = `stanza-diff-overview-marker ${side === 'original' ? 'removed' : 'inserted'}`;
		const first = rows[range.startRow][side === 'original' ? 'originalLineIndex' : 'modifiedLineIndex']! + 1;
		const last = rows[range.endRowExclusive - 1][side === 'original' ? 'originalLineIndex' : 'modifiedLineIndex']! + 1;
		const top = editor.getTopForLineNumber(first);
		const bottom = editor.getBottomForLineNumber(last);
		const height = editor.getContentHeight();
		marker.style.top = `${height > 0 ? top / height * 100 : 0}%`;
		marker.style.height = `${height > 0 ? (bottom - top) / height * 100 : 0}%`;
		fragment.append(marker);
	}
	return fragment;
}

function changedRanges(rows: readonly LineDiffRow[], side: 'original' | 'modified'): readonly ChangedRowRange[] {
	const ranges: ChangedRowRange[] = [];
	let startRow = -1;
	for (let rowIndex = 0; rowIndex <= rows.length; rowIndex += 1) {
		const row = rows[rowIndex];
		const changed = row !== undefined && (side === 'original'
			? row.kind === LineDiffKind.Removed || row.kind === LineDiffKind.Modified
			: row.kind === LineDiffKind.Added || row.kind === LineDiffKind.Modified);
		if (changed && startRow < 0) startRow = rowIndex;
		if (!changed && startRow >= 0) {
			ranges.push(Object.freeze({ startRow, endRowExclusive: rowIndex }));
			startRow = -1;
		}
	}
	return Object.freeze(ranges);
}

interface ChangedRowRange {
	readonly startRow: number;
	readonly endRowExclusive: number;
}
