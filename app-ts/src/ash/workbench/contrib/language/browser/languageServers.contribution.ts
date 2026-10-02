import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { OPEN_LANGUAGE_SERVERS_COMMAND_ID } from '../../../../platform/language/common/languageServerService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { LanguageServerSettingsTarget } from './languageServerSettingsContent.js';

registerAction2(class OpenLanguageServerSettings extends Action2 {
	constructor() { super({ id: OPEN_LANGUAGE_SERVERS_COMMAND_ID, title: localizedString('ash.settings', 'lsp.open', 'Configure Language Servers'), f1: true }); }

	public override async run(accessor: ServicesAccessor, languageId?: string): Promise<void> {
		const language = languageId ?? accessor.get(ICodeEditorService).getActiveCodeEditor()?.getModel()?.getLanguageId();
		const input = createSettingsEditorInput(LanguageServerSettingsTarget, language ? { languageId: language } : {});
		await accessor.get(IEditorService).openEditor(input, { pinned: true }, 'modalGroup');
	}
});
