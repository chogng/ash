import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import { ActionListItemKind, type IActionListItem } from '../../../../../../../platform/actionWidget/browser/actionList.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { getModelConfigSummary, getModelConfigValueLabel, modelPickerEffortLabel } from './modelPickerModelConfig.js';
import { getModelBadge } from './modelPickerBadges.js';

export interface IModelPickerItemOptions {
	readonly selectedEffort: ModelReasoningEffort | undefined;
	onOpenDetails(entry: ModelCatalogEntry): void;
}

/** Builds one catalog-backed row; execution and popup lifetime remain with its caller. */
export function createModelItem(
	entry: ModelCatalogEntry,
	selected: ModelRef | undefined,
	options?: IModelPickerItemOptions,
): IActionListItem<ModelCatalogEntry> {
	const isSelected = selected?.provider === entry.model.provider && selected.model === entry.model.model;
	const details = [entry.model.provider, entry.model.model];
	const badge = getModelBadge(entry, {});
	if (isSelected) { details.push(localize('chat.modelPicker.current', 'Current')); }
	if (entry.contextWindow) { details.push(localize('chat.modelPicker.context', '{0} context tokens', entry.contextWindow.toLocaleString())); }
	if (entry.supportedReasoningEfforts?.length) {
		details.push(localize('chat.modelPicker.efforts', 'Thinking: {0}', entry.supportedReasoningEfforts.map(option => modelPickerEffortLabel(option.effort)).join(', ')));
	}
	const item: IActionListItem<ModelCatalogEntry> = {
		id: `${entry.model.provider}/${entry.model.model}`,
		kind: ActionListItemKind.Action,
		label: entry.displayName,
		badge: badge?.text,
		detail: details.join(' · '),
		checked: isSelected,
		item: entry,
	};
	if (!options) { return item; }
	const summary = isSelected ? [
		getModelConfigSummary(entry, options.selectedEffort),
		entry.contextWindow ? getModelConfigValueLabel(entry.contextWindow) : undefined,
	].filter(Boolean).join(' · ') : undefined;
	const detailsLabel = localize('chat.modelPicker.details', '{0} details', entry.displayName);
	return {
		...item,
		description: summary,
		opensDialog: true,
		toolbarActions: [{
			id: 'chat.modelPicker.details',
			label: detailsLabel,
			tooltip: detailsLabel,
			icon: Lxicon.chevronRight,
			enabled: true,
			run: () => options.onOpenDetails(entry),
		}],
	};
}
