import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILanguageServerStatusService, MANAGE_LANGUAGE_SERVERS_COMMAND_ID, LanguageServerMenuFocused, LANGUAGE_SERVER_STATUS_ENTRY_ID } from '../../../services/language/common/languageServerStatusService.js';
import { localize, localize2 } from '../../../../nls.js';

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_LANGUAGE_SERVERS_COMMAND_ID } from '../../../../platform/language/common/languageServerService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { LanguageServerSettingsTarget } from '../../preferences/common/preferences.js';

registerAction2(class OpenLanguageServerSettings extends Action2 {
	constructor() { super({ id: OPEN_LANGUAGE_SERVERS_COMMAND_ID, title: localize2({ bundle: 'ash.settings', key: 'lsp.open' }, 'Configure Language Servers'), f1: true }); }

	public override async run(accessor: ServicesAccessor, languageId?: string): Promise<void> {
		const language = languageId ?? accessor.get(ICodeEditorService).getActiveCodeEditor()?.getModel()?.getLanguageId();
		const input = createSettingsEditorInput(LanguageServerSettingsTarget, language ? { languageId: language } : {});
		await accessor.get(IEditorService).openEditor(input, { pinned: true }, 'modalGroup');
	}
});

registerAction2(class ManageLanguageServers extends Action2 {
	constructor() { super({ id: MANAGE_LANGUAGE_SERVERS_COMMAND_ID, title: localize2('languageServer.services', 'Language Services'), f1: true }); }
	public override run(accessor: ServicesAccessor): Promise<void> { return accessor.get(ILanguageServerStatusService).open(); }
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		name: 'language-server-status', type, priority: 110,
		getProvider: accessor => {
			const focused = accessor.get(IContextViewService).container.ownerDocument.activeElement;
			if (!accessor.get(IContextKeyService).getValue(LanguageServerMenuFocused.key)
				&& !focused?.closest(`[data-statusbar-item-id="${LANGUAGE_SERVER_STATUS_ENTRY_ID}"]`)) return undefined;
			const service = accessor.get(ILanguageServerStatusService);
			return new AccessibleContentProvider(AccessibleViewProviderId.LanguageServerStatus, { type }, () => type === AccessibleViewType.Help
				? localize('languageServer.help', 'Language Services lists servers by workspace folder. Use Up and Down to select a server, Right to open its actions, Left to return, and Escape to close and return focus. View Logs opens the full server output. Restart Server and Stop Server affect this window without changing saved configuration. Workspace and All Servers actions control servers that have already started, including stopped servers when restarting. Progress stays in the status bar. Warnings and full errors are in Output; failures that need your attention offer actions in notifications.')
				: service.getAccessibleContent(), () => { void service.open(); }, AccessibilityVerbositySettingId.LanguageServers);
		},
	});
}
