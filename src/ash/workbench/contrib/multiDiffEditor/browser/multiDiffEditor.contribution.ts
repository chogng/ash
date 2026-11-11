import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { matchMultiDiffEditor, MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffCollapseAllAction, MultiDiffExpandAllAction, MultiDiffGoToFileAction, MultiDiffGoToNextChangeAction, MultiDiffGoToPreviousChangeAction, MultiDiffToggleCollapseAllAction, MultiDiffToggleCollapseUnchangedRegionsAction, MultiDiffTogglePreviewAction, registerMultiDiffEditorFileListViewActions, ToggleFileListAction } from './multiDiffEditorActions.js';
import { MultiDiffEditor, MultiDiffEditorPreview } from './multiDiffEditor.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService } from './multiDiffSourceResolverService.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { MultiDiffEditorFileListFocusedContext } from '../common/multiDiffEditor.js';

registerSingleton(IMultiDiffSourceResolverService, MultiDiffSourceResolverService, InstantiationType.Delayed);

registerAction2(MultiDiffGoToNextChangeAction);
registerAction2(MultiDiffGoToPreviousChangeAction);
registerAction2(MultiDiffCollapseAllAction);
registerAction2(MultiDiffExpandAllAction);
registerAction2(MultiDiffToggleCollapseAllAction);
registerAction2(MultiDiffGoToFileAction);
registerAction2(MultiDiffToggleCollapseUnchangedRegionsAction);
registerAction2(MultiDiffTogglePreviewAction);
registerAction2(ToggleFileListAction);
registerMultiDiffEditorFileListViewActions();

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 125, name: `multiDiffReview-${type}`, when: ContextKeyExpr.or(MultiDiffEditorPreview.isEqualTo(true), MultiDiffEditorFileListFocusedContext.isEqualTo(true)),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof MultiDiffEditor)) return undefined;
			const container = pane.getContainer();
			const focused = container?.ownerDocument.activeElement;
			if (!container || !focused || !container.contains(focused)) return undefined;
			const inFileList = focused.closest('.ash-multi-diff-file-list') !== null;
			if (!pane.preview && !inFileList) return undefined;
			const content = inFileList
				? type === AccessibleViewType.Help
					? localize('multiDiff.fileListHelp', 'Changed Files. Use Up and Down to browse files. Press Enter to open the comparison or Space to preview it with focus in the list. Use Toggle Changed Files in the editor toolbar to show or hide the list.')
					: pane.getFileListAccessibleContent()
				: type === AccessibleViewType.Help
					? localize('multiDiff.preview.help', 'Review preview is read-only. Use Up and Down to choose lines, Left and Right to choose a side, Shift with Up or Down to select lines, and Copy to copy the selected source text. Select All includes lines outside the viewport. Press Enter or choose Open Full Editor to edit or search the same document. <keybinding:multiDiffEditor.goToNextChange> and <keybinding:multiDiffEditor.goToPreviousChange> navigate changes. File headers expand and collapse with Enter or Space; arrow keys move between headers. Hidden-line buttons reveal unchanged code. <keybinding:editor.action.accessibleView> reads differences. Escape closes this view and restores focus. Toggle Review Preview returns to the full multi-file editor. Word wrap uses the full editor. Help hints follow the Diff Editor accessibility verbosity setting.')
					: pane.getAccessibleContent();
			if (!content) return undefined;
			return new AccessibleContentProvider(AccessibleViewProviderId.DiffEditor, { type }, () => content,
				() => { if (isHTMLElement(focused) && focused.isConnected) focused.focus(); else pane.focus(); },
				AccessibilityVerbositySettingId.DiffEditor);
		},
	});
}

registerEditorPane({
	id: MULTI_DIFF_EDITOR_ID,
	name: 'Stanza Multi Diff',
	canOpen: matchMultiDiffEditor,
	create: options => {
		const instantiationService = options.instantiationService;
		if (!instantiationService) throw new Error('Stanza Multi Diff requires the Workbench instantiation service');
		return instantiationService.createInstance(MultiDiffEditor, {
			activeEditorId: options.input?.editorId,
		});
	},
});
