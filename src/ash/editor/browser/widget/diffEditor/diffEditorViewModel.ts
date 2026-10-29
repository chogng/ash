import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableFromEvent, observableValue, type IObservable } from '../../../../base/common/observable.js';
import { LineRange } from '../../../common/core/ranges/lineRange.js';
import { toLineDiff, type LineDiff } from '../../../common/diff/lineDiff.js';
import type { DiffModel } from '../../../common/diff/diffModel.js';
import { LineRangeMapping } from '../../../common/diff/rangeMapping.js';
import type { MovedText } from '../../../common/diff/linesDiffComputer.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import type { CodeEditorWidget } from '../codeEditor/codeEditorWidget.js';

/** Owns a view's moved-code comparison and edit-tracking anchors over a shared diff model. */
export class DiffEditorViewModel extends Disposable {
	public readonly movedTextToCompare = observableValue<MovedText | undefined>(this, undefined);
	public readonly diff: IObservable<LineDiff | undefined>;
	private readonly originalAnchor;
	private readonly modifiedAnchor;

	constructor(public readonly model: DiffModel, originalEditor: CodeEditorWidget, modifiedEditor: CodeEditorWidget) {
		super();
		this.originalAnchor = originalEditor.createDecorationsCollection();
		this.modifiedAnchor = modifiedEditor.createDecorationsCollection();
		this._register(toDisposable(() => { this.originalAnchor.clear(); this.modifiedAnchor.clear(); }));
		this._register(this.movedTextToCompare.onDidChange(move => {
			for (const [anchor, side] of [[this.originalAnchor, 'original'], [this.modifiedAnchor, 'modified']] as const) {
				anchor.set(move ? [{
					range: move.lineRangeMapping[side].toInclusiveRange()!,
					options: { description: 'diff-move-comparison-anchor', stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
				}] : []);
			}
		}));
		this._register(model.onDidChange(() => {
			if (!model.diff || !this.movedTextToCompare.get()) {
				return;
			}
			const range = this.getComparedRange();
			this.movedTextToCompare.set(range ? model.diff.moves.find(move =>
				move.lineRangeMapping.original.intersect(range.original)?.isEmpty === false
				&& move.lineRangeMapping.modified.intersect(range.modified)?.isEmpty === false) : undefined);
		}));
		const result = observableFromEvent(this, model.onDidChange, () => model.diff);
		this.diff = derived(reader => {
			const diff = result.read(reader);
			const move = this.movedTextToCompare.read(reader);
			return diff && move ? toLineDiff({ changes: move.changes, moves: [move] }, model.original.lineCount, model.modified.lineCount, move.lineRangeMapping) : diff;
		});
	}

	public getComparedRange(): LineRangeMapping | undefined {
		if (!this.movedTextToCompare.get()) {
			return undefined;
		}
		const original = this.originalAnchor.getRange(0);
		const modified = this.modifiedAnchor.getRange(0);
		return original && modified ? new LineRangeMapping(LineRange.fromRangeInclusive(original), LineRange.fromRangeInclusive(modified)) : undefined;
	}
}
