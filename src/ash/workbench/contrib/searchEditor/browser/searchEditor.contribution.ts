import { URI } from '../../../../base/common/uri.js';
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
import { InSearchEditor, OpenNewEditorCommandId, SearchEditorID } from './constants.js';
import { SearchEditor } from './searchEditor.js';
import { serializeSearchResultForEditor } from './searchEditorSerialization.js';

registerEditorPane({
	id: SearchEditorID,
	name: localize('searchEditor.title', 'Search Editor'),
	canOpen: input => input.editorId === SearchEditorID || input.resource.path.endsWith('.code-search') ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Search editor requires the Workbench instantiation service'); }
		const descriptor = EditorPanes.getEditorPane({ resource: URI.from({ scheme: 'untitled', path: '/search.txt' }) }, { preferredEditorId: CODE_EDITOR_ID })!;
		const editor = descriptor.create({ ...options, input: { ...options.input!, editorId: CODE_EDITOR_ID } }) as TextResourceEditor;
		return options.instantiationService.createInstance(SearchEditor, editor);
	},
});

registerAction2(class extends Action2 {
	constructor() { super({ id: OpenNewEditorCommandId, title: localize('searchEditor.new', 'Search: New Search Editor'), f1: true }); }
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IEditorService).openEditor({
			resource: URI.from({ scheme: 'untitled', path: `/Search-${crypto.randomUUID()}.code-search` }),
			editorId: SearchEditorID,
			label: localize('searchEditor.title', 'Search Editor'),
			showBreadcrumbs: false,
			initialText: serializeSearchResultForEditor({ text: '', patternKind: 'literal', caseSensitivity: 'insensitive', includePatterns: [], excludePatterns: [] }),
		}, { pinned: true });
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
			() => localize('searchEditor.help', 'You are in a search editor. Use Tab to move between the query, search options, file filters, and editable results. Ctrl or Command+Enter in the query runs the search; in a result row it opens the source match. Escape stops a running search. The Search header stores the query and options. Save As writes the query and results to a .code-search file; reopening it restores the search editor. Press Escape to close this help and return to the previous control.'),
			() => { if (focused?.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.Find);
	},
});
