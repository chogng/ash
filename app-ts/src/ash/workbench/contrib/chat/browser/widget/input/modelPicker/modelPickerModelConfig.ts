import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';

/** Both configuration surfaces write undefined when the configured default is chosen. */
export function modelPickerEffortOptions(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): readonly { effort: ModelReasoningEffort | undefined; value: ModelReasoningEffort | undefined; label: string; checked: boolean; isDefault: boolean }[] {
	const defaultEffort = entry.modelReasoningEffort;
	const efforts: readonly (ModelReasoningEffort | undefined)[] = defaultEffort === undefined
		? [undefined, ...(entry.supportedReasoningEfforts ?? [])]
		: entry.supportedReasoningEfforts ?? [];
	return efforts.map(effort => ({
		effort,
		value: effort === defaultEffort ? undefined : effort,
		label: modelPickerEffortLabel(effort),
		checked: effort === (selectedEffort ?? defaultEffort),
		isDefault: defaultEffort !== undefined && effort === defaultEffort,
	}));
}

export function modelPickerEffortLabel(effort: ModelReasoningEffort | undefined): string {
	switch (effort) {
		case undefined: return localize('chat.modelPicker.defaultEffort', 'Default');
		case 'none': return localize('chat.modelPicker.effortNone', 'None');
		case 'minimal': return localize('chat.modelPicker.effortMinimal', 'Minimal');
		case 'low': return localize('chat.modelPicker.effortLow', 'Low');
		case 'medium': return localize('chat.modelPicker.effortMedium', 'Medium');
		case 'high': return localize('chat.modelPicker.effortHigh', 'High');
		case 'extraHigh': return localize('chat.modelPicker.effortExtraHigh', 'Extra High');
		case 'max': return localize('chat.modelPicker.effortMax', 'Max');
	}
}
