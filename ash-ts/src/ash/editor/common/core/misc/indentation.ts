import { CursorColumns } from "../cursorColumns.js";

/** Canonical indentation configuration shared by engine layout and editing contributions. */
export enum EditorIndentationKind {
	Tabs = "tabs",
	Spaces = "spaces",
}

export interface EditorIndentationOptions {
	readonly kind?: EditorIndentationKind;
	readonly tabSize?: number;
}

export interface ResolvedEditorIndentationOptions {
	readonly kind: EditorIndentationKind;
	readonly tabSize: number;
}

export const DEFAULT_EDITOR_INDENTATION = Object.freeze<ResolvedEditorIndentationOptions>({
	kind: EditorIndentationKind.Spaces,
	tabSize: 4,
});

export function normalizeIndentation(value: string, indentSize: number, insertSpaces: boolean): string {
	return normalizeEditorIndentationText(value, resolveEditorIndentationOptions({
		kind: insertSpaces ? EditorIndentationKind.Spaces : EditorIndentationKind.Tabs,
		tabSize: indentSize,
	}));
}

export function resolveEditorIndentationOptions(options: EditorIndentationOptions = {}): ResolvedEditorIndentationOptions {
	if (typeof options !== "object" || options === null) throw new TypeError("Editor indentation options must be an object");
	const kind = options.kind ?? DEFAULT_EDITOR_INDENTATION.kind;
	if (kind !== EditorIndentationKind.Tabs && kind !== EditorIndentationKind.Spaces) throw new TypeError("Unknown editor indentation kind");
	const tabSize = options.tabSize ?? DEFAULT_EDITOR_INDENTATION.tabSize;
	if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 32) throw new RangeError("Editor tab size must be a safe integer between 1 and 32");
	return Object.freeze({ kind, tabSize });
}

export function getLeadingIndentation(text: string, endColumn = text.length): string {
	if (typeof text !== "string") throw new TypeError("Indented text must be a string");
	if (!Number.isSafeInteger(endColumn) || endColumn < 0 || endColumn > text.length) throw new RangeError("Indentation end column must be within the text");
	return /^[\t ]*/.exec(text.slice(0, endColumn))![0];
}

export function normalizeEditorIndentation(indentation: string, options: ResolvedEditorIndentationOptions): string {
	return indentationFromColumns(indentationColumns(indentation, options.tabSize), options);
}

export function getEditorIndentationUnit(options: ResolvedEditorIndentationOptions): string {
	return options.kind === EditorIndentationKind.Spaces ? " ".repeat(options.tabSize) : "\t";
}

export function normalizeEditorIndentationText(text: string, options: ResolvedEditorIndentationOptions): string {
	const leading = getLeadingIndentation(text);
	return normalizeEditorIndentation(leading, options) + text.slice(leading.length);
}

export function unshiftEditorIndentation(indentation: string, options: ResolvedEditorIndentationOptions): string {
	return indentationFromColumns(Math.max(0, indentationColumns(indentation, options.tabSize) - options.tabSize), options);
}

function indentationFromColumns(columns: number, options: ResolvedEditorIndentationOptions): string {
	return options.kind === EditorIndentationKind.Spaces
		? " ".repeat(columns)
		: "\t".repeat(Math.floor(columns / options.tabSize)) + " ".repeat(columns % options.tabSize);
}

function indentationColumns(indentation: string, tabSize: number): number {
	if (typeof indentation !== "string" || /[^\t ]/.test(indentation)) throw new TypeError("Editor indentation must contain only tabs and spaces");
	let columns = 0;
	for (const character of indentation) {
		columns = character === "\t" ? CursorColumns.nextIndentTabStop(columns, tabSize) : columns + 1;
	}
	return columns;
}
