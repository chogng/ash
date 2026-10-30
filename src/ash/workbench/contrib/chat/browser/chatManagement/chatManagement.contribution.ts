import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';

// Embedded Settings lists have their own shortcuts. Model rows own these DOM interactions.
for (const keybinding of [Keybinding.single(logicalKey('a', { primaryKey: true })), Keybinding.single(logicalKey('F10', { shiftKey: true }))]) {
	KeybindingsRegistry.registerKeybindingPassThrough({ keybinding, when: ContextKeyExpr.has('ashChatModelsRowFocus'), priority: KeybindingWeight.WorkbenchContrib + 100 });
}

registerAction2(class ManageLanguageModels extends Action2 {
	constructor() {
		super({ id: MANAGE_CHAT_COMMAND_ID, title: localize2('openAiManagement', 'Manage Language Models'), f1: true });
	}

	public override async run(accessor: ServicesAccessor, searchQuery?: unknown): Promise<void> {
		if (searchQuery !== undefined && typeof searchQuery !== 'string') { throw new TypeError('Model search must be a string'); }
		await accessor.get(IPreferencesService).openSettings({ section: 'models', query: '', sectionQuery: searchQuery ?? '', jsonEditor: false, focusSearch: true });
	}
});
