import type { BufferAction, CollabBuffer } from '../../../../services/collab/common/bufferCollabService.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { isUuid, parseUuid } from '../../../../../base/common/uuid.js';

/** Browser boundary for the Rust core. Workbench text models remain the only
 * writable source and history owner; Arkdown caches are disposable read-only projections. */
export interface ArkdownRange { readonly start: number; readonly end: number; }
export const arkdownTextColors = ['red', 'yellow', 'green', 'teal', 'purple'] as const;
export type ArkdownTextColor = typeof arkdownTextColors[number];
export type ArkdownColumnAlignment = 'none' | 'left' | 'center' | 'right';
export type ArkdownTableColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export interface ArkdownTableCellLayout { readonly row: number; readonly column: number; readonly rowspan: number; readonly colspan: number; readonly color?: ArkdownTableColor; }
export interface ArkdownTableLayout { readonly widths: readonly number[]; readonly header: boolean; readonly cells: readonly ArkdownTableCellLayout[]; }
export type ArkdownCellBlock =
	| { readonly kind: 'heading'; readonly level: number; }
	| { readonly kind: 'list'; readonly list: 'bullet' | 'ordered' | 'task'; };
export type ArkdownTableAction =
	| { readonly kind: 'set_cell_block'; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; readonly block: ArkdownCellBlock; readonly offset?: number; }
	| { readonly kind: 'insert_row' | 'insert_column'; readonly index: number; }
	| { readonly kind: 'delete_rows' | 'delete_columns' | 'move_row' | 'move_column'; readonly from: number; readonly to: number; }
	| { readonly kind: 'clear_cells' | 'merge_cells'; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; }
	| { readonly kind: 'paste_cells'; readonly row: number; readonly column: number; readonly values: readonly (readonly string[])[]; readonly cells?: readonly ArkdownTableCellLayout[]; }
	| { readonly kind: 'set_column_width'; readonly column: number; readonly end_column?: number; readonly width: number; }
	| { readonly kind: 'set_column_alignment'; readonly from: number; readonly to: number; readonly alignment: ArkdownColumnAlignment; }
	| { readonly kind: 'set_cell_color'; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; readonly color?: ArkdownTableColor; }
	| { readonly kind: 'split_cell'; readonly row: number; readonly column: number; }
	| { readonly kind: 'toggle_header' | 'delete_table'; }
	| { readonly kind: 'sort_column'; readonly column: number; readonly direction: 'ascending' | 'descending'; };
export type ArkdownOperation =
	| { readonly kind: 'set_heading'; readonly offset: number; readonly level: number; }
	| { readonly kind: 'set_list_kind'; readonly offset: number; readonly list: 'bullet' | 'ordered' | 'task'; }
	| { readonly kind: 'set_task_checked'; readonly offset: number; readonly checked: boolean; }
	| { readonly kind: 'indent_list'; readonly offset: number; readonly end: number; readonly direction: 'increase' | 'decrease'; }
	| { readonly kind: 'insert_table_row'; readonly offset: number; }
	| { readonly kind: 'table'; readonly offset: number; readonly action: ArkdownTableAction; };
export interface ArkdownEdit { readonly range: ArkdownRange; readonly text: string; }
export type ArkdownJsonField = { readonly name: string; readonly range: ArkdownRange; } & (
	| { readonly kind: 'text' | 'number'; readonly value: string; }
	| { readonly kind: 'boolean'; readonly value: boolean; }
	| { readonly kind: 'null'; });
export type ArkdownEmbeddedEditor = { readonly kind: 'task_progress'; }
	| { readonly kind: 'json_form'; readonly maxBytes: number; readonly fields: readonly ArkdownJsonField[]; };
export interface ArkdownNode {
	readonly kind: string;
	readonly range: ArkdownRange;
	readonly children: readonly ArkdownNode[];
	readonly text?: string;
	readonly level?: number;
	readonly start?: number;
	readonly checked?: boolean;
	readonly color?: ArkdownTextColor;
	readonly threadId?: string;
	readonly destination?: string;
	readonly title?: string;
	readonly info?: string;
	readonly closed?: boolean;
	readonly alignments?: readonly ArkdownColumnAlignment[];
	readonly tableLayout?: ArkdownTableLayout;
	readonly tableCellMissing?: boolean;
}
export interface ArkdownProjection extends IDisposable {
	parse(source: string): readonly ArkdownNode[];
}
export interface ArkdownRuntime {
	createBuffer(clientId: number, source: string): CollabBuffer;
	createProjection(): ArkdownProjection;
	embeddedEditor(info: string, source: string): ArkdownEmbeddedEditor | undefined;
	operation(source: string, operation: ArkdownOperation): readonly ArkdownEdit[];
	validate(source: string, edits: readonly ArkdownEdit[]): readonly ArkdownEdit[];
	grapheme(source: string, offset: number, direction: 'previous' | 'next'): number;
}

let pending: Promise<ArkdownRuntime> | undefined;
export function loadArkdown(): Promise<ArkdownRuntime> {
	return pending ??= initialize().catch(error => { pending = undefined; throw error; });
}

async function initialize(): Promise<ArkdownRuntime> {
	const core = await import('../../../../../../../.build/arkdown/web/ash_arkdown.js');
	await core.default();
	return {
		createBuffer: (clientId, source) => {
			const document = new core.ArkdownBuffer(clientId, source);
			const edits = (change: string, length: number): readonly ArkdownEdit[] => decodeEdits(object(JSON.parse(change)).edits, length);
			return Object.defineProperties(Object.assign(toDisposable(() => document.free()), {
				apply: (values: readonly ArkdownEdit[]) => { document.applyTransactionJson(JSON.stringify({ expected_revision: document.revision, edits: values })); },
				applyUpdate: (update: Uint8Array) => { const length = document.source.length; return edits(document.applyUpdate(update), length); },
				encodeUpdate: (vector = new Uint8Array()) => document.encodeUpdate(vector),
				stateVector: () => document.stateVector(),
				preview: (action: BufferAction, vector: Uint8Array) => JSON.parse(document.previewJson(JSON.stringify(action), vector)),
				undo: () => { const length = document.source.length; return edits(document.undo(document.revision), length); },
				redo: () => { const length = document.source.length; return edits(document.redo(document.revision), length); },
			}), {
				source: { get: () => document.source }, canUndo: { get: () => document.canUndo }, canRedo: { get: () => document.canRedo },
			}) as CollabBuffer;
		},
		createProjection: () => {
			const projection = new core.ArkdownProjection();
			return Object.assign(toDisposable(() => projection.free()), {
				parse: (source: string) => decodeNodes(JSON.parse(projection.parseJson(source)), source.length),
			});
		},
		embeddedEditor: (info, source) => decodeEmbeddedEditor(JSON.parse(core.embeddedEditorJson(info, source)), source.length),
		operation: (source, operation) => decodeEdits(JSON.parse(core.markdownOperationEditsJson(source, JSON.stringify(operation))), source.length),
		validate: (source, edits) => decodeEdits(JSON.parse(core.validateMarkdownEditsJson(source, JSON.stringify(edits))), source.length),
		grapheme: (source, offset, direction) => {
			const document = new core.ArkdownDocument(source);
			try { return direction === 'previous' ? document.previousGrapheme(offset) : document.nextGrapheme(offset); }
			finally { document.free(); }
		},
	};
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Arkdown object');
	return value as Record<string, unknown>;
}
function range(value: unknown, length: number): ArkdownRange {
	const record = object(value);
	if (!Number.isInteger(record.start) || !Number.isInteger(record.end) || (record.start as number) < 0 || (record.end as number) < (record.start as number) || (record.end as number) > length) throw new TypeError('Invalid Arkdown source range');
	return { start: record.start as number, end: record.end as number };
}
function decodeEdits(value: unknown, length: number): readonly ArkdownEdit[] {
	if (!Array.isArray(value)) throw new TypeError('Invalid Arkdown edit list');
	return value.map(item => { const edit = object(item); if (typeof edit.text !== 'string') throw new TypeError('Invalid Arkdown edit text'); return { range: range(edit.range, length), text: edit.text }; });
}
function decodeEmbeddedEditor(value: unknown, length: number): ArkdownEmbeddedEditor | undefined {
	if (value === null) return undefined;
	const editor = object(value);
	if (editor.kind === 'task_progress') return { kind: editor.kind };
	if (editor.kind !== 'json_form' || typeof editor.max_bytes !== 'number' || !Number.isSafeInteger(editor.max_bytes) || editor.max_bytes <= 0 || !Array.isArray(editor.fields)) {
		throw new TypeError('Invalid Arkdown code block editor');
	}
	const fields = editor.fields.map((item): ArkdownJsonField => {
		const field = object(item);
		if (typeof field.name !== 'string') throw new TypeError('Invalid Arkdown JSON field name');
		const location = { name: field.name, range: range(field, length) };
		if (field.kind === 'null') return { ...location, kind: field.kind };
		if (field.kind === 'boolean' && typeof field.value === 'boolean') return { ...location, kind: field.kind, value: field.value };
		if ((field.kind === 'text' || field.kind === 'number') && typeof field.value === 'string') return { ...location, kind: field.kind, value: field.value };
		throw new TypeError('Invalid Arkdown JSON field value');
	});
	return { kind: editor.kind, maxBytes: editor.max_bytes, fields };
}

function decodeNodes(value: unknown, length: number, depth = 0): readonly ArkdownNode[] {
	if (!Array.isArray(value) || depth > 128) throw new TypeError('Invalid Arkdown node list');
	return value.map(item => {
		const node = object(item);
		if (typeof node.kind !== 'string') throw new TypeError('Invalid Arkdown node kind');
		const source = object(node.source);
		if (node.kind === 'text_color' && !arkdownTextColors.some(color => color === node.color)) throw new TypeError('Invalid Arkdown text color');
		if (node.kind === 'table_cell' && typeof node.missing !== 'boolean') throw new TypeError('Invalid Arkdown table cell');
		if (node.kind === 'comment' && !isUuid(node.thread_id)) throw new TypeError('Invalid Arkdown comment anchor');
		const children = decodeNodes(node.children ?? [], length, depth + 1);
		const table = node.kind === 'table' ? decodeTable(node, children.length) : undefined;
		const result: ArkdownNode = {
			kind: node.kind, range: range(source.utf16, length), children,
			...(typeof node.text === 'string' ? { text: node.text } : {}),
			...(Number.isInteger(node.level) ? { level: node.level as number } : {}),
			...(Number.isInteger(node.start) ? { start: node.start as number } : {}),
			...(typeof node.checked === 'boolean' ? { checked: node.checked } : {}),
			...(node.kind === 'text_color' ? { color: node.color as ArkdownTextColor } : {}),
			...(node.kind === 'comment' ? { threadId: parseUuid(node.thread_id) } : {}),
			...(node.kind === 'table_cell' && node.missing === true ? { tableCellMissing: true } : {}),
			...table,
			...(typeof node.destination === 'string' ? { destination: node.destination } : {}),
			...(typeof node.title === 'string' ? { title: node.title } : {}),
			...(node.kind === 'code_block' && typeof node.info === 'string' ? { info: node.info, closed: node.closed === true } : {}),
		};
		return result;
	});
}

function decodeTable(node: Record<string, unknown>, rows: number): { alignments: readonly ArkdownColumnAlignment[]; tableLayout: ArkdownTableLayout; } {
	const alignments = node.alignments;
	const alignmentsSet: readonly unknown[] = ['none', 'left', 'center', 'right'];
	if (!Array.isArray(alignments) || !alignments.length || rows < 1 || rows * alignments.length > 100000 || !alignments.every(value => alignmentsSet.includes(value))) throw new TypeError('Invalid Arkdown table alignments');
	const layout = object(node.layout);
	if (!Array.isArray(layout.widths) || layout.widths.length !== alignments.length || !layout.widths.every(value => Number.isInteger(value) && (value === 0 || value >= 48 && value <= 4000)) || typeof layout.header !== 'boolean' || !Array.isArray(layout.cells) || layout.cells.length > rows * alignments.length) throw new TypeError('Invalid Arkdown table layout');
	const colors: readonly unknown[] = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
	const occupied = new Set<number>();
	const cells = layout.cells.map(value => {
		const cell = object(value);
		if (![cell.row, cell.column, cell.rowspan, cell.colspan].every(Number.isSafeInteger) || (cell.row as number) < 0 || (cell.column as number) < 0 || (cell.rowspan as number) < 1 || (cell.colspan as number) < 1 || (cell.row as number) + (cell.rowspan as number) > rows || (cell.column as number) + (cell.colspan as number) > alignments.length || cell.color !== undefined && !colors.includes(cell.color)) throw new TypeError('Invalid Arkdown table cell layout');
		const result = cell as unknown as ArkdownTableCellLayout;
		for (let row = result.row; row < result.row + result.rowspan; row++) for (let column = result.column; column < result.column + result.colspan; column++) {
			const index = row * alignments.length + column;
			if (occupied.has(index)) throw new TypeError('Overlapping Arkdown table cell layout');
			occupied.add(index);
		}
		return { row: result.row, column: result.column, rowspan: result.rowspan, colspan: result.colspan, ...(result.color === undefined ? {} : { color: result.color }) };
	});
	return { alignments: alignments as ArkdownColumnAlignment[], tableLayout: { widths: layout.widths as number[], header: layout.header, cells } };
}
