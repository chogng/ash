import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { resolveModelReasoningEffort } from '../chatModelConfigurationLogic.js';
import { modelPickerAccelerationOptions } from './modelPickerVariants.js';

/** The toolbar shows effort and an explicitly selected acceleration mode. */
export function getModelConfigSummary(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): string {
	const values: string[] = [];
	const effort = getModelConfigEffortLabel(entry, selectedEffort);
	if (effort) { values.push(effort); }
	if (entry.selectedAcceleration) {
		const acceleration = modelPickerAccelerationOptions(entry).find(option => option.value === entry.selectedAcceleration);
		if (acceleration) { values.push(acceleration.label); }
	}
	return values.join(' · ');
}

export function getModelConfigEffortLabel(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): string | undefined {
	const options = modelPickerEffortOptions(entry, selectedEffort);
	return options.length ? options.find(option => option.checked)?.label ?? localize('chat.modelPicker.modelDefault', 'Model default') : undefined;
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

export function modelPickerEffortOptions(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): readonly { effort: ModelReasoningEffort; label: string; description?: string; checked: boolean; }[] {
	const supported = entry.supportedReasoningEfforts ?? [];
	const displayedEffort = resolveModelReasoningEffort(entry, selectedEffort);
	return supported.map(({ effort, description }) => ({
		effort,
		label: modelPickerEffortLabel(effort),
		description: modelPickerEffortDescription(description),
		checked: effort === displayedEffort,
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

export function modelPickerEffortLabel(effort: ModelReasoningEffort): string {
	switch (effort) {
		case 'none': return localize('chat.modelPicker.effortNone', 'None');
		case 'minimal': return localize('chat.modelPicker.effortMinimal', 'Minimal');
		case 'low': return localize('chat.modelPicker.effortLow', 'Low');
		case 'medium': return localize('chat.modelPicker.effortMedium', 'Medium');
		case 'high': return localize('chat.modelPicker.effortHigh', 'High');
		case 'extraHigh': return localize('chat.modelPicker.effortExtraHigh', 'Extra High');
		case 'max': return localize('chat.modelPicker.effortMax', 'Max');
	}
}
