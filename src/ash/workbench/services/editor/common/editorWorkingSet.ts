import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import type { EditorGroupId } from './editorState.js';
import { isSerializedEditorInput, migrateLegacyEditorId, type SerializedEditorInput } from './editorInputSerializer.js';
import { validateJsonValue, type JsonValue } from '../../../../base/common/jsonValue.js';
import type { IEditorPane, IResourceEditorInput } from '../../../common/editor.js';

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

/** Coordinates saved-tab loading with explicit opens during Workbench startup. */
export interface StartupEditorRestoration {
	readonly beforeEditors: (restoreTargetState?: StartupEditorViewState) => Promise<void>;
	readonly waitForOpen: () => Promise<void>;
	readonly hasOpened: () => boolean;
	readonly ownsResource: (resource: string) => boolean;
}

export type StartupEditorViewState = (pane: IEditorPane, input: IResourceEditorInput) => void;

export interface ApplyEditorWorkingSetOptions {
	readonly preserveFocus?: boolean;
	/** Session restoration omits empty groups before creating their Grid views. */
	readonly excludeEmptyGroups?: boolean;
	/** Retained groups stay alive while the remaining groups restore their document working set. */
	readonly preserveGroups?: readonly number[];
	readonly startup?: StartupEditorRestoration;
}

/** Normalize persisted group identities and validate every document before a host mutates live groups. */
export function parseEditorWorkingSet(value: EditorWorkingSet, lastGroupId: number): EditorWorkingSet {
	if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim()) {
		throw new TypeError('Invalid editor working set');
	}
	if (!isNonEmptyArray(value.groups) || !Number.isInteger(value.activeGroupIndex) || value.activeGroupIndex < 0 || value.activeGroupIndex >= value.groups.length) {
		throw new TypeError('Invalid editor working set groups');
	}
	value = migrateWorkingSetGroupIds(value, lastGroupId);
	let sizeTotal = 0;
	const groupIds = new Set<EditorGroupId>();
	for (const group of value.groups) {
		if (!group || typeof group !== 'object' || !Array.isArray(group.editors) || !Number.isInteger(group.activeEditorIndex) || group.activeEditorIndex < -1 || group.activeEditorIndex >= group.editors.length || (group.locked !== undefined && typeof group.locked !== 'boolean') || !Number.isFinite(group.size) || group.size < 0) {
			throw new TypeError('Invalid editor group working set');
		}
		if (group.id !== undefined) {
			if (!isEditorGroupId(group.id) || groupIds.has(group.id)) throw new TypeError('Invalid editor working set group ID');
			groupIds.add(group.id);
		}
		for (const editor of group.editors) {
			if (!editor || typeof editor !== 'object' || typeof editor.preview !== 'boolean' || (editor.sticky !== undefined && typeof editor.sticky !== 'boolean') || (editor.sticky === true && editor.preview) || !isSerializedEditorInput(editor.input)) {
				throw new TypeError('Invalid editor working set entry');
			}
			if (editor.paneId !== undefined && (typeof editor.paneId !== 'string' || !editor.paneId.trim() || editor.paneId.length > 256)) {
				throw new TypeError('Invalid editor working set pane ID');
			}
			if (editor.viewState !== undefined) {
				if (!editor.viewState || typeof editor.viewState !== 'object' || typeof editor.viewState.typeId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(editor.viewState.typeId) || !('value' in editor.viewState)) {
					throw new TypeError('Invalid editor working set view state');
				}
				validateJsonValue(editor.viewState.value, { path: 'editor working set view state' });
			}
		}
		sizeTotal += group.size;
	}
	// Pane selection is stored separately from the resource input. Migrate both
	// persistence fields before resolving a retired editor during restoration.
	value = {
		...value, groups: value.groups.map(group => ({
			...group,
			editors: group.editors.map(editor => {
				const paneId = migrateLegacyEditorId(editor.paneId);
				return paneId === editor.paneId ? editor : { ...editor, paneId };
			}),
		}))
	};
	if (value.layout !== undefined) {
		if (groupIds.size !== value.groups.length) throw new TypeError('Editor Grid layout requires an ID for every group');
		return { ...value, layout: parseEditorWorkingSetLayout(value.layout, groupIds) };
	}
	if (sizeTotal === 0) {
		// A snapshot of hidden groups can have no measurable area for the legacy split.
		const size = 1 / value.groups.length;
		return { ...value, groups: value.groups.map(group => ({ ...group, size })) };
	}
	return value;
}

/** Old snapshots name groups with strings. Resolve those names once before restoring live groups. */
function migrateWorkingSetGroupIds(value: EditorWorkingSet, lastGroupId: number): EditorWorkingSet {
	if (!value.groups.some(group => group && typeof group.id === 'string')) return value;
	const ids = new Map<string, number>();
	let nextId = Math.max(lastGroupId, ...value.groups.map(group => isEditorGroupId(group?.id) ? group.id : 0));
	const groups = value.groups.map(group => {
		const id: unknown = group?.id;
		if (typeof id !== 'string') return group;
		if (!id.length || id.length > 128 || ids.has(id) || !Number.isSafeInteger(nextId + 1)) throw new TypeError('Invalid legacy editor group ID');
		ids.set(id, ++nextId);
		return { ...group, id: nextId };
	});
	const migrateLayout = (node: EditorWorkingSetLayout, depth = 0): EditorWorkingSetLayout => {
		if (!node || typeof node !== 'object' || depth > 64) throw new TypeError('Invalid Editor Grid layout node');
		if (node.type === 'leaf') {
			const id: unknown = node.data?.groupId;
			const groupId = typeof id === 'string' ? ids.get(id) : id;
			if (!isEditorGroupId(groupId)) throw new TypeError('Invalid Editor Grid group reference');
			return { ...node, data: { groupId } };
		}
		if (node.type !== 'branch' || !Array.isArray(node.children)) throw new TypeError('Invalid Editor Grid branch');
		return { ...node, children: node.children.map(child => migrateLayout(child, depth + 1)) };
	};
	return { ...value, groups, ...(value.layout ? { layout: migrateLayout(value.layout) } : {}) };
}

export function isEditorGroupId(value: unknown): value is EditorGroupId {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
