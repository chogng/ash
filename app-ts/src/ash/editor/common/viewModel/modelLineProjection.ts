import { isNonEmptyArray } from "../../../base/common/arrays.js";
import { Position } from "../core/position.js";
import { getLineTokensWithInjections, type TextModel } from "../model/textModel.js";
import { PositionAffinity } from "../model.js";
import { type InjectedText, type ModelLineProjectionData } from "../modelLineProjectionData.js";
import { ViewLineData } from "../viewModel.js";
import { getTextGraphemeBoundaries } from "../core/textSegmentation.js";
import { InjectedTextInlineDecorationsComputer } from "./inlineDecorations.js";

/** One fixed-height visual row projected from a logical TextModel line. */
export interface EditorVisualLine {
	readonly visualLineIndex: number;
	readonly logicalLineIndex: number;
	readonly startColumn: number;
	readonly endColumn: number;
	readonly firstForLogicalLine: boolean;
	readonly lastForLogicalLine: boolean;
	/** Pixel width reserved before text on a wrapped continuation row. */
	readonly wrappedTextIndentWidth?: number;
	readonly outputLineIndex?: number;
	readonly projectionData?: ModelLineProjectionData;
}

/** Immutable source-to-visual-line mapping for one exact TextModel version. */
export class EditorVisualLineProjection {
	private constructor(
		readonly modelVersion: number,
		readonly logicalLineCount: number,
		private readonly projectedLines: readonly EditorVisualLine[] | undefined,
		private readonly visualLineStarts: readonly number[] | undefined,
		private readonly logicalLineVisibility: readonly boolean[] | undefined,
		private readonly identityModel: TextModel | undefined,
	) {
		Object.freeze(this);
	}

	/** Builds an unwrapped one-to-one projection without materializing one object per logical line. */
	static identity(model: TextModel): EditorVisualLineProjection {
		return new EditorVisualLineProjection(model.version, model.lineCount, undefined, undefined, undefined, model);
	}

	/** Builds a projection from one final visual segment end-column list per logical line. */
	static fromBreakColumns(model: TextModel, breakColumnsByLine: readonly (readonly number[])[], wrappedTextIndentWidthsByLine?: readonly number[]): EditorVisualLineProjection {
		if (!Array.isArray(breakColumnsByLine) || breakColumnsByLine.length !== model.lineCount) {
			throw new RangeError("Visual line break columns must contain one entry for every logical line");
		}
		if (wrappedTextIndentWidthsByLine !== undefined && (!Array.isArray(wrappedTextIndentWidthsByLine) || wrappedTextIndentWidthsByLine.length !== model.lineCount)) {
			throw new RangeError("Visual line wrapped-text indent widths must contain one entry for every logical line");
		}
		const lines: EditorVisualLine[] = [];
		const visualLineStarts: number[] = [];
		for (let logicalLineIndex = 0; logicalLineIndex < model.lineCount; logicalLineIndex += 1) {
			const text = model.getLineContent((logicalLineIndex) + 1);
			const breaks = breakColumnsByLine[logicalLineIndex];
			if (!breaks) throw new RangeError("Visual line break columns must not contain holes");
			validateBreakColumns(text, breaks);
			const wrappedTextIndentWidth = wrappedTextIndentWidthsByLine?.[logicalLineIndex] === undefined
				? 0
				: wrappedTextIndentWidthsByLine[logicalLineIndex]!;
			validateWrappedTextIndentWidth(wrappedTextIndentWidth);
			visualLineStarts.push(lines.length);
			let startColumn = 0;
			for (let index = 0; index < breaks.length; index += 1) {
				const endColumn = breaks[index]!;
				lines.push(Object.freeze({
					visualLineIndex: lines.length,
					logicalLineIndex,
					startColumn,
					endColumn,
					firstForLogicalLine: index === 0,
					lastForLogicalLine: index + 1 === breaks.length,
					...(index > 0 && wrappedTextIndentWidth > 0 ? { wrappedTextIndentWidth } : {}),
				}));
				startColumn = endColumn;
			}
		}
		return new EditorVisualLineProjection(
			model.version,
			model.lineCount,
			Object.freeze(lines),
			Object.freeze(visualLineStarts),
			Object.freeze(Array.from({ length: model.lineCount }, () => true)),
			undefined,
		);
	}

	static fromLineBreakData(model: TextModel, lineBreakData: readonly (ModelLineProjectionData | null)[], spaceWidth: number): EditorVisualLineProjection {
		if (lineBreakData.length !== model.lineCount) throw new RangeError("Line-break data must contain one entry for every model line");
		if (!Number.isFinite(spaceWidth) || spaceWidth <= 0) throw new RangeError("Projection space width must be positive");
		if (lineBreakData.every(value => value === null)) return EditorVisualLineProjection.identity(model);
		const lines: EditorVisualLine[] = [];
		const starts: number[] = [];
		for (let logicalLineIndex = 0; logicalLineIndex < model.lineCount; logicalLineIndex += 1) {
			starts.push(lines.length);
			const data = lineBreakData[logicalLineIndex];
			if (!data) {
				lines.push(Object.freeze({ visualLineIndex: lines.length, logicalLineIndex, startColumn: 0, endColumn: model.getLineLength(logicalLineIndex + 1), firstForLogicalLine: true, lastForLogicalLine: true }));
				continue;
			}
			for (let outputLineIndex = 0; outputLineIndex < data.getOutputLineCount(); outputLineIndex += 1) {
				lines.push(Object.freeze({
					visualLineIndex: lines.length,
					logicalLineIndex,
					startColumn: data.translateToInputOffset(outputLineIndex, data.getMinOutputOffset(outputLineIndex)),
					endColumn: data.translateToInputOffset(outputLineIndex, data.getMaxOutputOffset(outputLineIndex)),
					firstForLogicalLine: outputLineIndex === 0,
					lastForLogicalLine: outputLineIndex + 1 === data.getOutputLineCount(),
					outputLineIndex,
					projectionData: data,
					...(outputLineIndex > 0 && data.wrappedTextIndentLength > 0 ? { wrappedTextIndentWidth: data.wrappedTextIndentLength * spaceWidth } : {}),
				}));
			}
		}
		return new EditorVisualLineProjection(model.version, model.lineCount, Object.freeze(lines), Object.freeze(starts), Object.freeze(Array.from({ length: model.lineCount }, () => true)), undefined);
	}

	/**
	 * Builds a visual projection whose lines may omit folded logical lines.
	 *
	 * Every logical line supplies a visible visual-row anchor. A hidden line's
	 * anchor is normally its collapsed header's final row, allowing consumers to
	 * handle stale selections until their owner reveals or relocates them.
	 */
	static fromVisibleLines(modelVersion: number, logicalLineCount: number, lines: readonly EditorVisualLine[], visualLineIndexes: readonly number[]): EditorVisualLineProjection {
		if (!Number.isSafeInteger(modelVersion) || modelVersion < 0) throw new RangeError("Visual projection model version must be a non-negative safe integer");
		if (!Number.isSafeInteger(logicalLineCount) || logicalLineCount < 1) throw new RangeError("Visual projection logical line count must be a positive safe integer");
		if (!Array.isArray(visualLineIndexes) || visualLineIndexes.length !== logicalLineCount) {
			throw new RangeError("Visible visual-line anchors must contain one entry for every logical line");
		}
		const visibility = Array.from({ length: logicalLineCount }, () => false);
		const starts = Array.from({ length: logicalLineCount }, () => -1);
		const normalized = lines.map((line, visualLineIndex) => {
			if (!line || typeof line !== "object") throw new TypeError("Visible visual line must be an object");
			validateLogicalLineIndex(line.logicalLineIndex, logicalLineCount);
			if (!Number.isSafeInteger(line.startColumn) || !Number.isSafeInteger(line.endColumn) || line.startColumn < 0 || line.endColumn < line.startColumn) {
				throw new RangeError("Visible visual line columns must be ordered non-negative safe integers");
			}
			const wrappedTextIndentWidth = line.wrappedTextIndentWidth === undefined
				? 0
				: line.wrappedTextIndentWidth;
			validateWrappedTextIndentWidth(wrappedTextIndentWidth);
			if (starts[line.logicalLineIndex] === -1) starts[line.logicalLineIndex] = visualLineIndex;
			visibility[line.logicalLineIndex] = true;
			return Object.freeze({
				visualLineIndex,
				logicalLineIndex: line.logicalLineIndex,
				startColumn: line.startColumn,
				endColumn: line.endColumn,
				firstForLogicalLine: line.firstForLogicalLine,
				lastForLogicalLine: line.lastForLogicalLine,
				...(wrappedTextIndentWidth > 0 ? { wrappedTextIndentWidth } : {}),
				...(line.outputLineIndex === undefined ? {} : { outputLineIndex: line.outputLineIndex }),
				...(line.projectionData === undefined ? {} : { projectionData: line.projectionData }),
			});
		});
		for (let logicalLineIndex = 0; logicalLineIndex < logicalLineCount; logicalLineIndex += 1) {
			const visualLineIndex = visualLineIndexes[logicalLineIndex];
			if (!Number.isSafeInteger(visualLineIndex) || visualLineIndex < 0 || visualLineIndex >= normalized.length) {
				throw new RangeError("Visible visual-line anchor is outside the projected lines");
			}
			if (visibility[logicalLineIndex] && starts[logicalLineIndex] !== visualLineIndex) {
				throw new RangeError("Visible logical line anchor must point to its first visual row");
			}
		}
		return new EditorVisualLineProjection(
			modelVersion,
			logicalLineCount,
			Object.freeze(normalized),
			Object.freeze(visualLineIndexes.slice()),
			Object.freeze(visibility),
			undefined,
		);
	}

	get lines(): readonly EditorVisualLine[] {
		if (this.projectedLines) return this.projectedLines;
		const cached = identityLineCache.get(this);
		if (cached) return cached;
		const lines = Object.freeze(Array.from({ length: this.logicalLineCount }, (_, lineIndex) => this.identityLineAt(lineIndex)));
		identityLineCache.set(this, lines);
		return lines;
	}

	get visualLineCount(): number {
		return this.projectedLines?.length ?? this.logicalLineCount;
	}

	lineAt(visualLineIndex: number): EditorVisualLine | undefined {
		if (this.projectedLines) return this.projectedLines[visualLineIndex];
		return Number.isSafeInteger(visualLineIndex) && visualLineIndex >= 0 && visualLineIndex < this.logicalLineCount
			? this.identityLineAt(visualLineIndex)
			: undefined;
	}

	getViewLineData(model: TextModel, viewLineNumber: number): ViewLineData {
		const line = this.lineAt(viewLineNumber - 1);
		if (!line) throw new RangeError("View line number is outside the projection");
		const modelLineNumber = line.logicalLineIndex + 1;
		const data = line.projectionData;
		if (!data) {
			const lineTokens = model.tokenization.getLineTokens(modelLineNumber);
			const content = lineTokens.getLineContent().slice(line.startColumn, line.endColumn);
			const tokens = lineTokens.sliceAndInflate(line.startColumn, line.endColumn, -line.startColumn);
			return new ViewLineData(content, !line.lastForLogicalLine, 1, content.length + 1, 0, tokens, null);
		}
		const outputLineIndex = line.outputLineIndex!;
		const injectedTokens = getLineTokensWithInjections(model.tokenization.getLineTokens(modelLineNumber), data.injectionOptions, data.injectionOffsets);
		const start = outputLineIndex > 0 ? data.breakOffsets[outputLineIndex - 1]! : 0;
		const end = data.breakOffsets[outputLineIndex]!;
		const indent = outputLineIndex > 0 ? data.wrappedTextIndentLength : 0;
		const tokens = injectedTokens.sliceAndInflate(start, end, indent);
		const content = `${" ".repeat(indent)}${tokens.getLineContent()}`;
		const firstViewLineNumber = this.firstVisualLineIndex(line.logicalLineIndex) + 1;
		const inlineDecorations = new InjectedTextInlineDecorationsComputer({
			getInjectionOptions: () => data.injectionOptions,
			getInjectionOffsets: () => data.injectionOffsets,
			getBreakOffsets: () => data.breakOffsets,
			getWrappedTextIndentLength: () => data.wrappedTextIndentLength,
			getBaseViewLineNumber: () => firstViewLineNumber,
		}).getInlineDecorations(modelLineNumber)[outputLineIndex] ?? null;
		return new ViewLineData(
			content,
			outputLineIndex + 1 < data.getOutputLineCount(),
			data.getMinOutputOffset(outputLineIndex) + 1,
			content.length + 1,
			outputLineIndex === 0 ? 0 : data.breakOffsetsVisibleColumn[outputLineIndex - 1] ?? 0,
			tokens,
			inlineDecorations,
		);
	}

	convertViewPositionToModelPosition(position: Position): Position {
		const line = this.lineAt(position.lineNumber - 1);
		if (!line) throw new RangeError("View position is outside the projection");
		const column = line.projectionData
			? line.projectionData.translateToInputOffset(line.outputLineIndex!, position.column - 1) + 1
			: line.startColumn + position.column;
		return new Position(line.logicalLineIndex + 1, column);
	}

	convertModelPositionToViewPosition(position: Position, affinity: PositionAffinity = PositionAffinity.None): Position {
		const visualLineIndex = this.visualLineIndexAt(position);
		const line = this.lineAt(visualLineIndex)!;
		if (line.projectionData) {
			return line.projectionData.translateToOutputPosition(position.column - 1, affinity).toPosition(this.firstVisualLineIndex(line.logicalLineIndex) + 1);
		}
		return new Position(visualLineIndex + 1, position.column - line.startColumn);
	}

	getInjectedTextAt(position: Position): InjectedText | null {
		const line = this.lineAt(position.lineNumber - 1);
		return line?.projectionData?.getInjectedText(line.outputLineIndex!, position.column - 1) ?? null;
	}

	normalizePosition(position: Position, affinity: PositionAffinity): Position {
		const line = this.lineAt(position.lineNumber - 1);
		if (!line?.projectionData) return position;
		return line.projectionData.normalizeOutputPosition(line.outputLineIndex!, position.column - 1, affinity).toPosition(this.firstVisualLineIndex(line.logicalLineIndex) + 1);
	}

	firstVisualLineIndex(logicalLineIndex: number): number {
		validateLogicalLineIndex(logicalLineIndex, this.logicalLineCount);
		return this.visualLineStarts?.[logicalLineIndex] ?? logicalLineIndex;
	}

	visualLineIndexAt(position: Position): number {
		const logicalLineIndex = position.lineNumber - 1;
		const columnIndex = position.column - 1;
		validateLogicalLineIndex(logicalLineIndex, this.logicalLineCount);
		if (this.identityModel) return logicalLineIndex;
		const first = this.firstVisualLineIndex(logicalLineIndex);
		if (!this.logicalLineVisibility![logicalLineIndex]) return first;
		const lastExclusive = logicalLineIndex + 1 < this.logicalLineCount
			? this.nextVisualLineIndex(logicalLineIndex + 1)
			: this.visualLineCount;
		for (let visualLineIndex = first; visualLineIndex < lastExclusive; visualLineIndex += 1) {
			const line = this.lines[visualLineIndex]!;
			if (columnIndex < line.endColumn || line.lastForLogicalLine) return visualLineIndex;
		}
		throw new Error("Visual line projection is inconsistent");
	}

	private nextVisualLineIndex(logicalLineIndex: number): number {
		for (let index = logicalLineIndex; index < this.logicalLineCount; index += 1) {
			if (this.logicalLineVisibility![index]) return this.visualLineStarts![index]!;
		}
		return this.visualLineCount;
	}

	private identityLineAt(lineIndex: number): EditorVisualLine {
		const model = this.identityModel!;
		if (model.version !== this.modelVersion) throw new Error("Unwrapped visual line projection is stale");
		return Object.freeze({
			visualLineIndex: lineIndex,
			logicalLineIndex: lineIndex,
			startColumn: 0,
			endColumn: model.getLineLength((lineIndex) + 1),
			firstForLogicalLine: true,
			lastForLogicalLine: true,
		});
	}
}

const identityLineCache = new WeakMap<EditorVisualLineProjection, readonly EditorVisualLine[]>();

function validateBreakColumns(text: string, breakColumns: readonly number[]): void {
	if (!isNonEmptyArray(breakColumns)) {
		throw new RangeError("Each logical line must have at least one visual segment");
	}
	if (breakColumns.length === 1 && breakColumns[0] === text.length) return;
	const boundaries = new Set(getTextGraphemeBoundaries(text));
	let previous = 0;
	for (let index = 0; index < breakColumns.length; index += 1) {
		const column = breakColumns[index];
		if (!Number.isSafeInteger(column) || column < previous || column > text.length || !boundaries.has(column)) {
			throw new RangeError("Visual line break columns must be ordered grapheme boundaries");
		}
		if (index > 0 && column === previous) {
			throw new RangeError("Only an empty logical line may contain an empty visual segment");
		}
		previous = column;
	}
	if (previous !== text.length) {
		throw new RangeError("The final visual line break must equal the logical line length");
	}
	if (text.length > 0 && breakColumns[0] === 0) {
		throw new RangeError("A non-empty logical line may not start with an empty visual segment");
	}
}

function validateLogicalLineIndex(lineIndex: number, lineCount: number): void {
	if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex >= lineCount) {
		throw new RangeError("Logical line index is outside the visual projection");
	}
}

function validateWrappedTextIndentWidth(width: number): void {
	if (!Number.isFinite(width) || width < 0) {
		throw new RangeError("Visual line wrapped-text indent width must be finite and non-negative");
	}
}
