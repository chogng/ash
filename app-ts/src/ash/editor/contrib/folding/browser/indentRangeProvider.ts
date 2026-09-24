import { EditorFoldingRangeSource, type EditorFoldingRange } from "./foldingRanges.js";
import { type TextModel } from "../../../common/model/textModel.js";

export interface EditorIndentFoldingOptions {
	readonly tabSize?: number;
}

/** Computes provider-owned fold ranges from decreasing leading indentation. */
export function computeEditorIndentFoldingRanges(model: TextModel, options: EditorIndentFoldingOptions = {}): readonly EditorFoldingRange[] {
	const tabSize = readTabSize(options.tabSize);
	const stack: IndentLine[] = [];
	const ranges: EditorFoldingRange[] = [];
	let previous: IndentLine | undefined;
	for (let lineIndex = 0; lineIndex < model.lineCount; lineIndex += 1) {
		const text = model.getLineContent((lineIndex) + 1);
		if (isBlank(text)) continue;
		const indentation = leadingIndentation(text, tabSize);
		while (true) {
			const previousTop = stack.at(-1);
			if (!previousTop || previousTop.indentation < indentation) break;
			const previous = stack.pop()!;
			appendRange(ranges, previous.lineIndex, lineIndex - 1);
		}
		if (previous && indentation > previous.indentation) stack.push(previous);
		previous = { lineIndex, indentation };
	}
	while (stack.length > 0) {
		const previous = stack.pop()!;
		appendRange(ranges, previous.lineIndex, model.lineCount - 1);
	}
	return Object.freeze(ranges);
}

interface IndentLine {
	readonly lineIndex: number;
	readonly indentation: number;
}

function appendRange(ranges: EditorFoldingRange[], startLineIndex: number, endLineIndex: number): void {
	if (endLineIndex <= startLineIndex) return;
	ranges.push(Object.freeze({
		startLineIndex,
		endLineIndex,
		collapsed: false,
		source: EditorFoldingRangeSource.Provider,
	}));
}

function isBlank(text: string): boolean {
	return /^[\t ]*$/u.test(text);
}

function leadingIndentation(text: string, tabSize: number): number {
	let indentation = 0;
	for (const character of text) {
		if (character === " ") {
			indentation += 1;
		} else if (character === "\t") {
			indentation += tabSize - indentation % tabSize;
		} else {
			break;
		}
	}
	return indentation;
}

function readTabSize(value: number | undefined): number {
	const tabSize = value ?? 4;
	if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 64) {
		throw new RangeError("Indent folding tab size must be an integer from 1 through 64");
	}
	return tabSize;
}
