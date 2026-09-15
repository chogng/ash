import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { type Snippet } from "../common/snippetParser.js";
import { applySnippetTransform, type SnippetTransform } from "../common/snippetTransform.js";
import { Selection } from "../../../common/core/selection.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type TrackedRange } from "../../../common/model/trackedRange.js";
import { TrackedRangeStickiness, type IIdentifiedSingleEditOperation } from '../../../common/model.js';

/**
 * Owns one accepted completion snippet's tabstop navigation.
 *
 * Every tabstop occurrence is tracked through later model transactions. The
 * session owns neither the model nor the editor, and may
 * be disposed without changing inserted text.
 */
export class SnippetSession extends Disposable {
	private readonly groups: readonly SnippetTrackedGroup[];
	private readonly transforms: readonly SnippetTrackedTransform[];
	private readonly finalRange: TrackedRange;
	private currentGroupIndex = 0;

	constructor(
		private readonly model: TextModel,
		private readonly editor: ICodeEditor,
		insertionStartOffset: number,
		snippet: Snippet,
		finalOffsetWithinInsertion = snippet.text.length,
	) {
		super();
		if (model !== editor.getModel()) {
			this.dispose();
			throw new TypeError("Language completion snippet session must share its editor text model");
		}
		if (!Number.isSafeInteger(insertionStartOffset) || insertionStartOffset < 0 || insertionStartOffset > model.getText().length) {
			this.dispose();
			throw new RangeError("Language completion snippet insertion offset is outside its text model");
		}
		if (!snippet || typeof snippet.text !== "string" || snippet.placeholderGroups.length === 0) {
			this.dispose();
			throw new TypeError("Language completion snippet session requires at least one parsed tabstop");
		}
		if (!Number.isSafeInteger(finalOffsetWithinInsertion) || finalOffsetWithinInsertion < snippet.text.length) {
			this.dispose();
			throw new RangeError("Language completion snippet final offset must follow its expansion text");
		}
		try {
			this.groups = Object.freeze(snippet.placeholderGroups.map(group => Object.freeze({
				index: group.index,
				ranges: Object.freeze(group.placeholders.map(placeholder =>
					model.trackRange(
						Range.fromPositions(
							model.positionAt(insertionStartOffset + placeholder.startOffset),
							model.positionAt(insertionStartOffset + placeholder.endOffset),
						),
						TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					)
				)),
				...(group.choices ? { choices: group.choices } : {}),
			})));
			this.transforms = Object.freeze((snippet.transforms ?? []).map(transform => Object.freeze({
				index: transform.index,
				transform: transform.transform,
				range: model.trackRange(
					Range.fromPositions(
						model.positionAt(insertionStartOffset + transform.startOffset),
						model.positionAt(insertionStartOffset + transform.endOffset),
					),
					TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				),
			})));
			this.finalRange = model.trackRange(
				Range.fromPositions(model.positionAt(insertionStartOffset + finalOffsetWithinInsertion)),
				TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			);
			this._register(toDisposable(() => {
				for (const group of this.groups) {
					for (const range of group.ranges) range.dispose();
				}
				for (const transform of this.transforms) transform.range.dispose();
				this.finalRange.dispose();
			}));
			this.selectGroup(0);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Whether this session has released its tracked tabstops. */
	get isDisposed(): boolean { return super.isDisposed; }

	/** Advances to the next tabstop or consumes the final Tab that leaves the snippet. */
	selectNext(): boolean {
		this.assertNotDisposed();
		if (this.currentGroupIndex + 1 < this.groups.length) {
			this.synchronizeTransforms(this.groups[this.currentGroupIndex]!);
			this.editor.pushUndoStop();
			this.currentGroupIndex += 1;
			this.selectGroup(this.currentGroupIndex);
			return true;
		}
		if (this.currentGroupIndex === this.groups.length - 1) {
			this.synchronizeTransforms(this.groups[this.currentGroupIndex]!);
			this.editor.pushUndoStop();
			this.currentGroupIndex += 1;
			this.editor.setSelections([Selection.fromPositions(this.finalRange.range.getEndPosition())]);
			return true;
		}
		this.dispose();
		return true;
	}

	/** Moves to the preceding tabstop; no selection changes occur before the first group. */
	selectPrevious(): boolean {
		this.assertNotDisposed();
		if (this.currentGroupIndex === this.groups.length) {
			this.editor.pushUndoStop();
			this.currentGroupIndex -= 1;
			this.selectGroup(this.currentGroupIndex);
			return true;
		}
		if (this.currentGroupIndex === 0) return false;
		this.synchronizeTransforms(this.groups[this.currentGroupIndex]!);
		this.editor.pushUndoStop();
		this.currentGroupIndex -= 1;
		this.selectGroup(this.currentGroupIndex);
		return true;
	}

	/** Replaces the active choice tabstop and every mirrored occurrence with its next value. */
	selectNextChoice(): boolean {
		return this.selectRelativeChoice(1);
	}

	/** Replaces the active choice tabstop and every mirrored occurrence with its previous value. */
	selectPreviousChoice(): boolean {
		return this.selectRelativeChoice(-1);
	}

	/** Leaves navigation active text unchanged and releases its tracked tabstops. */
	cancel(): void {
		this.assertNotDisposed();
		this.dispose();
	}

	private selectGroup(index: number): void {
		const group = this.groups[index];
		if (!group) throw new RangeError("Language completion snippet tabstop index is outside its session");
		this.editor.setSelections(group.ranges.map(range => Selection.fromPositions(range.range.getStartPosition(), range.range.getEndPosition())));
	}

	private selectRelativeChoice(delta: number): boolean {
		this.assertNotDisposed();
		const group = this.groups[this.currentGroupIndex];
		if (!group?.choices || group.choices.length === 0) return false;
		let current = group.choices.indexOf(this.model.getTextInRange(group.ranges[0]!.range));
		if (current < 0) {
			current = delta > 0 ? -1 : 0;
		}
		const next = rot(current + delta, group.choices.length);
		return this.replaceChoice(group, group.choices[next]!);
	}

	private replaceChoice(group: SnippetTrackedGroup, text: string): boolean {
		const model = this.model;
		const ranges = group.ranges.map(range => ({
			range,
			startOffset: model.offsetAt(range.range.getStartPosition()),
			endOffset: model.offsetAt(range.range.getEndPosition()),
		})).sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
		for (let index = 1; index < ranges.length; index += 1) {
			const previous = ranges[index - 1]!;
			const current = ranges[index]!;
			if (current.startOffset < previous.endOffset) return false;
		}
		const edits: IIdentifiedSingleEditOperation[] = group.ranges.map((range, index) => ({
			range: range.range,
			text,
			identifier: { major: 0, minor: index },
		}));
		for (const transform of this.transforms) {
			if (transform.index !== group.index) continue;
			const transformed = applySnippetTransform(text, transform.transform);
			if (model.getTextInRange(transform.range.range) !== transformed) {
				edits.push({ range: transform.range.range, text: transformed });
			}
		}
		const version = model.version;
		if (!this.editor.pushUndoStop()) return false;
		this.editor.executeEdits("snippet.choice", edits, inverseEdits => inverseEdits
			.filter(edit => edit.identifier?.major === 0)
			.sort((left, right) => left.identifier!.minor - right.identifier!.minor)
			.map(edit => Selection.fromPositions(edit.range.getStartPosition(), edit.range.getEndPosition())));
		this.editor.pushUndoStop();
		return model.version !== version;
	}

	private synchronizeTransforms(group: SnippetTrackedGroup): void {
		const transforms = this.transforms.filter(transform => transform.index === group.index);
		if (transforms.length === 0) return;
		const sourceRange = group.ranges[0];
		if (!sourceRange) return;
		const model = this.model;
		const sourceText = model.getTextInRange(sourceRange.range);
		const edits = transforms.flatMap(transform => {
			const text = applySnippetTransform(sourceText, transform.transform);
			return model.getTextInRange(transform.range.range) === text ? [] : [{ range: transform.range.range, text }];
		});
		if (edits.length > 0) this.editor.executeEdits("snippet.transform", edits);
	}

}

interface SnippetTrackedGroup {
	readonly index: number;
	readonly ranges: readonly TrackedRange[];
	readonly choices?: readonly string[];
}

interface SnippetTrackedTransform {
	readonly index: number;
	readonly transform: SnippetTransform;
	readonly range: TrackedRange;
}
