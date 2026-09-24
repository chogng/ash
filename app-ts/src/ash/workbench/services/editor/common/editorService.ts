import type { URI } from "../../../../base/common/uri.js";
import type { Event } from '../../../../base/common/event.js';
import type { Range } from "../../../../editor/common/core/range.js";
import type { EditorActivationOptions } from "../../../../platform/editor/common/editor.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** A resource requested through the Workbench editor service. */
export interface EditorInput {
	readonly resource: URI;
	readonly contentType?: string;
	readonly languageId?: string;
	readonly label?: string;
	readonly readOnly?: boolean;
	/** Whether the resource path is meaningful to show as breadcrumbs. */
	readonly showBreadcrumbs?: boolean;
	readonly initialText?: string;
}

/** Optional caller preferences for opening and revealing an editor resource. */
export interface EditorOpenOptions extends EditorActivationOptions {
	readonly preferredEditorId?: string;
	readonly index?: number;
	readonly selection?: Range;
}

/** The editor group selected by a resource-navigation request. */
export type EditorOpenTarget = "activeGroup" | "sideGroup" | "modalGroup";

/** Resource-oriented editor operations available to Workbench contributions. */
export interface IEditorService {
	readonly onDidActiveEditorChange: Event<void>;
	readonly onDidVisibleEditorsChange: Event<void>;
	readonly activeEditor: EditorInput | undefined;
	readonly visibleEditors: readonly EditorInput[];
	openEditor(input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void>;
	focusActiveEditor(): void;
}

export const IEditorService = createServiceIdentifier<IEditorService>("editorService");
