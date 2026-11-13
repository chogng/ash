import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { parseEditorWorkingSet, type EditorWorkingSet } from '../../../services/editor/common/editorWorkingSet.js';
import { chatWindowEdges, ChatWindowLayoutMode, ChatWindowTerminalPosition, type ChatWindowEdge } from './chatWindowLayout.js';

interface IStoredChatWindowPart {
	readonly edge: ChatWindowEdge;
	readonly size: number;
	readonly editors: EditorWorkingSet;
}

export interface IStoredChatWindow {
	readonly chats: readonly string[];
	readonly active?: string;
	readonly bounds: unknown;
	readonly layout: ChatWindowLayoutMode;
	readonly inputOnly: boolean;
	readonly terminalPosition: ChatWindowTerminalPosition;
	readonly sizes?: { readonly main: number; readonly terminals: number; };
	readonly editors: EditorWorkingSet;
	readonly terminals: EditorWorkingSet;
	readonly createdParts: readonly IStoredChatWindowPart[];
}

export function readChatWindowState(raw: string | undefined): readonly IStoredChatWindow[] {
	if (!raw) return [];
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return []; }
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.windows)) return [];
	const windows: IStoredChatWindow[] = [];
	for (const entry of value.windows) {
		if (!isRecord(entry) || !Array.isArray(entry.chats) || !entry.chats.every(isChatUri)
			|| (entry.layout !== ChatWindowLayoutMode.Stacked && entry.layout !== ChatWindowLayoutMode.SideBySide)) continue;
		const active = entry.active;
		if (active !== undefined && typeof active !== 'string') continue;
		if (entry.chats.length ? active === undefined || !entry.chats.includes(active) : active !== undefined) continue;
		try {
			const sizes = isRecord(entry.sizes) && isSize(entry.sizes.main) && isSize(entry.sizes.terminals)
				? { main: entry.sizes.main, terminals: entry.sizes.terminals }
				: undefined;
			const editors = parseEditorWorkingSet(entry.editors as EditorWorkingSet, 0);
			const terminals = parseEditorWorkingSet(entry.terminals as EditorWorkingSet, 0);
			const createdParts = readCreatedParts(entry.createdParts);
			if (!entry.chats.length && ![editors, terminals, ...createdParts.map(part => part.editors)]
				.some(part => part.groups.some(group => group.editors.length))) continue;
			windows.push({
				chats: entry.chats, active, bounds: entry.bounds, layout: entry.layout, sizes,
				inputOnly: entry.inputOnly === true,
				terminalPosition: entry.terminalPosition === ChatWindowTerminalPosition.UnderChat || entry.terminalPosition === ChatWindowTerminalPosition.UnderEditor
					? entry.terminalPosition : ChatWindowTerminalPosition.FullWidth,
				editors, terminals, createdParts,
			});
		} catch { /* A malformed entry must not prevent the other windows from restoring. */ }
	}
	return windows;
}

function readCreatedParts(value: unknown): readonly IStoredChatWindowPart[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(part => {
		if (!isRecord(part) || !chatWindowEdges.some(edge => edge === part.edge) || !isSize(part.size)) return [];
		try {
			return [{ edge: part.edge as ChatWindowEdge, size: part.size, editors: parseEditorWorkingSet(part.editors as EditorWorkingSet, 0) }];
		} catch { return []; }
	});
}

function isSize(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isChatUri(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try { return !!URI.parse(value, true).scheme; } catch { return false; }
}
