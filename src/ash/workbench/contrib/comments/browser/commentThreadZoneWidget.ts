import { getWindow, h } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { LineDiffRows } from '../../../../editor/common/diff/lineDiff.js';
import { localize } from '../../../../nls.js';
import type { ICommentThreadPresentation } from './commentThreadEditorWidget.js';

export interface IReviewZoneComparison {
	readonly editor: ICodeEditor;
	readonly original: boolean;
	readonly rows: () => LineDiffRows | undefined;
}

export class ReviewZoneWidget implements ICommentThreadPresentation {
	readonly closeLabel = localize('comments.review.close', 'Close inline comments');

	constructor(private readonly editor: ICodeEditor, private readonly comparison: IReviewZoneComparison) { }

	revealLine(line: number): void {
		this.editor.setPosition({ lineNumber: line, column: 1 });
		this.editor.revealRange(new Range(line, 1, line, 1));
	}

	mount(line: number, panel: HTMLElement, resources: DisposableStore): boolean {
		const root = h(panel.ownerDocument, 'div', { className: 'ash-review-zone' });
		root.append(panel);
		const updateWidth = () => { panel.style.width = `${this.editor.getLayoutInfo().contentWidth}px`; };
		const updateOffset = () => { panel.style.marginLeft = `${this.editor.getScrollLeft()}px`; };
		updateWidth();
		updateOffset();
		resources.add(this.editor.onDidLayoutChange(updateWidth));
		resources.add(this.editor.onDidScrollChange(event => { if (event.scrollLeftChanged) updateOffset(); }));
		resources.add(toDisposable(() => {
			panel.style.removeProperty('width');
			panel.style.removeProperty('margin-left');
		}));

		const alignment = this.getAlignment(line);
		const zone: IViewZone = { afterLineNumber: line, ordinal: alignment?.ordinal, heightInPx: 1, domNode: root, isAccessible: true };
		let zoneId: string;
		this.editor.changeViewZones(accessor => { zoneId = accessor.addZone(zone); });
		resources.add(toDisposable(() => this.editor.changeViewZones(accessor => accessor.removeZone(zoneId))));

		const peer = this.comparison.editor;
		let spacer: IViewZone | undefined;
		let spacerId: string;
		if (alignment) {
			// Reserve the same height on the other side so subsequent diff rows stay aligned.
			const peerZone: IViewZone = { afterLineNumber: alignment.line, ordinal: alignment.ordinal, heightInPx: 1, domNode: h(panel.ownerDocument, 'div') };
			spacer = peerZone;
			peer.changeViewZones(accessor => { spacerId = accessor.addZone(peerZone); });
			resources.add(toDisposable(() => peer.changeViewZones(accessor => accessor.removeZone(spacerId))));
		}
		let pixels = 0;
		// Laying out the zone can resize both diff editors. Do it outside observer delivery.
		const layout = resources.add(new AnimationFrameScheduler(getWindow(panel), () => {
			if (!pixels || pixels === zone.heightInPx) return;
			zone.heightInPx = pixels;
			this.editor.changeViewZones(accessor => accessor.layoutZone(zoneId));
			if (spacer) {
				spacer.heightInPx = pixels;
				peer.changeViewZones(accessor => accessor.layoutZone(spacerId));
			}
		}));
		resources.add(observeElementSize(panel, ({ height }) => {
			pixels = Math.ceil(height);
			layout.schedule();
		}));
		this.revealLine(line);
		return true;
	}

	private getAlignment(line: number): { line: number; ordinal: number; } | undefined {
		const comparison = this.comparison;
		const rows = comparison.rows();
		if (!rows) return undefined;
		let previousPeerLine = 0;
		for (const [index, row] of rows.alignmentEntries()) {
			const source = comparison.original ? row.originalLineIndex : row.modifiedLineIndex;
			const peer = comparison.original ? row.modifiedLineIndex : row.originalLineIndex;
			if (source !== undefined && source + 1 >= line) {
				// Unchanged runs are represented by their last row in alignmentEntries.
				const offset = source + 1 - line;
				return { line: peer === undefined ? previousPeerLine : peer + 1 - offset, ordinal: index - offset + 0.5 };
			}
			if (peer !== undefined) previousPeerLine = peer + 1;
		}
		return undefined;
	}
}
