import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { URI } from "../../../../base/common/uri.js";
import type { Event } from '../../../../base/common/event.js';
import type { Range } from "../../../../editor/common/core/range.js";
import type { EditorInputCapabilities } from '../../../common/editor.js';
import type { IEditorOptions, TextEditorSelectionSource } from "../../../../platform/editor/common/editor.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** A resource requested through the Workbench editor service. */
export interface EditorInput {
	/** Distinguishes an independent custom editor tab from a text tab for the same resource. */
	readonly editorId?: string;
	toUntyped?(): EditorInput;
	readonly capabilities?: EditorInputCapabilities;
	readonly resource: URI;
	readonly contentType?: string;
	readonly languageId?: string;
	readonly label?: string;
	/** Also signals a change to the editor's custom icon. */
	readonly onDidChangeLabel?: Event<void>;
	getIcon?(): ThemeIcon | URI | undefined;
	readonly readOnly?: boolean;
	/** Whether the resource path is meaningful to show as breadcrumbs. */
	readonly showBreadcrumbs?: boolean;
	readonly initialText?: string;
}

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
	readonly activeEditor: EditorInput | undefined;
	readonly visibleEditors: readonly EditorInput[];
	/** Resolves after displaying the resource or its error page; ignoreError leaves failures with the caller. */
	openEditor(input: EditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void>;
	focusActiveEditor(): void;
}

export const IEditorService = createServiceIdentifier<IEditorService>("editorService");
