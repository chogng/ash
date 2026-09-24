import { IEditorConfiguration } from '../config/editorConfiguration.js';
import { EditorOption } from '../config/editorOptions.js';
import { ICoordinatesConverter } from '../coordinatesConverter.js';
import { IModelDecoration } from '../model.js';

/** One resolved custom-height line. Kept as a public value object for layout diagnostics. */
export class CustomLine {
	public maximumSpecialHeight: number;
	public decorationId: string;
	public index: number;
	public lineNumber: number;
	public specialHeight: number;
	public prefixSum: number;
	public deleted = false;

	constructor(decorationId: string, index: number, lineNumber: number, specialHeight: number, prefixSum: number) {
		this.decorationId = decorationId;
		this.index = index;
		this.lineNumber = lineNumber;
		this.specialHeight = Math.round(specialHeight);
		this.maximumSpecialHeight = this.specialHeight;
		this.prefixSum = prefixSum;
	}
}

/**
 * Owns variable line-height ranges and projects them through line insert/delete changes.
 * The representation is intentionally range based: reads derive the visible maximum instead
 * of maintaining a second per-line index that can drift from decorations.
 */
export class LineHeightsManager {
	private readonly ranges = new Map<string, CustomLineHeightData>();
	private lineHeight: number;

	constructor(defaultLineHeight: number, customLineHeightData: CustomLineHeightData[]) {
		this.lineHeight = defaultLineHeight;
		for (const data of customLineHeightData) this.ranges.set(data.decorationId, data);
	}

	set defaultLineHeight(value: number) { this.lineHeight = value; }
	get defaultLineHeight(): number { return this.lineHeight; }

	removeCustomLineHeight(decorationId: string): void {
		this.ranges.delete(decorationId);
	}

	insertOrChangeCustomLineHeight(decorationId: string, startLineNumber: number, endLineNumber: number, lineHeight: number): void {
		const start = Math.max(1, Math.min(startLineNumber, endLineNumber));
		const end = Math.max(start, Math.max(startLineNumber, endLineNumber));
		this.ranges.set(decorationId, new CustomLineHeightData(decorationId, start, end, lineHeight));
	}

	heightForLineNumber(lineNumber: number): number {
		let resolved: number | undefined;
		for (const range of this.ranges.values()) {
			if (lineNumber < range.startLineNumber || lineNumber > range.endLineNumber) continue;
			resolved = resolved === undefined ? range.lineHeight : Math.max(resolved, range.lineHeight);
		}
		return resolved ?? this.lineHeight;
	}

	getAccumulatedLineHeightsIncludingLineNumber(lineNumber: number): number {
		if (lineNumber <= 0) return 0;
		const points = new Set<number>([1, lineNumber + 1]);
		for (const range of this.ranges.values()) {
			if (range.endLineNumber < 1 || range.startLineNumber > lineNumber) continue;
			points.add(Math.max(1, range.startLineNumber));
			points.add(Math.min(lineNumber + 1, range.endLineNumber + 1));
		}
		const ordered = [...points].sort((a, b) => a - b);
		let height = 0;
		for (let index = 0; index < ordered.length - 1; index++) {
			const start = ordered[index];
			const end = ordered[index + 1];
			height += (end - start) * this.heightForLineNumber(start);
		}
		return height;
	}

	onLinesDeleted(fromLineNumber: number, toLineNumber: number): void {
		const from = Math.min(fromLineNumber, toLineNumber);
		const to = Math.max(fromLineNumber, toLineNumber);
		const count = to - from + 1;
		for (const [id, range] of this.ranges) {
			if (range.endLineNumber < from) continue;
			if (range.startLineNumber > to) {
				this.ranges.set(id, moveRange(range, -count));
				continue;
			}
			let start: number;
			let end: number;
			if (range.startLineNumber < from) {
				start = range.startLineNumber;
				end = range.endLineNumber <= to ? from - 1 : range.endLineNumber - count;
			} else if (range.endLineNumber <= to) {
				start = from;
				end = from;
			} else {
				start = from;
				end = range.endLineNumber - count;
			}
			this.ranges.set(id, new CustomLineHeightData(id, start, Math.max(start, end), range.lineHeight));
		}
	}

	onLinesInserted(fromLineNumber: number, toLineNumber: number): void {
		const from = Math.min(fromLineNumber, toLineNumber);
		const count = Math.abs(toLineNumber - fromLineNumber) + 1;
		for (const [id, range] of this.ranges) {
			if (from <= range.startLineNumber) {
				this.ranges.set(id, moveRange(range, count));
			} else if (from <= range.endLineNumber) {
				this.ranges.set(id, new CustomLineHeightData(id, range.startLineNumber, range.endLineNumber + count, range.lineHeight));
			}
		}
	}
}

export class CustomLineHeightData {
	constructor(
		readonly decorationId: string,
		readonly startLineNumber: number,
		readonly endLineNumber: number,
		readonly lineHeight: number,
	) {}

	static fromDecorations(decorations: IModelDecoration[], coordinatesConverter: ICoordinatesConverter, configuration: IEditorConfiguration): CustomLineHeightData[] {
		const baseHeight = configuration.options.get(EditorOption.lineHeight);
		return decorations.map(decoration => {
			const range = coordinatesConverter.convertModelRangeToViewRange(decoration.range);
			return new CustomLineHeightData(
				decoration.id,
				range.startLineNumber,
				range.endLineNumber,
				(decoration.options.lineHeight ?? 0) * baseHeight,
			);
		});
	}
}

function moveRange(range: CustomLineHeightData, delta: number): CustomLineHeightData {
	return new CustomLineHeightData(range.decorationId, range.startLineNumber + delta, range.endLineNumber + delta, range.lineHeight);
}
