import { clamp } from "../../../base/common/numbers.js";
import { Selection } from "../core/selection.js";
import { Position } from "../core/position.js";
import { getTextGraphemeBoundaries } from "../core/textSegmentation.js";
import { type TextModel } from "../model/textModel.js";
import { type EditorVisualLineProjection } from "./modelLineProjection.js";

export enum EditorCursorNavigationCommand {
	CharacterLeft = 'characterLeft',
	CharacterRight = 'characterRight',
	WordLeft = 'wordLeft',
	WordRight = 'wordRight',
	LineUp = 'lineUp',
	LineDown = 'lineDown',
	LineStart = 'lineStart',
	LineEnd = 'lineEnd',
	DocumentStart = 'documentStart',
	DocumentEnd = 'documentEnd',
	PageUp = 'pageUp',
	PageDown = 'pageDown',
}

export enum EditorCursorNavigationMode {
	Move = 'move',
	Extend = 'extend',
}

export interface VisualCursorNavigationRequest {
	readonly command: EditorCursorNavigationCommand.LineUp | EditorCursorNavigationCommand.LineDown | EditorCursorNavigationCommand.PageUp | EditorCursorNavigationCommand.PageDown;
	readonly mode: EditorCursorNavigationMode;
	readonly pageLineCount: number;
	readonly preferredHorizontalOffsets?: readonly number[];
}

export interface VisualCursorNavigationResult {
	readonly selections: readonly Selection[];
	readonly preferredHorizontalOffsets: readonly number[];
}

/** Browser-provided visual coordinates for layouts whose logical prefix width is not monotonic. */
export interface VisualCursorGeometry {
	getHorizontalOffset(position: Position): number | undefined;
	getNearestPosition(visualLineIndex: number, horizontalOffset: number): Position | undefined;
}

/** Navigates selections by browser-measured wrapped visual rows. */
export function navigateStanzaVisualCursors(model: TextModel, projection: EditorVisualLineProjection, selections: readonly Selection[], request: VisualCursorNavigationRequest, measureTextWidth: (text: string) => number, geometry?: VisualCursorGeometry): VisualCursorNavigationResult {
	validateRequest(model, projection, selections, request, measureTextWidth);
	const preferredHorizontalOffsets = resolvePreferredHorizontalOffsets(
		model,
		projection,
		selections,
		request.preferredHorizontalOffsets,
		measureTextWidth,
		geometry,
	);
	const navigated = selections.map((selection, index) => {
		const target = visualVerticalTarget(
			model,
			projection,
			selection.getPosition(),
			lineDelta(request),
			preferredHorizontalOffsets[index]!,
			measureTextWidth,
			geometry,
		);
		return request.mode === EditorCursorNavigationMode.Extend
			? Selection.fromPositions(selection.getSelectionStart(), target)
			: Selection.fromPositions(target);
	});
	return normalizeResult(navigated, 0, preferredHorizontalOffsets);
}

function visualVerticalTarget(model: TextModel, projection: EditorVisualLineProjection, position: Position, lineDelta: number, preferredHorizontalOffset: number, measureTextWidth: (text: string) => number, geometry: VisualCursorGeometry | undefined): Position {
	const currentVisualLineIndex = projection.visualLineIndexAt(position);
	const targetVisualLineIndex = clamp(
		currentVisualLineIndex + lineDelta,
		0,
		projection.visualLineCount - 1,
	);
	if (targetVisualLineIndex === currentVisualLineIndex) return position;
	const visualLine = projection.lineAt(targetVisualLineIndex)!;
	const browserTarget = geometry?.getNearestPosition(targetVisualLineIndex, preferredHorizontalOffset);
	if (browserTarget && browserTarget.lineNumber - 1 === visualLine.logicalLineIndex && browserTarget.column - 1 >= visualLine.startColumn && browserTarget.column - 1 <= visualLine.endColumn) {
		return browserTarget;
	}
	const text = model.getLineContent((visualLine.logicalLineIndex) + 1).slice(
		visualLine.startColumn,
		visualLine.endColumn,
	);
	const textOffset = Math.max(0, preferredHorizontalOffset - (visualLine.wrappedTextIndentWidth ?? 0));
	return new Position((visualLine.logicalLineIndex) + 1, (visualLine.startColumn + nearestCursorColumn(
			text,
			textOffset,
			measureTextWidth,
		)) + 1);
}

function resolvePreferredHorizontalOffsets(model: TextModel, projection: EditorVisualLineProjection, selections: readonly Selection[], preferredHorizontalOffsets: readonly number[] | undefined, measureTextWidth: (text: string) => number, geometry: VisualCursorGeometry | undefined): readonly number[] {
	if (preferredHorizontalOffsets?.length === selections.length) {
		return Object.freeze([...preferredHorizontalOffsets]);
	}
	return Object.freeze(selections.map(selection => {
		const visualLine = projection.lineAt(
			projection.visualLineIndexAt(selection.getPosition()),
		)!;
		return geometry?.getHorizontalOffset(selection.getPosition()) ?? (visualLine.wrappedTextIndentWidth ?? 0) + measureTextWidth(model.getLineContent((visualLine.logicalLineIndex) + 1).slice(
			visualLine.startColumn,
			selection.getPosition().column - 1,
		));
	}));
}

function nearestCursorColumn(text: string, horizontalOffset: number, measureTextWidth: (text: string) => number): number {
	const boundaries = getTextGraphemeBoundaries(text);
	let low = 0;
	let high = boundaries.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const leftColumn = boundaries[middle] ?? 0;
		const rightColumn = boundaries[middle + 1] ?? text.length;
		const left = measureTextWidth(text.slice(0, leftColumn));
		const right = measureTextWidth(text.slice(0, rightColumn));
		if (horizontalOffset < left + (right - left) / 2) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	return boundaries[low] ?? text.length;
}

function lineDelta(request: VisualCursorNavigationRequest): number {
	switch (request.command) {
		case EditorCursorNavigationCommand.LineUp:
			return -1;
		case EditorCursorNavigationCommand.LineDown:
			return 1;
		case EditorCursorNavigationCommand.PageUp:
			return -request.pageLineCount;
		case EditorCursorNavigationCommand.PageDown:
			return request.pageLineCount;
	}
}

function normalizeResult(selections: readonly Selection[], primaryIndex: number, preferredHorizontalOffsets: readonly number[]): VisualCursorNavigationResult {
	const normalized: Selection[] = [];
	const normalizedOffsets: number[] = [];
	const sourceToNormalized: number[] = [];
	for (let index = 0; index < selections.length; index += 1) {
		const selection = selections[index]!;
		let targetIndex = normalized.findIndex(candidate => selectionsEqual(candidate, selection));
		if (targetIndex < 0) {
			targetIndex = normalized.length;
			normalized.push(selection);
			normalizedOffsets.push(preferredHorizontalOffsets[index]!);
		} else if (index === primaryIndex) {
			normalizedOffsets[targetIndex] = preferredHorizontalOffsets[index]!;
		}
		sourceToNormalized.push(targetIndex);
	}
	return Object.freeze({
		selections: primaryFirst(normalized, sourceToNormalized[primaryIndex]!),
		preferredHorizontalOffsets: Object.freeze(normalizedOffsets),
	});
}

function primaryFirst(selections: readonly Selection[], primaryIndex: number): readonly Selection[] {
	if (primaryIndex === 0) return Object.freeze([...selections]);
	return Object.freeze([selections[primaryIndex]!, ...selections.slice(0, primaryIndex), ...selections.slice(primaryIndex + 1)]);
}

function validateRequest(model: TextModel, projection: EditorVisualLineProjection, selections: readonly Selection[], request: VisualCursorNavigationRequest, measureTextWidth: (text: string) => number): void {
	if (projection.modelVersion !== model.version) {
		throw new Error("Visual cursor navigation requires the current text model projection");
	}
	if (!isVisualVerticalCommand(request.command)) {
		throw new TypeError("Visual cursor navigation requires a vertical command");
	}
	if (!Object.values(EditorCursorNavigationMode).includes(request.mode)) {
		throw new TypeError("Unknown editor cursor navigation mode");
	}
	if (!Number.isSafeInteger(request.pageLineCount) || request.pageLineCount < 1) {
		throw new RangeError("Visual cursor navigation page line count must be a positive safe integer");
	}
	if (typeof measureTextWidth !== "function") {
		throw new TypeError("Visual cursor navigation requires a text measurement function");
	}
	if (request.preferredHorizontalOffsets && (request.preferredHorizontalOffsets.length !== selections.length || request.preferredHorizontalOffsets.some(offset => !Number.isFinite(offset) || offset < 0))) {
		throw new RangeError("Visual cursor navigation preferred horizontal offsets must match selections");
	}
	for (const selection of selections) model.offsetAt(selection.getPosition());
}

function isVisualVerticalCommand(command: EditorCursorNavigationCommand): command is VisualCursorNavigationRequest["command"] {
	return command === EditorCursorNavigationCommand.LineUp ||
		command === EditorCursorNavigationCommand.LineDown ||
		command === EditorCursorNavigationCommand.PageUp ||
		command === EditorCursorNavigationCommand.PageDown;
}

function selectionsEqual(left: Selection, right: Selection): boolean {
	return Position.compare(left.getSelectionStart(), right.getSelectionStart()) === 0 &&
		Position.compare(left.getPosition(), right.getPosition()) === 0;
}
