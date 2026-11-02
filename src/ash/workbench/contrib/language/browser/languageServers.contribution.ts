import { isHTMLElement } from '../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILanguageServerStatusService, MANAGE_LANGUAGE_SERVERS_COMMAND_ID, LanguageServerStatusFocused, LANGUAGE_SERVER_STATUS_ENTRY_ID } from '../../../services/language/common/languageServerStatusService.js';
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
			if (!accessor.get(IContextKeyService).getValue(LanguageServerStatusFocused.key)
				&& !focused?.closest(`[data-statusbar-item-id="${LANGUAGE_SERVER_STATUS_ENTRY_ID}"]`)) return undefined;
			const service = accessor.get(ILanguageServerStatusService);
			return new AccessibleContentProvider(AccessibleViewProviderId.LanguageServerStatus, { type }, () => type === AccessibleViewType.Help
				? localize('languageServer.help', 'Language Services shows servers and live status grouped by workspace folder. Each row shows a status icon and server name. Use Up and Down Arrow to move between rows. Tab keeps focus in the menu. Click a server row, or press Enter, Space or Right Arrow, to open its actions submenu with View Logs, Restart Server and Stop Server. Workspace actions and All server actions open their corresponding submenus. Left Arrow or Escape closes a submenu and returns focus to its row. An empty circle means inactive, a green dot means ready, a rotating ring means starting or an operation in progress, and a red dot means an error. Hover over a row to read its specific state; screen readers receive the same state as the row description. Restart and Stop keep this window open so you can observe their results. State and progress update without moving focus; if a menu action becomes unavailable, focus moves to an available action. View Logs closes this window and opens the full server output. Escape or clicking outside closes this window and returns focus to the status bar. Controls affect this window without changing saved configuration. Workspace and All Servers actions control servers that have already started, including stopped servers when restarting. Warnings and full errors remain in Output; failures that need your attention offer actions in notifications.')
				: service.getAccessibleContent(), () => {
					if (isHTMLElement(focused) && focused.isConnected) {
						focused.focus();
					} else {
						void service.open();
					}
				}, AccessibilityVerbositySettingId.LanguageServers);
		},
	});
}
