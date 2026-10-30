import type { SerializedEditorInput } from './editorInputSerializer.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';

/** Pane-owned, JSON-safe state scoped to one concrete editor instance. */
export interface SerializedEditorViewState {
	readonly typeId: string;
	readonly value: JsonValue;
}

export interface EditorWorkingSetEntry {
	readonly input: SerializedEditorInput;
	/** Reopening a source with another view does not change its resource input identity. */
	readonly paneId?: string;
	readonly preview: boolean;
	readonly sticky?: boolean;
	readonly viewState?: SerializedEditorViewState;
}

export interface EditorGroupWorkingSet {
	/** Stable identity used by the serialized two-dimensional layout tree. */
	readonly id?: number;
	readonly locked?: boolean;
	readonly editors: readonly EditorWorkingSetEntry[];
	readonly activeEditorIndex: number;
	/** Legacy horizontal-layout ratio retained for backward compatibility. */
	readonly size: number;
}

export type EditorWorkingSetLayout =
	| {
		readonly type: 'leaf';
		readonly data: { readonly groupId: number; };
		readonly size: number;
		readonly visible: boolean;
		readonly priority: 0 | 1 | 2;
	}
	| {
		readonly type: 'branch';
		/** Portable Grid orientation: vertical = 0, horizontal = 1. */
		readonly orientation: 0 | 1;
		readonly size: number;
		readonly children: readonly EditorWorkingSetLayout[];
		readonly priority: 0 | 1 | 2;
	};

/** Validates the whole saved geometry before any live group or pane is moved. */
export function parseEditorWorkingSetLayout(value: unknown, groupIds: ReadonlySet<number>): EditorWorkingSetLayout {
	const seen = new Set<number>();
	const visit = (candidate: unknown, parentOrientation: 0 | 1 | undefined, depth: number): EditorWorkingSetLayout => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 64) throw new TypeError('Invalid Editor Grid layout node');
		const node = candidate as Record<string, unknown>;
		const priority = node.priority === 'normal' ? 0 : node.priority === 'low' ? 1 : node.priority === 'high' ? 2 : node.priority;
		if (!Number.isFinite(node.size) || (node.size as number) < 0 || (priority !== 0 && priority !== 1 && priority !== 2)) {
			throw new TypeError('Invalid Editor Grid layout geometry');
		}
		if (node.type === 'leaf') {
			const data = node.data as Record<string, unknown> | undefined;
			if (typeof node.visible !== 'boolean' || !data || typeof data.groupId !== 'number' || !groupIds.has(data.groupId) || seen.has(data.groupId)) {
				throw new TypeError('Invalid Editor Grid group reference');
			}
			seen.add(data.groupId);
			return { type: 'leaf', data: { groupId: data.groupId }, size: node.size as number, visible: node.visible, priority };
		}
		const orientation = node.orientation === 'vertical' ? 0 : node.orientation === 'horizontal' ? 1 : node.orientation;
		if (node.type !== 'branch' || (orientation !== 0 && orientation !== 1) || orientation === parentOrientation || !Array.isArray(node.children) || !node.children.length) {
			throw new TypeError('Invalid Editor Grid branch');
		}
		return { type: 'branch', orientation, size: node.size as number, priority, children: node.children.map(child => visit(child, orientation, depth + 1)) };
	};
	const layout = visit(value, undefined, 0);
	if (!seen.size || seen.size !== groupIds.size) throw new TypeError('Editor Grid layout does not contain every group');
	return layout;
}

/** Serializable editor groups, tabs, preview state, selection, and layout. */
export interface EditorWorkingSet {
	readonly id: string;
	readonly activeGroupIndex: number;
	readonly groups: readonly EditorGroupWorkingSet[];
	/** Exact nested editor-group geometry. Absent in legacy linear working sets. */
	readonly layout?: EditorWorkingSetLayout;
}

export type EditorWorkingSetTarget = EditorWorkingSet | 'empty';

export interface ApplyEditorWorkingSetOptions {
	readonly preserveFocus?: boolean;
	/** Session restoration omits empty groups before creating their Grid views. */
	readonly excludeEmptyGroups?: boolean;
	/** Retained groups stay alive while the remaining groups restore their document working set. */
	readonly preserveGroups?: readonly number[];
}
