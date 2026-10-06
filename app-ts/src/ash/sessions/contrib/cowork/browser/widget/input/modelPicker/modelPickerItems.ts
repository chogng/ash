import { localize } from '../../../../../../../nls.js';
import { ActionListItemKind, type IActionListItem } from '../../../../../../../platform/actionWidget/browser/actionList.js';
import type { ModelRef } from '../../../../../../../workbench/services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../../workbench/services/chat/common/modelCatalog.js';

import { modelPickerEffortLabel } from './modelPickerModelConfig.js';

export function buildModelPickerItems(models: readonly ModelCatalogEntry[], selected: ModelRef | undefined): readonly IActionListItem<ModelCatalogEntry>[] {
	return models.map(entry => {
		const isSelected = selected?.provider === entry.model.provider && selected.model === entry.model.model;
		const details = [entry.model.provider, entry.model.model];
		if (isSelected) details.push(localize('chat.modelPicker.current', 'Current'));
		if (entry.contextWindow) details.push(localize('chat.modelPicker.context', '{0} context tokens', entry.contextWindow.toLocaleString()));
		if (entry.supportedReasoningEfforts?.length) details.push(localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.map(option => modelPickerEffortLabel(option.effort)).join(', ')));
		return {
			id: `${entry.model.provider}/${entry.model.model}`,
			kind: ActionListItemKind.Action,
			label: entry.displayName,
			detail: details.join(' · '),
			checked: isSelected,
			item: entry,
		};
	});
}
