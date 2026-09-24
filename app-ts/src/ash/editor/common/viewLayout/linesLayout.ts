import * as strings from '../../../base/common/strings.js';
import type { IEditorWhitespace, ILineHeightChangeAccessor, IPartialViewLinesViewportData, IViewWhitespaceViewportData, IWhitespaceChangeAccessor } from '../viewModel.js';
import { CustomLineHeightData, LineHeightsManager } from './lineHeights.js';

interface IPendingChange { id: string; newAfterLineNumber: number; newHeight: number }
interface IPendingRemove { id: string }

class PendingChanges {
	private hasPending = false;
	private inserts: EditorWhitespace[] = [];
	private changes: IPendingChange[] = [];
	private removes: IPendingRemove[] = [];

	insert(value: EditorWhitespace): void { this.hasPending = true; this.inserts.push(value); }
	change(value: IPendingChange): void { this.hasPending = true; this.changes.push(value); }
	remove(value: IPendingRemove): void { this.hasPending = true; this.removes.push(value); }

	commit(linesLayout: LinesLayout): void {
		if (!this.hasPending) return;
		const inserts = this.inserts;
		const changes = this.changes;
		const removes = this.removes;
		this.hasPending = false;
		this.inserts = [];
		this.changes = [];
		this.removes = [];
		linesLayout._commitPendingChanges(inserts, changes, removes);
	}
}

export class EditorWhitespace implements IEditorWhitespace {
	prefixSum = 0;
	constructor(
		public id: string,
		public afterLineNumber: number,
		public ordinal: number,
		public height: number,
		public minWidth: number,
	) {}
}

/** Owns the vertical layout of model lines and whitespace zones. */
export class LinesLayout {
	private static INSTANCE_COUNT = 0;
	private readonly instanceId: string;
	private readonly pendingChanges = new PendingChanges();
	private lastWhitespaceId = 0;
	private whitespaces: EditorWhitespace[] = [];
	private prefixSumValidIndex = -1;
	private minWidth = -1;
	private lineHeightsManager: LineHeightsManager;

	constructor(
		private lineCount: number,
		defaultLineHeight: number,
		private paddingTop: number,
		private paddingBottom: number,
		customLineHeightData: CustomLineHeightData[],
	) {
		this.instanceId = strings.singleLetterHash(++LinesLayout.INSTANCE_COUNT);
		this.lineHeightsManager = new LineHeightsManager(defaultLineHeight, customLineHeightData);
	}

	public static findInsertionIndex(arr: EditorWhitespace[], afterLineNumber: number, ordinal: number): number {
		let low = 0;
		let high = arr.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const candidate = arr[middle]!;
			if (afterLineNumber < candidate.afterLineNumber || (afterLineNumber === candidate.afterLineNumber && ordinal < candidate.ordinal)) high = middle;
			else low = middle + 1;
		}
		return low;
	}

	setDefaultLineHeight(lineHeight: number): void { this.lineHeightsManager.defaultLineHeight = lineHeight; }
	setPadding(paddingTop: number, paddingBottom: number): void { this.paddingTop = paddingTop; this.paddingBottom = paddingBottom; }

	onFlushed(lineCount: number, customLineHeightData: CustomLineHeightData[]): void {
		this.lineCount = lineCount;
		this.lineHeightsManager = new LineHeightsManager(this.lineHeightsManager.defaultLineHeight, customLineHeightData);
	}

	changeLineHeights(callback: (accessor: ILineHeightChangeAccessor) => void): boolean {
		let hadAChange = false;
		callback({
			insertOrChangeCustomLineHeight: (decorationId, startLineNumber, endLineNumber, lineHeight) => {
				hadAChange = true;
				this.lineHeightsManager.insertOrChangeCustomLineHeight(decorationId, startLineNumber, endLineNumber, lineHeight);
			},
			removeCustomLineHeight: decorationId => {
				hadAChange = true;
				this.lineHeightsManager.removeCustomLineHeight(decorationId);
			},
		});
		return hadAChange;
	}

	changeWhitespace(callback: (accessor: IWhitespaceChangeAccessor) => void): boolean {
		let hadAChange = false;
		try {
			callback({
				insertWhitespace: (afterLineNumber, ordinal, heightInPx, minWidth) => {
					hadAChange = true;
					const id = this.instanceId + (++this.lastWhitespaceId);
					this.pendingChanges.insert(new EditorWhitespace(id, afterLineNumber | 0, ordinal | 0, heightInPx | 0, minWidth | 0));
					return id;
				},
				changeOneWhitespace: (id, newAfterLineNumber, newHeight) => {
					hadAChange = true;
					this.pendingChanges.change({ id, newAfterLineNumber: newAfterLineNumber | 0, newHeight: newHeight | 0 });
				},
				removeWhitespace: id => {
					hadAChange = true;
					this.pendingChanges.remove({ id });
				},
			});
		} finally {
			this.pendingChanges.commit(this);
		}
		return hadAChange;
	}

	_commitPendingChanges(inserts: EditorWhitespace[], changes: IPendingChange[], removes: IPendingRemove[]): void {
		if (inserts.length > 0 || removes.length > 0) this.minWidth = -1;
		if (inserts.length + changes.length + removes.length <= 1) {
			for (const insert of inserts) this.insertWhitespace(insert);
			for (const change of changes) this.changeOneWhitespace(change.id, change.newAfterLineNumber, change.newHeight);
			for (const remove of removes) {
				const index = this.findWhitespaceIndex(remove.id);
				if (index >= 0) this.removeWhitespace(index);
			}
			return;
		}
		const idsToRemove = new Set(removes.map(remove => remove.id));
		const changesById = new Map(changes.map(change => [change.id, change]));
		const apply = (values: EditorWhitespace[]): EditorWhitespace[] => values.flatMap(whitespace => {
			if (idsToRemove.has(whitespace.id)) return [];
			const change = changesById.get(whitespace.id);
			if (change) {
				whitespace.afterLineNumber = change.newAfterLineNumber;
				whitespace.height = change.newHeight;
			}
			return [whitespace];
		});
		this.whitespaces = apply(this.whitespaces).concat(apply(inserts)).sort((a, b) => a.afterLineNumber - b.afterLineNumber || a.ordinal - b.ordinal);
		this.prefixSumValidIndex = -1;
	}

	private insertWhitespace(whitespace: EditorWhitespace): void {
		const index = LinesLayout.findInsertionIndex(this.whitespaces, whitespace.afterLineNumber, whitespace.ordinal);
		this.whitespaces.splice(index, 0, whitespace);
		this.prefixSumValidIndex = Math.min(this.prefixSumValidIndex, index - 1);
	}

	private findWhitespaceIndex(id: string): number { return this.whitespaces.findIndex(whitespace => whitespace.id === id); }

	private changeOneWhitespace(id: string, newAfterLineNumber: number, newHeight: number): void {
		const index = this.findWhitespaceIndex(id);
		if (index < 0) return;
		const whitespace = this.whitespaces[index]!;
		if (whitespace.height !== newHeight) {
			whitespace.height = newHeight;
			this.prefixSumValidIndex = Math.min(this.prefixSumValidIndex, index - 1);
		}
		if (whitespace.afterLineNumber === newAfterLineNumber) return;
		this.removeWhitespace(index);
		whitespace.afterLineNumber = newAfterLineNumber;
		this.insertWhitespace(whitespace);
	}

	private removeWhitespace(index: number): void {
		this.whitespaces.splice(index, 1);
		this.prefixSumValidIndex = Math.min(this.prefixSumValidIndex, index - 1);
	}

	onLinesDeleted(fromLineNumber: number, toLineNumber: number): void {
		fromLineNumber |= 0;
		toLineNumber |= 0;
		const count = toLineNumber - fromLineNumber + 1;
		this.lineCount -= count;
		for (const whitespace of this.whitespaces) {
			if (fromLineNumber <= whitespace.afterLineNumber && whitespace.afterLineNumber <= toLineNumber) whitespace.afterLineNumber = fromLineNumber - 1;
			else if (whitespace.afterLineNumber > toLineNumber) whitespace.afterLineNumber -= count;
		}
		this.lineHeightsManager.onLinesDeleted(fromLineNumber, toLineNumber);
	}

	onLinesInserted(fromLineNumber: number, toLineNumber: number): void {
		fromLineNumber |= 0;
		toLineNumber |= 0;
		const count = toLineNumber - fromLineNumber + 1;
		this.lineCount += count;
		for (const whitespace of this.whitespaces) if (fromLineNumber <= whitespace.afterLineNumber) whitespace.afterLineNumber += count;
		this.lineHeightsManager.onLinesInserted(fromLineNumber, toLineNumber);
	}

	getWhitespacesTotalHeight(): number {
		return this.whitespaces.length === 0 ? 0 : this.getWhitespacesAccumulatedHeight(this.whitespaces.length - 1);
	}

	getWhitespacesAccumulatedHeight(index: number): number {
		index |= 0;
		let startIndex = Math.max(0, this.prefixSumValidIndex + 1);
		if (startIndex === 0) {
			this.whitespaces[0]!.prefixSum = this.whitespaces[0]!.height;
			startIndex++;
		}
		for (let i = startIndex; i <= index; i++) this.whitespaces[i]!.prefixSum = this.whitespaces[i - 1]!.prefixSum + this.whitespaces[i]!.height;
		this.prefixSumValidIndex = Math.max(this.prefixSumValidIndex, index);
		return this.whitespaces[index]!.prefixSum;
	}

	getLinesTotalHeight(): number {
		return this.lineHeightsManager.getAccumulatedLineHeightsIncludingLineNumber(this.lineCount) + this.getWhitespacesTotalHeight() + this.paddingTop + this.paddingBottom;
	}

	getWhitespaceAccumulatedHeightBeforeLineNumber(lineNumber: number): number {
		const index = this.findLastWhitespaceBeforeLineNumber(lineNumber | 0);
		return index < 0 ? 0 : this.getWhitespacesAccumulatedHeight(index);
	}

	private findLastWhitespaceBeforeLineNumber(lineNumber: number): number {
		let low = 0;
		let high = this.whitespaces.length - 1;
		while (low <= high) {
			const middle = low + ((high - low) >> 1);
			if (this.whitespaces[middle]!.afterLineNumber < lineNumber) {
				if (middle + 1 >= this.whitespaces.length || this.whitespaces[middle + 1]!.afterLineNumber >= lineNumber) return middle;
				low = middle + 1;
			} else high = middle - 1;
		}
		return -1;
	}

	private findFirstWhitespaceAfterLineNumber(lineNumber: number): number {
		const index = this.findLastWhitespaceBeforeLineNumber(lineNumber) + 1;
		return index < this.whitespaces.length ? index : -1;
	}

	getFirstWhitespaceIndexAfterLineNumber(lineNumber: number): number { return this.findFirstWhitespaceAfterLineNumber(lineNumber | 0); }

	getVerticalOffsetForLineNumber(lineNumber: number, includeViewZones = false): number {
		lineNumber |= 0;
		const lineHeight = lineNumber > 1 ? this.lineHeightsManager.getAccumulatedLineHeightsIncludingLineNumber(lineNumber - 1) : 0;
		return lineHeight + this.getWhitespaceAccumulatedHeightBeforeLineNumber(lineNumber - (includeViewZones ? 1 : 0)) + this.paddingTop;
	}

	getLineHeightForLineNumber(lineNumber: number): number { return this.lineHeightsManager.heightForLineNumber(lineNumber); }

	getVerticalOffsetAfterLineNumber(lineNumber: number, includeViewZones = false): number {
		lineNumber |= 0;
		return this.lineHeightsManager.getAccumulatedLineHeightsIncludingLineNumber(lineNumber) + this.getWhitespaceAccumulatedHeightBeforeLineNumber(lineNumber + (includeViewZones ? 1 : 0)) + this.paddingTop;
	}

	hasWhitespace(): boolean { return this.whitespaces.length > 0; }

	getWhitespaceMinWidth(): number {
		if (this.minWidth === -1) this.minWidth = this.whitespaces.reduce((maximum, whitespace) => Math.max(maximum, whitespace.minWidth), 0);
		return this.minWidth;
	}

	isAfterLines(verticalOffset: number): boolean { return verticalOffset > this.getLinesTotalHeight(); }
	isInTopPadding(verticalOffset: number): boolean { return this.paddingTop !== 0 && verticalOffset < this.paddingTop; }
	isInBottomPadding(verticalOffset: number): boolean { return this.paddingBottom !== 0 && verticalOffset >= this.getLinesTotalHeight() - this.paddingBottom; }

	getLineNumberAtOrAfterVerticalOffset(verticalOffset: number): number {
		verticalOffset |= 0;
		if (verticalOffset < 0) return 1;
		let minimum = 1;
		let maximum = this.lineCount;
		while (minimum < maximum) {
			const middle = ((minimum + maximum) / 2) | 0;
			const top = this.getVerticalOffsetForLineNumber(middle) | 0;
			if (verticalOffset >= top + this.getLineHeightForLineNumber(middle)) minimum = middle + 1;
			else if (verticalOffset >= top) return middle;
			else maximum = middle;
		}
		return Math.min(minimum, this.lineCount);
	}

	getLinesViewportData(verticalOffset1: number, verticalOffset2: number): IPartialViewLinesViewportData {
		verticalOffset1 |= 0;
		verticalOffset2 |= 0;
		const startLineNumber = this.getLineNumberAtOrAfterVerticalOffset(verticalOffset1) | 0;
		const startTop = this.getVerticalOffsetForLineNumber(startLineNumber) | 0;
		let endLineNumber = this.lineCount | 0;
		let whitespaceIndex = this.getFirstWhitespaceIndexAfterLineNumber(startLineNumber) | 0;
		const whitespaceCount = this.getWhitespacesCount() | 0;
		let whitespaceAfterLineNumber: number;
		let whitespaceHeight: number;
		if (whitespaceIndex === -1) {
			whitespaceIndex = whitespaceCount;
			whitespaceAfterLineNumber = endLineNumber + 1;
			whitespaceHeight = 0;
		} else {
			whitespaceAfterLineNumber = this.getAfterLineNumberForWhitespaceIndex(whitespaceIndex) | 0;
			whitespaceHeight = this.getHeightForWhitespaceIndex(whitespaceIndex) | 0;
		}
		let currentVerticalOffset = startTop;
		let currentLineRelativeOffset = currentVerticalOffset;
		const stepSize = 500_000;
		let bigNumbersDelta = 0;
		if (startTop >= stepSize) {
			bigNumbersDelta = Math.floor(startTop / stepSize) * stepSize;
			bigNumbersDelta = Math.floor(bigNumbersDelta / this.lineHeightsManager.defaultLineHeight) * this.lineHeightsManager.defaultLineHeight;
			currentLineRelativeOffset -= bigNumbersDelta;
		}
		const relativeVerticalOffset: number[] = [];
		const verticalCenter = verticalOffset1 + (verticalOffset2 - verticalOffset1) / 2;
		let centeredLineNumber = -1;
		for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
			const lineHeight = this.getLineHeightForLineNumber(lineNumber);
			if (centeredLineNumber === -1 && ((currentVerticalOffset <= verticalCenter && verticalCenter < currentVerticalOffset + lineHeight) || currentVerticalOffset > verticalCenter)) centeredLineNumber = lineNumber;
			currentVerticalOffset += lineHeight;
			relativeVerticalOffset[lineNumber - startLineNumber] = currentLineRelativeOffset;
			currentLineRelativeOffset += lineHeight;
			while (whitespaceAfterLineNumber === lineNumber) {
				currentLineRelativeOffset += whitespaceHeight;
				currentVerticalOffset += whitespaceHeight;
				whitespaceIndex++;
				if (whitespaceIndex >= whitespaceCount) whitespaceAfterLineNumber = endLineNumber + 1;
				else {
					whitespaceAfterLineNumber = this.getAfterLineNumberForWhitespaceIndex(whitespaceIndex) | 0;
					whitespaceHeight = this.getHeightForWhitespaceIndex(whitespaceIndex) | 0;
				}
			}
			if (currentVerticalOffset >= verticalOffset2) { endLineNumber = lineNumber; break; }
		}
		if (centeredLineNumber === -1) centeredLineNumber = endLineNumber;
		const endTop = this.getVerticalOffsetForLineNumber(endLineNumber) | 0;
		let completelyVisibleStartLineNumber = startLineNumber;
		let completelyVisibleEndLineNumber = endLineNumber;
		if (completelyVisibleStartLineNumber < completelyVisibleEndLineNumber && startTop < verticalOffset1) completelyVisibleStartLineNumber++;
		if (completelyVisibleStartLineNumber < completelyVisibleEndLineNumber && endTop + this.getLineHeightForLineNumber(endLineNumber) > verticalOffset2) completelyVisibleEndLineNumber--;
		return { bigNumbersDelta, startLineNumber, endLineNumber, relativeVerticalOffset, centeredLineNumber, completelyVisibleStartLineNumber, completelyVisibleEndLineNumber, lineHeight: this.lineHeightsManager.defaultLineHeight };
	}

	getVerticalOffsetForWhitespaceIndex(whitespaceIndex: number): number {
		whitespaceIndex |= 0;
		const afterLineNumber = this.getAfterLineNumberForWhitespaceIndex(whitespaceIndex);
		const linesHeight = afterLineNumber >= 1 ? this.lineHeightsManager.getAccumulatedLineHeightsIncludingLineNumber(afterLineNumber) : 0;
		const whitespaceHeight = whitespaceIndex > 0 ? this.getWhitespacesAccumulatedHeight(whitespaceIndex - 1) : 0;
		return linesHeight + whitespaceHeight + this.paddingTop;
	}

	getWhitespaceIndexAtOrAfterVerticallOffset(verticalOffset: number): number {
		verticalOffset |= 0;
		let minimum = 0;
		let maximum = this.whitespaces.length - 1;
		if (maximum < 0) return -1;
		if (verticalOffset >= this.getVerticalOffsetForWhitespaceIndex(maximum) + this.getHeightForWhitespaceIndex(maximum)) return -1;
		while (minimum < maximum) {
			const middle = Math.floor((minimum + maximum) / 2);
			const top = this.getVerticalOffsetForWhitespaceIndex(middle);
			const height = this.getHeightForWhitespaceIndex(middle);
			if (verticalOffset >= top + height) minimum = middle + 1;
			else if (verticalOffset >= top) return middle;
			else maximum = middle;
		}
		return minimum;
	}

	getWhitespaceAtVerticalOffset(verticalOffset: number): IViewWhitespaceViewportData | null {
		const index = this.getWhitespaceIndexAtOrAfterVerticallOffset(verticalOffset);
		if (index < 0 || index >= this.whitespaces.length) return null;
		const verticalOffsetForWhitespace = this.getVerticalOffsetForWhitespaceIndex(index);
		if (verticalOffsetForWhitespace > verticalOffset) return null;
		return { id: this.getIdForWhitespaceIndex(index), afterLineNumber: this.getAfterLineNumberForWhitespaceIndex(index), verticalOffset: verticalOffsetForWhitespace, height: this.getHeightForWhitespaceIndex(index) };
	}

	getWhitespaceViewportData(verticalOffset1: number, verticalOffset2: number): IViewWhitespaceViewportData[] {
		const startIndex = this.getWhitespaceIndexAtOrAfterVerticallOffset(verticalOffset1);
		if (startIndex < 0) return [];
		const result: IViewWhitespaceViewportData[] = [];
		for (let index = startIndex; index < this.whitespaces.length; index++) {
			const verticalOffset = this.getVerticalOffsetForWhitespaceIndex(index);
			if (verticalOffset >= verticalOffset2) break;
			result.push({ id: this.getIdForWhitespaceIndex(index), afterLineNumber: this.getAfterLineNumberForWhitespaceIndex(index), verticalOffset, height: this.getHeightForWhitespaceIndex(index) });
		}
		return result;
	}

	getWhitespaces(): IEditorWhitespace[] { return this.whitespaces.slice(); }
	getWhitespacesCount(): number { return this.whitespaces.length; }
	getIdForWhitespaceIndex(index: number): string { return this.whitespaces[index | 0]!.id; }
	getAfterLineNumberForWhitespaceIndex(index: number): number { return this.whitespaces[index | 0]!.afterLineNumber; }
	getHeightForWhitespaceIndex(index: number): number { return this.whitespaces[index | 0]!.height; }
}
