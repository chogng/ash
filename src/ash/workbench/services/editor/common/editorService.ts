import type { IEditorIdentifier, IEditorPane, IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import type { Event } from '../../../../base/common/event.js';
import type { Range } from '../../../../editor/common/core/range.js';
import type { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import type { IMultiDiffEditorOptions } from '../../../../editor/common/multiDiffEditor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Optional caller preferences for opening and revealing an editor resource. */
export interface EditorOpenOptions extends IMultiDiffEditorOptions {
	/** Add or update the tab without selecting it when the group already has an active editor. */
	readonly inactive?: boolean;
	readonly preferredEditorId?: string;
	readonly index?: number;
	readonly selection?: Range;
	readonly selectionSource?: TextEditorSelectionSource;
}

/** The editor group selected by a resource-navigation request. */
export type EditorOpenTarget = 'activeGroup' | 'sideGroup' | 'modalGroup' | { readonly groupId: number };

export interface ISaveEditorsOptions extends ISaveOptions {
	readonly saveAs?: boolean;
}

export interface ISaveAllEditorsOptions extends ISaveEditorsOptions {
	readonly includeUntitled?: boolean | { readonly includeScratchpad: boolean };
	readonly excludeSticky?: boolean;
}

export interface ISaveEditorsResult {
	readonly success: boolean;
	readonly editors: IResourceEditorInput[];
}

/** Resource-oriented editor operations available to Workbench contributions. */
export interface IEditorService {
	readonly onDidActiveEditorChange: Event<void>;
	readonly onDidVisibleEditorsChange: Event<void>;
	readonly activeEditor: IResourceEditorInput | undefined;
	readonly activeEditorPane: IEditorPane | undefined;
	readonly visibleEditors: readonly IResourceEditorInput[];
	readonly visibleEditorPanes: readonly IEditorPane[];
	/** Resolves after display, an error page, or expected cancellation; ignoreError leaves failures with the caller. */
	openEditor(input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget): Promise<void>;
	save(
		editors: IEditorIdentifier | readonly IEditorIdentifier[],
		options?: ISaveEditorsOptions,
	): Promise<ISaveEditorsResult>;
	saveAll(options?: ISaveAllEditorsOptions): Promise<ISaveEditorsResult>;
	focusActiveEditor(): void;
}

export const IEditorService = createServiceIdentifier<IEditorService>('editorService');
