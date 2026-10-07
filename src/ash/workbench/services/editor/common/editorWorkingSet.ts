import type { SerializedEditorInput } from './editorInputSerializer.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';

/** Pane-owned, JSON-safe state scoped to one concrete editor instance. */
export interface SerializedEditorViewState {
	readonly typeId: string;
	readonly value: JsonValue;
}

export interface EditorWorkingSetEntry {
	readonly input: SerializedEditorInput;
	readonly preview: boolean;
	readonly sticky?: boolean;
	readonly viewState?: SerializedEditorViewState;
}

export interface EditorGroupWorkingSet {
	/** Stable identity used by the serialized two-dimensional layout tree. */
	readonly id?: string;
	readonly locked?: boolean;
	readonly editors: readonly EditorWorkingSetEntry[];
	readonly activeEditorIndex: number;
	/** Legacy horizontal-layout ratio retained for backward compatibility. */
	readonly size: number;
}

export type EditorWorkingSetLayout =
	| {
		readonly type: 'leaf';
		readonly data: { readonly groupId: string; };
		readonly size: number;
		readonly visible: boolean;
		readonly priority: 'low' | 'normal' | 'high';
	}
	| {
		readonly type: 'branch';
		readonly orientation: 'horizontal' | 'vertical';
		readonly size: number;
		readonly children: readonly EditorWorkingSetLayout[];
		readonly priority: 'low' | 'normal' | 'high';
	};

/** Validates the whole saved geometry before any live group or pane is moved. */
export function parseEditorWorkingSetLayout(value: unknown, groupIds: ReadonlySet<string>): EditorWorkingSetLayout {
	const seen = new Set<string>();
	const visit = (candidate: unknown, parentOrientation: 'horizontal' | 'vertical' | undefined, depth: number): void => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 64) throw new TypeError('Invalid Editor Grid layout node');
		const node = candidate as Record<string, unknown>;
		if (!Number.isFinite(node.size) || (node.size as number) < 0 || (node.priority !== 'low' && node.priority !== 'normal' && node.priority !== 'high')) {
			throw new TypeError('Invalid Editor Grid layout geometry');
		}
		if (node.type === 'leaf') {
			const data = node.data as Record<string, unknown> | undefined;
			if (typeof node.visible !== 'boolean' || !data || typeof data.groupId !== 'string' || !groupIds.has(data.groupId) || seen.has(data.groupId)) {
				throw new TypeError('Invalid Editor Grid group reference');
			}
			seen.add(data.groupId);
			return;
		}
		if (node.type !== 'branch' || (node.orientation !== 'horizontal' && node.orientation !== 'vertical') || node.orientation === parentOrientation || !Array.isArray(node.children) || !node.children.length) {
			throw new TypeError('Invalid Editor Grid branch');
		}
		for (const child of node.children) visit(child, node.orientation, depth + 1);
	};
	visit(value, undefined, 0);
	if (!seen.size || seen.size !== groupIds.size) throw new TypeError('Editor Grid layout does not contain every group');
	return value as EditorWorkingSetLayout;
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
	/** Retained groups stay alive while the remaining groups restore their document working set. */
	readonly preserveGroups?: readonly string[];
}
