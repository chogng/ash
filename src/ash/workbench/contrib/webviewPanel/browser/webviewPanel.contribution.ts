import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { WebviewEditor } from './webviewEditor.js';

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		name: 'webviewEditor',
		priority: 100,
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof WebviewEditor)) {
				return undefined;
			}
			const frame = pane.getControl()?.element;
			if (!frame || frame.ownerDocument.activeElement !== frame) {
				return undefined;
			}
			const content = type === AccessibleViewType.View ? pane.workingCopy?.backup() : pane.isEditable ? localize('webview.richEditorAccessibilityHelp',
				'You are in a Markdown rich text editor. Inactive blocks are rendered; the active block shows its Markdown source. Use the arrow keys to move and Shift to select text. Control or Command with Home or End moves to the document start or end. Alt+F10 focuses the formatting toolbar; Left and Right move between its buttons, and Escape returns to the document. Control or Command with S saves the shared document, Z undoes, and Shift+Z redoes. The editor selector switches to the source or preview. If another editor changes the source during an edit, your draft is retained and Reload document accepts the current source. <keybinding:editor.action.accessibleView> reads the Markdown source. Escape closes accessibility help and returns to the editor.') : localize('webview.accessibilityHelp',
					'You are in a document preview. Use Tab to move through links. The editor selector in the breadcrumbs switches between the source and preview. Title actions can open another preview or reopen the current tab. <keybinding:workbench.action.splitEditor> opens a second editor group. <keybinding:editor.action.accessibleView> reads the document as text. Escape closes accessibility help and returns to the preview.');
			if (content === undefined) {
				return undefined;
			}
			return new AccessibleContentProvider(AccessibleViewProviderId.WebviewEditor, { type }, () => content,
				() => pane.focus(), AccessibilityVerbositySettingId.WebviewEditor);
		},
	});
}
