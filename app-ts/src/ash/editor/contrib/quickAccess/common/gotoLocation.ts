import { clamp } from "../../../../base/common/numbers.js";
import { Position } from "../../../common/core/position.js";
import { type TextModel } from "../../../common/model/textModel.js";

export interface GotoLocation {
	readonly position: Position;
	readonly kind: "lineColumn" | "offset";
}

export type GotoLocationParseResult =
	| { readonly kind: "empty" | "invalid"; readonly message: string }
	| { readonly kind: "location"; readonly location: GotoLocation; readonly message: string };

/**
 * Parses Stanza's Go to Line input into a clamped model position.
 *
 * Line and column values are one-based UTF-16 positions. A negative line or
 * column counts backwards from its corresponding document boundary. `::N`
 * addresses the one-based UTF-16 offset N, with negative offsets counted from
 * the end of the document.
 */
export function parseStanzaGotoLocation(model: TextModel, value: string): GotoLocationParseResult {
	if (typeof value !== "string") throw new TypeError("Go to Line input must be text");
	const input = value.trim().replace(/^:/u, "");
	if (input.length === 0) {
		return Object.freeze({ kind: "empty", message: `Type a line number from 1 to ${model.lineCount}` });
	}
	if (input.startsWith(":")) return parseOffset(model, input.slice(1));
	return parseLineColumn(model, input);
}

function parseOffset(model: TextModel, value: string): GotoLocationParseResult {
	const offset = parseInteger(value);
	if (offset === undefined) {
		return Object.freeze({ kind: "invalid", message: `Type an offset from 1 to ${model.createVersionedSnapshot().length}` });
	}
	const length = model.createVersionedSnapshot().length;
	const oneBasedOffset = offset < 0 ? length + 1 + offset : offset;
	const position = model.positionAt(clamp(oneBasedOffset - 1, 0, length));
	return locationResult(position, "offset");
}

function parseLineColumn(model: TextModel, value: string): GotoLocationParseResult {
	const parts = value.split(/[,:#]/u, 2);
	const requestedLine = parseInteger(parts[0]!.trim());
	if (requestedLine === undefined) {
		return Object.freeze({ kind: "invalid", message: `Type a line number from 1 to ${model.lineCount}` });
	}
	const oneBasedLine = requestedLine < 0
		? model.lineCount + 1 + requestedLine
		: requestedLine;
	const lineIndex = clamp(oneBasedLine - 1, 0, model.lineCount - 1);
	const requestedColumn = parts.length > 1 ? parseInteger(parts[1]!.trim()) : undefined;
	if (parts.length > 1 && requestedColumn === undefined) {
		return Object.freeze({ kind: "invalid", message: `Type a column number from 1 to ${model.getLineContent((lineIndex) + 1).length + 1}` });
	}
	const lineLength = model.getLineContent((lineIndex) + 1).length;
	const oneBasedColumn = requestedColumn === undefined
		? 1
		: requestedColumn < 0
			? lineLength + 2 + requestedColumn
			: requestedColumn;
	return locationResult(new Position((lineIndex) + 1, (clamp(oneBasedColumn - 1, 0, lineLength)) + 1), "lineColumn");
}

function locationResult(position: Position, kind: GotoLocation["kind"]): GotoLocationParseResult {
	return Object.freeze({
		kind: "location",
		location: Object.freeze({ position, kind }),
		message: `Line ${position.lineNumber}, Column ${position.column}`,
	});
}

function parseInteger(value: string): number | undefined {
	if (!/^-?\d+$/u.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}
