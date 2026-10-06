import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';

/** Context capacity is shown in the menu; the toolbar reserves its space for thinking level. */
export function getModelConfigSummary(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): string {
	if (entry.supportedReasoningEfforts?.length) {
		return modelPickerEffortLabel(selectedEffort ?? entry.defaultReasoningEffort);
	}
	return entry.contextWindowOptions.length ? localize('chat.modelPicker.configuration', 'Model options') : '';
}

export function getModelConfigValueLabel(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(2))}M`;
	}
	if (tokens >= 1_000) {
		return `${Number((tokens / 1_000).toFixed(1))}K`;
	}
	return String(tokens);
}

/** Both configuration surfaces write undefined when the configured default is chosen. */
export function modelPickerEffortOptions(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): readonly { effort: ModelReasoningEffort | undefined; value: ModelReasoningEffort | undefined; label: string; description?: string; checked: boolean; }[] {
	const defaultEffort = entry.defaultReasoningEffort;
	const efforts = defaultEffort === undefined
		? [{ effort: undefined, description: undefined }, ...(entry.supportedReasoningEfforts ?? [])]
		: entry.supportedReasoningEfforts ?? [];
	return efforts.map(({ effort, description }) => ({
		effort,
		value: effort === defaultEffort ? undefined : effort,
		label: modelPickerEffortLabel(effort),
		description: modelPickerEffortDescription(description),
		checked: effort === (selectedEffort ?? defaultEffort),
	}));
}

/** Translate Ash's catalog copy; provider-authored descriptions retain their original text. */
export function modelPickerEffortDescription(description: string | null | undefined): string | undefined {
	switch (description) {
		case 'No additional reasoning': return localize('chat.modelPicker.reasoningNone', 'No additional reasoning');
		case 'Minimal reasoning for simple tasks': return localize('chat.modelPicker.reasoningMinimal', 'Minimal reasoning for simple tasks');
		case 'Fast responses with lighter reasoning': return localize('chat.modelPicker.reasoningLow', 'Fast responses with lighter reasoning');
		case 'Balances speed and reasoning depth for everyday tasks': return localize('chat.modelPicker.reasoningMedium', 'Balances speed and reasoning depth for everyday tasks');
		case 'Greater reasoning depth for complex problems': return localize('chat.modelPicker.reasoningHigh', 'Greater reasoning depth for complex problems');
		case 'Extra high reasoning depth for complex problems': return localize('chat.modelPicker.reasoningExtraHigh', 'Extra high reasoning depth for complex problems');
		case 'Maximum reasoning depth for the hardest problems': return localize('chat.modelPicker.reasoningMax', 'Maximum reasoning depth for the hardest problems');
		default: return description ?? undefined;
	}
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
