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
	readonly viewState?: SerializedEditorViewState;
}

export interface EditorGroupWorkingSet {
	/** Stable identity used by the serialized two-dimensional layout tree. */
	readonly id?: string;
	readonly editors: readonly EditorWorkingSetEntry[];
	readonly activeEditorIndex: number;
	/** Legacy horizontal-layout ratio retained for backward compatibility. */
	readonly size: number;
}

export type EditorWorkingSetLayout =
	| {
		readonly type: 'leaf';
		readonly data: { readonly groupId: string };
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
}
