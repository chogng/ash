import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { IWorkspaceContextService, workspaceRelativePath } from '../../../../platform/workspace/common/workspace.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { EditorPanes, registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, type TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { InSearchEditor, isSearchEditorInput, OpenNewEditorCommandId, SearchEditorID } from './constants.js';
import { SearchEditor } from './searchEditor.js';
import { serializeSearchResultForEditor } from './searchEditorSerialization.js';

registerEditorPane({
	id: SearchEditorID,
	name: localize('searchEditor.title', 'Search Editor'),
	canOpen: input => isSearchEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Search editor requires the Workbench instantiation service'); }
		const descriptor = EditorPanes.getEditorPane({ resource: URI.from({ scheme: 'untitled', path: '/search.txt' }) }, { preferredEditorId: CODE_EDITOR_ID })!;
		const editor = descriptor.create({ ...options, input: { ...options.input!, editorId: CODE_EDITOR_ID } }) as TextResourceEditor;
		return options.instantiationService.createInstance(SearchEditor, editor);
	},
});

registerAction2(class extends Action2 {
	constructor() { super({ id: OpenNewEditorCommandId, title: localize('searchEditor.new', 'Search: New Search Editor'), f1: true }); }
	async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
		const editors = accessor.get(IEditorService);
		const groupId = isRecord(argument) && typeof argument.groupId === 'number' && Number.isSafeInteger(argument.groupId)
			? argument.groupId : undefined;
		let workspaceRoot: string | undefined;
		let includePatterns: string[] = [];
		if (isRecord(argument) && 'folder' in argument) {
			const resource = argument.folder;
			if (!(resource instanceof URI)) throw new TypeError('Search in folder requires a folder URI');
			const folder = accessor.get(IWorkspaceContextService).getWorkspaceFolder(resource);
			if (!folder || (await accessor.get(IFileService).stat(resource)).kind !== FileKind.Directory) return;
			workspaceRoot = folder.uri.toString();
			const path = workspaceRelativePath(folder.uri, resource);
			if (path !== '.') {
				// Character classes keep glob syntax and commas in directory names literal.
				const literal = path.replace(/[[*?{}, ]/g, character => `[${character}]`).replace(/^!/, '{!}');
				includePatterns = [`${literal}/**`];
			}
		}
		await editors.openEditor({
			resource: URI.from({ scheme: 'untitled', path: `/Search-${crypto.randomUUID()}.code-search` }),
			editorId: SearchEditorID,
			label: localize('searchEditor.title', 'Search Editor'),
			showBreadcrumbs: false,
			initialText: serializeSearchResultForEditor({
				text: '', patternKind: 'literal', caseSensitivity: 'insensitive', includePatterns, excludePatterns: [], workspaceRoot,
			}),
		}, { pinned: true }, groupId === undefined ? undefined : { groupId });
	}
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'searchEditor',
	priority: 110,
	when: InSearchEditor.isEqualTo(true),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof SearchEditor)) { return undefined; }
		const focused = pane.domNode.ownerDocument.activeElement as HTMLElement | null;
		return new AccessibleContentProvider(AccessibleViewProviderId.SearchEditorHelp, { type: AccessibleViewType.Help },
			() => localize('searchEditor.help', 'You are in a search editor. Use Tab to move between the query, search options, file filters, and editable results. Ctrl or Command+Enter in the query runs the search; in a result row it opens the source match. Escape stops a running search. The Search header stores the query and options. Use Save to keep a temporary query and its results in a .code-search file. Reopen the file to restore the search editor. Press Escape to close this help and return to the previous control.'),
			() => { if (focused?.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.Find);
	},
});
