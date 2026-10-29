import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageStatusService } from '../../../services/languageStatus/common/languageStatusService.js';
import { LanguageStatusContribution } from './languageStatus.js';

registerWorkbenchContribution(LanguageStatusContribution.Id, WorkbenchPhase.AfterRestored,
	accessor => accessor.get(IInstantiationService).createInstance(LanguageStatusContribution));

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		name: 'language-status', type, priority: 110,
		getProvider: accessor => {
			const document = accessor.get(IContextViewService).container.ownerDocument;
			const anchor = document.querySelector<HTMLElement>(`[data-statusbar-item-id="${LanguageStatusContribution.Id}"] .ash-statusbar-item-label`);
			if (!accessor.get(IContextKeyService).getValue('languageStatusFocus') && document.activeElement !== anchor) return undefined;
			const model = getCodeEditor(accessor.get(IEditorService).activeEditorPane?.getControl())?.getModel();
			const statuses = model ? accessor.get(ILanguageStatusService).getLanguageStatus(model) : [];
			return new AccessibleContentProvider(AccessibleViewProviderId.Editor, { type }, () => type === AccessibleViewType.Help
				? localize('languageStatus.help', 'Language Status lists feature limits for the active document. Use Up and Down to select a Configure action, Enter to open its settings, and Escape to return to the status bar. Problems reports distinguish diagnostic source truncation from editor highlight limits.')
				: statuses.map(status => `${status.name}: ${status.detail}`).join('\n'),
				() => { if (anchor?.isConnected) anchor.focus(); }, AccessibilityVerbositySettingId.Editor);
		},
	});
}
