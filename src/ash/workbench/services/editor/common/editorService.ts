import type { IResourceEditorInput } from '../../../common/editor.js';
import type { Event } from '../../../../base/common/event.js';
import type { Range } from "../../../../editor/common/core/range.js";
import type { IEditorOptions, TextEditorSelectionSource } from "../../../../platform/editor/common/editor.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Optional caller preferences for opening and revealing an editor resource. */
export interface EditorOpenOptions extends IEditorOptions {
	/** Add or update the tab without selecting it when the group already has an active editor. */
	readonly inactive?: boolean;
	readonly preferredEditorId?: string;
	readonly index?: number;
	readonly selection?: Range;
	readonly selectionSource?: TextEditorSelectionSource;
}

/** The editor group selected by a resource-navigation request. */
export type EditorOpenTarget = "activeGroup" | "sideGroup" | "modalGroup" | { readonly groupId: string; };

/** Resource-oriented editor operations available to Workbench contributions. */
export interface IEditorService {
	readonly onDidActiveEditorChange: Event<void>;
	readonly onDidVisibleEditorsChange: Event<void>;
	readonly activeEditor: IResourceEditorInput | undefined;
	readonly visibleEditors: readonly IResourceEditorInput[];
	/** Resolves after displaying the resource or its error page; ignoreError leaves failures with the caller. */
	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void>;
	focusActiveEditor(): void;
}

export const IEditorService = createServiceIdentifier<IEditorService>("editorService");
