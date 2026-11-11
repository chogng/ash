import type { ModelRef, TaskModelSelection } from '../../../../platform/models/common/agentModels.js';
import { modelPickerEffortLabel } from './widget/input/modelPicker/modelPickerModelConfig.js';
import { modelRefIdentity, type ModelCatalogEntry, type ModelReasoningEffort } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsMenuOption } from '../../../services/preferences/common/preferences.js';

/** Builds the same model rows and effort submenus for each task's settings. */
export function taskModelMenuRows(entries: readonly ModelCatalogEntry[], saved: TaskModelSelection | null | undefined,
	defaultEffort: (entry: ModelCatalogEntry) => ModelReasoningEffort | undefined = entry => entry.defaultReasoningEffort) {
	const savedId = saved && modelRefIdentity(saved);
	return entries.map(entry => {
		const id = modelRefIdentity(entry.model);
		const savedEffort = id === savedId ? saved?.reasoningEffort ?? undefined : undefined;
		const effort = savedEffort ?? defaultEffort(entry);
		const label = entry.displayName;
		const labelDescription = effort === undefined ? undefined : modelPickerEffortLabel(effort);
		const value = choiceValue(entry.model, effort);
		const levels = (entry.supportedReasoningEfforts ?? []).map(({ effort }) => ({
			value: choiceValue(entry.model, effort), label: modelPickerEffortLabel(effort), effort,
		}));
		const summary = { value, label, labelDescription };
		const option: SettingsMenuOption = levels.length ? { id, label, labelDescription, selectedValue: value, options: levels } : summary;
		const choices = levels.length ? levels : [{ value, effort: savedEffort }];
		return { id, model: entry.model, summary, option, choices };
	});
}

function choiceValue(model: ModelRef, effort: ModelReasoningEffort | undefined): string {
	return JSON.stringify([model.provider, model.model, effort ?? null]);
}
