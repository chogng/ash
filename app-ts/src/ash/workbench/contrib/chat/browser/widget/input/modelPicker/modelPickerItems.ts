import { localize } from '../../../../../../../nls.js';
import type { IQuickPickItem } from '../../../../../../../platform/quickinput/common/quickInput.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

export interface ModelPickerItem extends IQuickPickItem {
	readonly entry: ModelCatalogEntry;
}

export function buildModelPickerItems(models: readonly ModelCatalogEntry[], selected: ModelRef | undefined): readonly ModelPickerItem[] {
	return models.map(entry => {
		const isSelected = selected?.provider === entry.model.provider && selected.model === entry.model.model;
		const details = [entry.model.provider, entry.model.model];
		if (isSelected) details.push(localize('chat.modelPicker.current', 'Current'));
		if (entry.contextWindow) details.push(localize('chat.modelPicker.context', '{0} context tokens', entry.contextWindow.toLocaleString()));
		if (entry.supportedReasoningEfforts?.length) details.push(localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.join(', ')));
		return {
			label: entry.displayName,
			detail: details.join(' · '),
			className: isSelected ? 'ash-chat-model-picker-current' : undefined,
			entry,
		};
	});
}
