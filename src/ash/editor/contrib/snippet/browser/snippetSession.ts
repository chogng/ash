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
 * Owns one editor snippet's tabstop navigation.
 *
 * Every tabstop occurrence is tracked through later model transactions. The
 * session owns neither the model nor the editor, and may
 * be disposed without changing inserted text.
 */
export class SnippetSession extends Disposable {
	private readonly groups: SnippetTrackedGroup[];
	private readonly allGroups: SnippetTrackedGroup[] = [];
	private readonly transforms: SnippetTrackedTransform[] = [];
	private readonly finalRanges: readonly TrackedRange[];
	private currentGroupIndex = 0;

	constructor(
		private readonly model: TextModel,
		private readonly editor: ICodeEditor,
		insertionStartOffsets: number | readonly number[],
		snippet: Snippet,
		finalOffsetWithinInsertion = snippet.text.length,
	) {
		super();
		if (model !== editor.getModel()) {
			this.dispose();
			throw new TypeError("Language completion snippet session must share its editor text model");
		}
		const starts = typeof insertionStartOffsets === 'number' ? [insertionStartOffsets] : insertionStartOffsets;
		if (starts.length === 0 || starts.some(start => !Number.isSafeInteger(start) || start < 0 || start > model.getText().length)) {
			this.dispose();
			throw new RangeError("Snippet insertion offset is outside its text model");
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
			this.groups = this.trackExpansion(starts, snippet, index => index);
			this.finalRanges = Object.freeze(starts.map(start => model.trackRange(
				Range.fromPositions(model.positionAt(start + finalOffsetWithinInsertion)),
				TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			)));
			this._register(toDisposable(() => {
				for (const group of this.allGroups) {
					for (const range of group.ranges) range.dispose();
				}
				for (const transform of this.transforms) transform.range.dispose();
				for (const range of this.finalRanges) range.dispose();
			}));
			this.selectGroup(0);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Replaces the active tabstop's navigation with a nested expansion, retaining outer stops. */
	public merge(starts: readonly number[], snippet: Snippet, finalOffset: number): boolean {
		const parent = this.groups[this.currentGroupIndex];
		if (this.isDisposed || !parent || parent.index === 0 || !starts.length) return false;
		if (!starts.every(start => parent.ranges.some(tracked => tracked.range.containsRange(Range.fromPositions(this.model.positionAt(start), this.model.positionAt(start + snippet.text.length)))))) return false;
		let nextId = Math.max(0, ...this.allGroups.map(group => group.index)) + 1;
		const ids = new Map<number, number>();
		const children = this.trackExpansion(starts, snippet, index => {
			if (!ids.has(index)) ids.set(index, nextId++);
			return ids.get(index)!;
		});
		if (!snippet.placeholderGroups.some(group => group.index === 0)) {
			const final = { index: nextId, ranges: starts.map(start => this.model.trackRange(Range.fromPositions(this.model.positionAt(start + finalOffset)), TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges)) };
			children.push(final);
			this.allGroups.push(final);
		}
		for (const child of children) child.ancestors = [parent, ...(parent.ancestors ?? [])];
		this.groups.splice(this.currentGroupIndex, 1, ...children);
		this.selectGroup(this.currentGroupIndex);
		return true;
	}

	private trackExpansion(starts: readonly number[], snippet: Snippet, identity: (index: number) => number): SnippetTrackedGroup[] {
		const track = (start: number, end: number) => this.model.trackRange(Range.fromPositions(this.model.positionAt(start), this.model.positionAt(end)), TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
		const groups = snippet.placeholderGroups.map(group => ({
			index: identity(group.index),
			ranges: starts.flatMap(start => group.placeholders.map(placeholder => track(start + placeholder.startOffset, start + placeholder.endOffset))),
			...(group.choices ? { choices: group.choices } : {}),
		}));
		this.allGroups.push(...groups);
		this.transforms.push(...starts.flatMap(start => (snippet.transforms ?? []).map(transform => ({
			index: identity(transform.index), transform: transform.transform,
			range: track(start + transform.startOffset, start + transform.endOffset),
		}))));
		return groups;
	}

	/** Whether this session has released its tracked tabstops. */
	get isDisposed(): boolean { return super.isDisposed; }

	public getEnclosingRange(): Range | undefined {
		if (this.isDisposed || this.model.isDisposed() || this.editor.getModel() !== this.model) return undefined;
		const ranges = this.allGroups.flatMap(group => group.ranges);
		ranges.push(...this.transforms.map(transform => transform.range));
		// An explicit $0 owns the final stop even when literal text follows it.
		if (!this.groups.some(group => group.index === 0)) ranges.push(...this.finalRanges);
		let enclosing: Range | undefined;
		for (const tracked of ranges) {
			enclosing = enclosing ? enclosing.plusRange(tracked.range) : tracked.range;
		}
		return enclosing;
	}

	/** Advances to the next tabstop; Tab after an explicit final stop belongs to the editor. */
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
			if (this.groups[this.currentGroupIndex]!.index === 0) {
				this.dispose();
				return false;
			}
			this.synchronizeTransforms(this.groups[this.currentGroupIndex]!);
			this.editor.pushUndoStop();
			this.currentGroupIndex += 1;
			this.updateGroupStickiness(-1);
			this.editor.setSelections(this.finalRanges.map(range => Selection.fromPositions(range.range.getEndPosition())));
			return true;
		}
		this.dispose();
		return false;
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
		this.updateGroupStickiness(index);
		this.editor.setSelections(group.ranges.map(range => Selection.fromPositions(range.range.getStartPosition(), range.range.getEndPosition())));
	}

	private updateGroupStickiness(activeIndex: number): void {
		const active = this.groups[activeIndex];
		for (const group of this.allGroups) {
			// Only the active placeholder owns text typed at its edges. Inactive
			// neighbors must not absorb those edits when navigation returns to them.
			const stickiness = (group === active || active?.ancestors?.includes(group)) && group.index !== 0
				? TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges
				: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
			for (const [rangeIndex, tracked] of group.ranges.entries()) {
				if (tracked.stickiness === stickiness) continue;
				const range = tracked.range;
				tracked.dispose();
				group.ranges[rangeIndex] = this.model.trackRange(range, stickiness);
			}
		}
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
		const model = this.model;
		const edits = [group, ...(group.ancestors ?? [])].flatMap(source => {
			const range = source.ranges[0];
			if (!range) return [];
			const sourceText = model.getTextInRange(range.range);
			return this.transforms.filter(transform => transform.index === source.index).flatMap(transform => {
				const text = applySnippetTransform(sourceText, transform.transform);
				return model.getTextInRange(transform.range.range) === text ? [] : [{ range: transform.range.range, text }];
			});
		});
		if (edits.length) this.editor.executeEdits('snippet.transform', edits);
	}

}

interface SnippetTrackedGroup {
	ancestors?: readonly SnippetTrackedGroup[];
	readonly index: number;
	readonly ranges: TrackedRange[];
	readonly choices?: readonly string[];
}

interface SnippetTrackedTransform {
	readonly index: number;
	readonly transform: SnippetTransform;
	readonly range: TrackedRange;
}
