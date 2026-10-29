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
			() => localize('sessions.files.landingHelp', 'Files tab\nChoose a file in Details to open it in the editor. Use the Files command to focus the file tree. Toggle details shows or hides the tree. Hide editor keeps the shared Changes and Files tabs above Details; Show editor restores the open files. The Files landing tab has no document to save.'),
			() => pane.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
