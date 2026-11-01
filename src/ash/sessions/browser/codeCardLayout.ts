// Legacy Card state is decoded only during the one-way migration into Editor Group layout.
import { Orientation } from '../../base/browser/ui/sash/sash.js';
import { LayoutPriority } from '../../base/browser/ui/splitview/splitview.js';
import { validateSerializedGridViewDescriptor } from '../../base/browser/ui/grid/gridview.js';
import type { SerializedGridDescriptor } from '../../base/browser/ui/grid/grid.js';
import type { EditorWorkingSetLayout } from '../../workbench/services/editor/common/editorWorkingSet.js';

type CodeCardId = 'terminal' | 'files' | 'changes' | 'browser' | 'info';

/** Validate the persisted tree once, at the storage boundary, before attaching retained views. */
export function readCodeCardLayout(
	value: string | undefined,
	partIds: readonly string[],
): SerializedGridDescriptor | undefined {
	if (!value) return undefined;
	try {
		const tree = validateSerializedGridViewDescriptor(JSON.parse(value));
		const ids = new Set<string>();
		let nodes = 0;
		const visit = (node: unknown): boolean => {
			if (++nodes > 40 || !node || typeof node !== 'object') return false;
			const item = node as Record<string, unknown>;
			if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0 || item.size > 100000)
				return false;
			if (item.priority !== LayoutPriority.High && item.priority !== LayoutPriority.Normal) return false;
			if (item.type === 'branch')
				return (
					(item.orientation === Orientation.VERTICAL || item.orientation === Orientation.HORIZONTAL) &&
					Array.isArray(item.children) &&
					item.children.length > 0 &&
					item.children.every(visit)
				);
			if (
				item.type !== 'leaf' ||
				typeof item.data !== 'string' ||
				typeof item.visible !== 'boolean' ||
				ids.has(item.data) ||
				!partIds.includes(item.data)
			)
				return false;
			ids.add(item.data);
			return true;
		};
		if (!visit(tree) || ids.size !== partIds.length) return undefined;
		return tree;
	} catch {
		return undefined;
	}
}

const codeLayoutIds = ['sessions', 'panel', 'files', 'changes', 'browser', 'info'];

export interface CodeCardLayoutSnapshot {
	readonly tree: SerializedGridDescriptor;
	/** A hidden, previously placed pane retains its slot instead of using the first-open policy. */
	readonly placed: readonly CodeCardId[];
}

export interface CodeCardLayoutState {
	readonly fallback: CodeCardLayoutSnapshot | undefined;
	readonly sessions: ReadonlyMap<string, CodeCardLayoutSnapshot>;
	readonly widths: ReadonlyMap<CodeCardId, number>;
	readonly browserVisible: boolean;
}

/** A bounded, versioned UI-state envelope is decoded before any retained views are attached. */
export function readCodeCardLayoutState(value: string | undefined): CodeCardLayoutState {
	const sessions = new Map<string, CodeCardLayoutSnapshot>();
	const widths = new Map<CodeCardId, number>();
	let fallback: CodeCardLayoutSnapshot | undefined;
	let browserVisible = false;
	if (!value) return { fallback, sessions, widths, browserVisible };
	try {
		const state: unknown = JSON.parse(value);
		if (!state || typeof state !== 'object' || !('version' in state) || state.version !== 1) return { fallback, sessions, widths, browserVisible };
		const record = state as Record<string, unknown>;
		browserVisible = record.browserVisible === true;
		const snapshot = (candidate: unknown): CodeCardLayoutSnapshot | undefined => {
			if (!candidate || typeof candidate !== 'object') return undefined;
			const item = candidate as Record<string, unknown>;
			const tree = readCodeCardLayout(JSON.stringify(item.tree), codeLayoutIds);
			if (!tree || !Array.isArray(item.placed) || item.placed.some(id => !isCodeCardId(id))) return undefined;
			return { tree, placed: [...new Set(item.placed as CodeCardId[])] };
		};
		fallback = snapshot(record.fallback);
		if (Array.isArray(record.sessions)) {
			for (const entry of record.sessions.slice(-100)) {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length > 2048) continue;
				const layout = snapshot(entry[1]);
				if (layout) sessions.set(entry[0], layout);
			}
		}
		if (Array.isArray(record.widths)) {
			for (const entry of record.widths) {
				if (Array.isArray(entry) && isCodeCardId(entry[0]) && typeof entry[1] === 'number'
					&& Number.isFinite(entry[1]) && entry[1] > 0 && entry[1] <= 100000) widths.set(entry[0], entry[1]);
			}
		}
	} catch { /* Invalid reconstructable UI state falls back to the current window's default arrangement. */ }
	return { fallback, sessions, widths, browserVisible };
}

function isCodeCardId(value: unknown): value is CodeCardId {
	return value === 'terminal' || value === 'files' || value === 'changes' || value === 'browser' || value === 'info';
}

/** Replace legacy tool leaves with live group identities; the EditorPart owns the resulting tree. */
export function migrateCodeCardLayout(tree: SerializedGridDescriptor, groups: ReadonlyMap<string, EditorWorkingSetLayout>): EditorWorkingSetLayout | undefined {
	const seen = new Set<number>();
	const visit = (node: SerializedGridDescriptor): EditorWorkingSetLayout | undefined => {
		if (node.type === 'leaf') {
			const replacement = groups.get(String(node.data));
			if (!replacement) return undefined;
			const claim = (part: EditorWorkingSetLayout): EditorWorkingSetLayout | undefined => {
				if (part.type === 'leaf') {
					if (seen.has(part.data.groupId)) return undefined;
					seen.add(part.data.groupId);
					return { ...part, visible: node.visible && part.visible };
				}
				const children = part.children.map(claim).filter((child): child is EditorWorkingSetLayout => child !== undefined);
				return children.length ? { ...part, children } : undefined;
			};
			const claimed = claim(replacement);
			return claimed ? { ...claimed, size: node.size } : undefined;
		}
		const children = node.children.map(visit).filter((child): child is EditorWorkingSetLayout => child !== undefined);
		if (!children.length) return undefined;
		if (children.length === 1) return { ...children[0]!, size: node.size };
		return { ...node, children };
	};
	return visit(tree);
}
