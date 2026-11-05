import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';
import { getModelConfigSummary, modelPickerEffortOptions, modelPickerAccelerationOptions } from './modelPickerModelConfig.js';

/** Renders supplied state; the toolbar owns the button, its hover and service dependencies. */
export function renderModelConfigurationButton(
	button: HTMLElement,
	model: ModelCatalogEntry | undefined,
	selectedEffort: ModelReasoningEffort | undefined,
	hidden: boolean,
	accessibilityHint?: string,
): void {
	const summary = model ? getModelConfigSummary(model, selectedEffort) : '';
	const configurable = model && (model.supportedReasoningEfforts?.length || model.longContext !== null || model.accelerationOptions?.length);
	const optionsLabel = localize('chat.modelPicker.configuration', 'Model options');
	button.hidden = hidden || !configurable;
	button.classList.toggle('hidden', button.hidden);
	button.querySelector('.ash-chat-input-picker-label')!.textContent = summary || optionsLabel;
	const label = summary ? localize('chat.modelPicker.configurationAriaLabel', 'Model options: {0}', summary) : optionsLabel;
	button.setAttribute('aria-label', label);
	const effort = model ? modelPickerEffortOptions(model, selectedEffort).find(option => option.checked) : undefined;
	const acceleration = model ? modelPickerAccelerationOptions(model).find(option => option.checked) : undefined;
	const description = [effort?.description, acceleration?.description, accessibilityHint].filter(Boolean).join(' ');
	if (description) { button.setAttribute('aria-description', description); }
	else { button.removeAttribute('aria-description'); }
}
