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
			const content = type === AccessibleViewType.View ? pane.workingCopy?.backup() : localize('webview.accessibilityHelp',
				'You are in a document preview. Use Tab to move through links. The editor selector in the breadcrumbs switches between the source and preview. Title actions can open another preview or reopen the current tab. <keybinding:workbench.action.splitEditor> opens a second editor group. <keybinding:editor.action.accessibleView> reads the document as text. Escape closes accessibility help and returns to the preview.');
			if (content === undefined) {
				return undefined;
			}
			return new AccessibleContentProvider(AccessibleViewProviderId.WebviewEditor, { type }, () => content,
				() => pane.focus(), AccessibilityVerbositySettingId.WebviewEditor);
		},
	});
}
