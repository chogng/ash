import type { IActionListItem } from '../../../../../../../platform/actionWidget/browser/actionList.js';
import type { IAction } from '../../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import type { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { createModelItem } from './modelPickerItemPrimitives.js';
import { localize } from '../../../../../../../nls.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../../common/constants.js';

const modelProviderIcons = new Map([
	['openai', Lxicon.openai],
	['anthropic', Lxicon.claude],
	['google', Lxicon.gemini],
	['xai', Lxicon.grok],
	['deepseek', Lxicon.deepseek],
]);

export function createManageModelsAction(commandService: ICommandService): IAction {
	return {
		id: 'ash.chat.input.addModels',
		label: localize('chat.modelPicker.addModels', 'Add Models'),
		tooltip: '', enabled: true,
		run: () => commandService.executeCommand(MANAGE_CHAT_COMMAND_ID),
	};
}

/** Projects the enabled catalog into selectable rows without changing its order or model identities. */
export function buildModelPickerItems(
	models: readonly ModelCatalogEntry[],
	selected: ModelRef | undefined,
	showProviderIcon = false,
): readonly IActionListItem<ModelCatalogEntry>[] {
	return models.map(entry => {
		const item = createModelItem(entry, selected);
		const provider = entry.source?.providerId ?? entry.model.provider;
		const icon = showProviderIcon ? modelProviderIcons.get(provider) : undefined;
		if (icon) {
			return { ...item, group: { title: '', icon } };
		}
		return item;
	});
}
