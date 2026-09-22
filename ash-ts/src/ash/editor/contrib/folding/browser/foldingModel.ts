import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type TrackedRange } from "../../../common/model/trackedRange.js";
import { EditorFoldingRangeSource, editorFoldingRangeKey, normalizeEditorFoldingRanges, validateEditorFoldingLineIndex, type EditorFoldingRange, type EditorFoldingRegion } from "./foldingRanges.js";
import { TrackedRangeStickiness } from '../../../common/model.js';
import type { IModelDecorationOptions, IModelDecorationsChangeAccessor } from '../../../common/model.js';

export interface IDecorationProvider {
	getDecorationOption(isCollapsed: boolean, isHidden: boolean, isManual: boolean): IModelDecorationOptions;
	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null;
	removeDecorations(decorationIds: string[]): void;
}

interface EditorFoldingRegionRecord {
	readonly range: TrackedRange;
	collapsed: boolean;
	readonly source: EditorFoldingRangeSource;
}

/**
 * Owns one editor's fold state independently from text and browser presentation.
 *
 * Ranges include their header and final physical lines. Collapsing a range hides
 * only the lines after its header. Callers replace provider ranges when language
 * analysis changes; the model retains manual ranges until their tracked text span
 * is deleted.
 */
export class EditorFoldingModel extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private records: readonly EditorFoldingRegionRecord[] = Object.freeze([]);

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor(private readonly textModel: TextModel) {
		super();
		this._register(toDisposable(() => disposeRecords(this.records)));
		this._register(textModel.onDidChangeContent(() => this.reconcileTrackedRanges()));
	}

	get model(): TextModel {
		return this.textModel;
	}

	/** Returns ordered, immutable current regions. */
	get regions(): readonly EditorFoldingRegion[] {
		return Object.freeze(this.records.map(record => this.toRegion(record)));
	}

	/** Replaces all known ranges after validating non-crossing physical-line spans. */
	setRanges(ranges: readonly EditorFoldingRange[]): void {
		const normalized = normalizeEditorFoldingRanges(this.textModel, ranges);
		const next = normalized.map(range => ({
			range: this.textModel.trackRange(
				Range.fromPositions(
					new Position((range.startLineIndex) + 1, (0) + 1),
					new Position((range.endLineIndex) + 1, (this.textModel.getLineContent((range.endLineIndex) + 1).length) + 1),
				),
				TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			),
			collapsed: range.collapsed,
			source: range.source,
		}));
		const previous = this.records;
		this.records = Object.freeze(next);
		disposeRecords(previous);
		this.changeEmitter.fire();
	}

	/** Replaces provider ranges while retaining manual ranges and matching collapsed state. */
	setProviderRanges(ranges: readonly EditorFoldingRange[]): void {
		if (!Array.isArray(ranges)) throw new TypeError("Folding ranges must be an array");
		const current = this.regions;
		const collapsedProviders = new Map(current
			.filter(region => region.source === EditorFoldingRangeSource.Provider)
			.map(region => [editorFoldingRangeKey(region), region.collapsed]));
		const manualRanges = current
			.filter(region => region.source === EditorFoldingRangeSource.Manual)
			.map(region => ({ ...region }));
		const providerRanges = ranges.map(range => ({
			...range,
			collapsed: collapsedProviders.get(editorFoldingRangeKey(range)) ?? range.collapsed ?? false,
			source: EditorFoldingRangeSource.Provider,
		}));
		this.setRanges([...manualRanges, ...providerRanges]);
	}

	/** Toggles the innermost fold whose header is exactly `lineIndex`. */
	toggleAtLine(lineIndex: number): EditorFoldingRegion | undefined {
		validateEditorFoldingLineIndex(this.textModel, lineIndex);
		const record = this.findRecord(candidate => candidate.range.range.startLineNumber - 1 === lineIndex);
		if (!record) return undefined;
		record.collapsed = !record.collapsed;
		const region = this.toRegion(record);
		this.changeEmitter.fire();
		return region;
	}

	/** Toggles the innermost fold containing `lineIndex`, as used by editor fold chords. */
	toggleContainingLine(lineIndex: number): EditorFoldingRegion | undefined {
		validateEditorFoldingLineIndex(this.textModel, lineIndex);
		const record = this.findRecord(candidate => {
				const range = candidate.range.range;
				return lineIndex >= range.startLineNumber - 1 && lineIndex <= range.endLineNumber - 1;
			});
		if (!record) return undefined;
		record.collapsed = !record.collapsed;
		const region = this.toRegion(record);
		this.changeEmitter.fire();
		return region;
	}

	/** Resolves all selected scopes before changing state, so repeated cursors fold a scope only once. */
	setContainingLinesCollapsed(lineIndexes: readonly number[], collapsed: boolean): void {
		if (typeof collapsed !== "boolean") throw new TypeError("Folding collapse state must be boolean");
		const targets = new Set<EditorFoldingRegionRecord>();
		for (const lineIndex of lineIndexes) {
			validateEditorFoldingLineIndex(this.textModel, lineIndex);
			const record = this.findRecord(candidate => {
				const range = candidate.range.range;
				return lineIndex >= range.startLineNumber - 1 && lineIndex <= range.endLineNumber - 1
					&& (!collapsed || !candidate.collapsed);
			});
			if (record && record.collapsed !== collapsed) targets.add(record);
		}
		for (const record of targets) record.collapsed = collapsed;
		if (targets.size > 0) this.changeEmitter.fire();
	}

	/** Collapses the innermost containing fold together with every nested descendant. */
	collapseContainingRegionRecursively(lineIndex: number): EditorFoldingRegion | undefined {
		return this.setContainingRegionRecursively(lineIndex, true);
	}

	/** Expands the innermost containing fold together with every nested descendant. */
	expandContainingRegionRecursively(lineIndex: number): EditorFoldingRegion | undefined {
		return this.setContainingRegionRecursively(lineIndex, false);
	}

	/** Creates one persistent manual range when it is nested within or disjoint from existing folds. */
	addManualRange(startLineIndex: number, endLineIndex: number): EditorFoldingRegion | undefined {
		validateEditorFoldingLineIndex(this.textModel, startLineIndex);
		validateEditorFoldingLineIndex(this.textModel, endLineIndex);
		if (endLineIndex <= startLineIndex || !this.canAddManualRange(startLineIndex, endLineIndex)) return undefined;
		const existingManual = this.records.find(record => {
			const range = record.range.range;
			return record.source === EditorFoldingRangeSource.Manual && range.startLineNumber - 1 === startLineIndex && range.endLineNumber - 1 === endLineIndex;
		});
		if (existingManual) {
			if (!existingManual.collapsed) {
				existingManual.collapsed = true;
				this.changeEmitter.fire();
			}
			return this.toRegion(existingManual);
		}
		const ranges = this.regions
			.filter(region => region.startLineIndex !== startLineIndex || region.endLineIndex !== endLineIndex)
			.map(region => ({ ...region }));
		ranges.push({ startLineIndex, endLineIndex, collapsed: true, source: EditorFoldingRangeSource.Manual });
		this.setRanges(ranges);
		return this.regions.find(region => region.source === EditorFoldingRangeSource.Manual && region.startLineIndex === startLineIndex && region.endLineIndex === endLineIndex);
	}

	/** Removes selected manual folds; an empty selection outside them removes all manual folds. */
	removeManualRanges(selections: readonly Range[]): void {
		const manual = this.records.filter(record => record.source === EditorFoldingRangeSource.Manual);
		const removed = new Set<EditorFoldingRegionRecord>();
		for (const selection of selections) {
			if (selection.isEmpty()) {
				const containing = this.findRecord(record => record.source === EditorFoldingRangeSource.Manual
					&& record.range.range.startLineNumber <= selection.startLineNumber
					&& record.range.range.endLineNumber >= selection.startLineNumber);
				if (containing) removed.add(containing);
				else for (const record of manual) removed.add(record);
			} else {
				for (const record of manual) {
					const range = record.range.range;
					if (range.startLineNumber <= selection.endLineNumber && range.endLineNumber >= selection.startLineNumber) {
						removed.add(record);
					}
				}
			}
		}
		if (removed.size === 0) return;
		this.records = Object.freeze(this.records.filter(record => !removed.has(record)));
		for (const record of removed) record.range.dispose();
		this.changeEmitter.fire();
	}

	/** Sets the collapse state of every current range. */
	setAllCollapsed(collapsed: boolean): boolean {
		if (typeof collapsed !== "boolean") throw new TypeError("Folding collapse state must be boolean");
		let changed = false;
		for (const record of this.records) {
			if (record.collapsed === collapsed) continue;
			record.collapsed = collapsed;
			changed = true;
		}
		if (changed) this.changeEmitter.fire();
		return changed;
	}

	/** Collapses one nesting level, preserving other levels and ranges containing a selected line. */
	collapseToLevel(level: number, selectedLineIndexes: readonly number[] = []): boolean {
		if (!Number.isSafeInteger(level) || level < 1) throw new RangeError("Folding level must be a positive safe integer");
		let changed = false;
		for (const record of this.records) {
			const range = record.range.range;
			if (record.collapsed || this.getNestingDepth(record) !== level) continue;
			if (selectedLineIndexes.some(line => line >= range.startLineNumber - 1 && line <= range.endLineNumber - 1)) continue;
			record.collapsed = true;
			changed = true;
		}
		if (changed) this.changeEmitter.fire();
		return changed;
	}

	private reconcileTrackedRanges(): void {
		const retained = this.records.filter(record => {
			const range = record.range.range;
			return range.getStartPosition().lineNumber < range.getEndPosition().lineNumber;
		});
		const normalized = normalizeRecords(retained);
		if (recordsEqual(this.records, normalized)) return;
		const removed = this.records.filter(record => !normalized.includes(record));
		this.records = Object.freeze(normalized);
		disposeRecords(removed);
		this.changeEmitter.fire();
	}

	private setContainingRegionRecursively(lineIndex: number, collapsed: boolean): EditorFoldingRegion | undefined {
		validateEditorFoldingLineIndex(this.textModel, lineIndex);
		const target = this.findRecord(candidate => {
			const range = candidate.range.range;
			return lineIndex >= range.startLineNumber - 1 && lineIndex <= range.endLineNumber - 1;
		});
		if (!target) return undefined;
		const targetRange = target.range.range;
		let changed = false;
		for (const candidate of this.records) {
			const range = candidate.range.range;
			if (range.getStartPosition().lineNumber < targetRange.getStartPosition().lineNumber || range.getEndPosition().lineNumber > targetRange.getEndPosition().lineNumber) continue;
			if (candidate.collapsed === collapsed) continue;
			candidate.collapsed = collapsed;
			changed = true;
		}
		if (changed) this.changeEmitter.fire();
		return this.toRegion(target);
	}

	private canAddManualRange(startLineIndex: number, endLineIndex: number): boolean {
		return this.records.every(record => {
			const range = record.range.range;
			const rangeStartLineIndex = range.startLineNumber - 1;
			const rangeEndLineIndex = range.endLineNumber - 1;
			const disjoint = endLineIndex < rangeStartLineIndex || startLineIndex > rangeEndLineIndex;
			const contains = startLineIndex <= rangeStartLineIndex && endLineIndex >= rangeEndLineIndex;
			const containedBy = startLineIndex >= rangeStartLineIndex && endLineIndex <= rangeEndLineIndex;
			return disjoint || contains || containedBy;
		});
	}

	private getNestingDepth(record: EditorFoldingRegionRecord): number {
		const range = record.range.range;
		return 1 + this.records.filter(candidate => {
			if (candidate === record) return false;
			const candidateRange = candidate.range.range;
			return candidateRange.getStartPosition().lineNumber <= range.getStartPosition().lineNumber && candidateRange.getEndPosition().lineNumber >= range.getEndPosition().lineNumber;
		}).length;
	}

	private toRegion(record: EditorFoldingRegionRecord): EditorFoldingRegion {
		const range = record.range.range;
		return Object.freeze({
			startLineIndex: range.startLineNumber - 1,
			endLineIndex: range.endLineNumber - 1,
			collapsed: record.collapsed,
			source: record.source,
		});
	}

	private findRecord(predicate: (candidate: EditorFoldingRegionRecord) => boolean): EditorFoldingRegionRecord | undefined {
		return this.records
			.filter(predicate)
			.sort((left, right) => {
				const leftRange = left.range.range;
				const rightRange = right.range.range;
				return leftRange.getEndPosition().lineNumber - leftRange.getStartPosition().lineNumber - (rightRange.getEndPosition().lineNumber - rightRange.getStartPosition().lineNumber);
			})[0];
	}
}

function normalizeRecords(records: readonly EditorFoldingRegionRecord[]): readonly EditorFoldingRegionRecord[] {
	const sorted = [...records].sort((left, right) => {
		const leftRange = left.range.range;
		const rightRange = right.range.range;
		return leftRange.getStartPosition().lineNumber - rightRange.getStartPosition().lineNumber || rightRange.getEndPosition().lineNumber - leftRange.getEndPosition().lineNumber;
	});
	const normalized: EditorFoldingRegionRecord[] = [];
	for (const record of sorted) {
		const previous = normalized.at(-1);
		if (previous) {
			const previousRange = previous.range.range;
			const range = record.range.range;
			if (range.getStartPosition().lineNumber <= previousRange.getEndPosition().lineNumber && range.getEndPosition().lineNumber > previousRange.getEndPosition().lineNumber) {
				record.range.dispose();
				continue;
			}
			if (range.getStartPosition().lineNumber === previousRange.getStartPosition().lineNumber && range.getEndPosition().lineNumber === previousRange.getEndPosition().lineNumber) {
				record.range.dispose();
				continue;
			}
		}
		normalized.push(record);
	}
	return normalized;
}

function recordsEqual(left: readonly EditorFoldingRegionRecord[], right: readonly EditorFoldingRegionRecord[]): boolean {
	return left.length === right.length && left.every((record, index) => record === right[index]);
}

function disposeRecords(records: readonly EditorFoldingRegionRecord[]): void {
	for (const record of records) record.range.dispose();
}
