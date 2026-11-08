import './sessionCodeReviewActions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { codeReviewFocusedContext, SessionCodeReviewEditor } from './sessionCodeReviewEditor.js';
import { codeReviewScheme, ISessionCodeReviewService, SessionCodeReviewService } from './sessionCodeReviewService.js';

registerSingleton(ISessionCodeReviewService, SessionCodeReviewService, InstantiationType.Delayed);

registerEditorPane({
	id: SessionCodeReviewEditor.ID,
	name: 'Code Review',
	canOpen: input => input.resource.scheme === codeReviewScheme ? EditorPaneMatch.Default : EditorPaneMatch.None,
	createInput: source => ({ ...source, label: localize('sessions.codeReview.title', 'Code Review'), readOnly: true, getIcon: () => Lxicon.codeReview }),
	create: options => options.instantiationService!.createInstance(SessionCodeReviewEditor, undefined),
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, name: `sessionsCodeReview.${type}`, priority: 125, when: ContextKeyExpr.has(codeReviewFocusedContext),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof SessionCodeReviewEditor)) return undefined;
			const focused = pane.getContainer()?.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.DiffEditor, { type }, () => type === AccessibleViewType.View
				? pane.getAccessibleContent()
				: localize('sessions.codeReview.help', 'On a comparison line, press Control+Alt+M (Command+Option+M on macOS) to open a comment. You can also select code and start typing a comment. Use the comparison and file pickers to change scope or jump to a file. Mark a file Seen to fold it. Save each draft, then choose Send to Code Review to create a thread in Bots. The comments list jumps to the original code. View Latest returns from a saved comparison.'),
				() => { if (isHTMLElement(focused) && focused.isConnected) focused.focus(); else pane.focus(); },
				AccessibilityVerbositySettingId.DiffEditor);
		},
	});
}
