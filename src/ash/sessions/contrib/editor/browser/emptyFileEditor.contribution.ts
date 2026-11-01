import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { EmptyFileEditor } from './emptyFileEditor.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { localize } from '../../../../nls.js';

registerEditorPane({
	id: 'ash.sessions.emptyFileEditor',
	name: 'Files',
	canOpen: input => input.resource.scheme === 'ash-sessions-files' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(EmptyFileEditor),
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'sessionsFilesLandingHelp',
	priority: 100,
	when: ContextKeyExpr.has('sessionsFilesLandingFocused'),
	getProvider: accessor => {
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof EmptyFileEditor)) {
			return undefined;
		}
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Explorer,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.files.landingHelp', "Files\nChoose a file in the group navigation to open it as an editor tab. Toggle details shows or hides this group navigation. Hide editor keeps the file tree visible; Show editor restores document content. Drag the group title to move the tree with its documents. Alt+Shift+Arrow from a header action moves the group. The Files landing tab has no document to save."),
			() => pane.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
