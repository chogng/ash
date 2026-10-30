import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';

/** The toolbar shows thinking level and an explicitly selected acceleration mode. */
export function getModelConfigSummary(entry: ModelCatalogEntry, selectedEffort: ModelReasoningEffort | undefined): string {
	const values: string[] = [];
	if (entry.supportedReasoningEfforts?.length) {
		values.push(modelPickerEffortLabel(selectedEffort ?? entry.defaultReasoningEffort));
	}
	if (entry.selectedAcceleration) {
		const acceleration = modelPickerAccelerationOptions(entry).find(option => option.value === entry.selectedAcceleration);
		if (acceleration) { values.push(acceleration.label); }
	}
	if (values.length) { return values.join(' · '); }
	return entry.longContext !== null || entry.accelerationOptions?.length ? localize('chat.modelPicker.configuration', 'Model options') : '';
}

/** The catalog already reflects connection availability; preserve each provider's exact option ID. */
export function modelPickerAccelerationOptions(entry: ModelCatalogEntry): readonly {
	value: string | null;
	label: string;
	description?: string;
	checked: boolean;
}[] {
	if (!entry.accelerationOptions?.length) { return []; }
	return [
		{ value: null, label: localize('chat.modelPicker.defaultAcceleration', 'Default'), checked: entry.selectedAcceleration === null || entry.selectedAcceleration === undefined },
		...entry.accelerationOptions.map(option => ({
			value: option.id,
			label: accelerationLabel(option.name),
			description: accelerationDescription(option.description),
			checked: option.id === entry.selectedAcceleration,
		})),
	];
}

function accelerationLabel(name: string): string {
	switch (name) {
		case 'Fast': return localize('chat.modelPicker.fast', 'Fast');
		case 'Ultra Fast': return localize('chat.modelPicker.ultraFast', 'Ultra Fast');
		default: return name;
	}
}

function accelerationDescription(description: string): string {
	switch (description) {
		case 'Faster responses, increased usage': return localize('chat.modelPicker.fastDescription', 'Faster responses, increased usage');
		case 'Priority processing, increased usage': return localize('chat.modelPicker.priorityDescription', 'Priority processing, increased usage');
		default: return description;
	}
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
	const efforts = defaultEffort === undefined || !entry.supportedReasoningEfforts?.some(option => option.effort === defaultEffort)
		? [{ effort: undefined, description: undefined }, ...(entry.supportedReasoningEfforts ?? [])]
		: entry.supportedReasoningEfforts ?? [];
	return efforts.map(({ effort, description }) => ({
		effort,
		value: effort === defaultEffort ? undefined : effort,
		label: modelPickerEffortLabel(effort),
		description: modelPickerEffortDescription(description),
		checked: effort === (selectedEffort ?? (efforts.some(option => option.effort === defaultEffort) ? defaultEffort : undefined)),
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
