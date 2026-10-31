import { localize } from '../../../../../../../nls.js';
import { ActionListItemKind, type IActionListItem } from '../../../../../../../platform/actionWidget/browser/actionList.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { modelPickerEffortLabel } from './modelPickerModelConfig.js';
import { getModelBadge } from './modelPickerBadges.js';

/** Builds one catalog-backed row; execution and popup lifetime remain with its caller. */
export function createModelItem(
	entry: ModelCatalogEntry,
	selected: ModelRef | undefined,
): IActionListItem<ModelCatalogEntry> {
	const isSelected = selected?.provider === entry.model.provider && selected.model === entry.model.model;
	const details = [entry.model.provider, entry.model.model];
	const badge = getModelBadge(entry, {});
	if (badge) { details.push(badge.text); }
	if (isSelected) { details.push(localize('chat.modelPicker.current', 'Current')); }
	if (entry.contextWindow) { details.push(localize('chat.modelPicker.context', '{0} context tokens', entry.contextWindow.toLocaleString())); }
	if (entry.supportedReasoningEfforts?.length) {
		details.push(localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.map(option => modelPickerEffortLabel(option.effort)).join(', ')));
	}
	return {
		id: `${entry.model.provider}/${entry.model.model}`,
		kind: ActionListItemKind.Action,
		label: entry.displayName,
		detail: details.join(' · '),
		checked: isSelected,
		item: entry,
	};
}
