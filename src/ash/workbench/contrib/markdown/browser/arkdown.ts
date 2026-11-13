/** Browser boundary for the Rust core. Workbench text models remain the only
 * writable source and history owner; Arkdown projections never retain a copy. */
export interface ArkdownRange { readonly start: number; readonly end: number; }
export interface ArkdownEdit { readonly range: ArkdownRange; readonly text: string; }
export interface ArkdownNode {
	readonly kind: string;
	readonly range: ArkdownRange;
	readonly children: readonly ArkdownNode[];
	readonly text?: string;
	readonly level?: number;
	readonly start?: number;
	readonly checked?: boolean;
	readonly destination?: string;
}
export interface ArkdownRuntime {
	parse(source: string): readonly ArkdownNode[];
	validate(source: string, edits: readonly ArkdownEdit[]): readonly ArkdownEdit[];
	grapheme(source: string, offset: number, direction: 'previous' | 'next'): number;
}

let pending: Promise<ArkdownRuntime> | undefined;
export function loadArkdown(): Promise<ArkdownRuntime> {
	return pending ??= initialize().catch(error => { pending = undefined; throw error; });
}

async function initialize(): Promise<ArkdownRuntime> {
	const core = await import('../../../../../../.build/arkdown/web/ash_arkdown.js');
	await core.default();
	return {
		parse: source => decodeNodes(JSON.parse(core.parseMarkdownJson(source)), source.length),
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
function decodeNodes(value: unknown, length: number, depth = 0): readonly ArkdownNode[] {
	if (!Array.isArray(value) || depth > 128) throw new TypeError('Invalid Arkdown node list');
	return value.map(item => {
		const node = object(item);
		if (typeof node.kind !== 'string') throw new TypeError('Invalid Arkdown node kind');
		const source = object(node.source);
		const result: ArkdownNode = {
			kind: node.kind, range: range(source.utf16, length), children: decodeNodes(node.children ?? [], length, depth + 1),
			...(typeof node.text === 'string' ? { text: node.text } : {}),
			...(Number.isInteger(node.level) ? { level: node.level as number } : {}),
			...(Number.isInteger(node.start) ? { start: node.start as number } : {}),
			...(typeof node.checked === 'boolean' ? { checked: node.checked } : {}),
			...(typeof node.destination === 'string' ? { destination: node.destination } : {}),
		};
		return result;
	});
}
