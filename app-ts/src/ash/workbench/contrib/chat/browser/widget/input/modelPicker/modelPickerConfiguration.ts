import { h } from '../../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';

export function createModelPickerConfiguration(
	document: Document,
	entry: ModelCatalogEntry,
	selectedEffort: ModelReasoningEffort | undefined,
): { row: HTMLLabelElement; select: HTMLSelectElement } | undefined {
	if (!entry.supportedReasoningEfforts?.length) return undefined;
	const row = h(document, 'label');
	row.className = 'ash-chat-model-picker-configuration';
	const title = h(document, 'span');
	title.textContent = localize('chat.modelPicker.thinkingEffort', 'Thinking Effort');
	const select = h(document, 'select');
	const defaultOption = h(document, 'option');
	defaultOption.value = '';
	defaultOption.textContent = localize('chat.modelPicker.defaultEffort', 'Default');
	select.append(defaultOption);
	for (const effort of entry.supportedReasoningEfforts) {
		const option = h(document, 'option');
		option.value = effort;
		option.textContent = effortLabel(effort);
		select.append(option);
	}
	select.value = selectedEffort ?? '';
	row.append(title, select);
	return { row, select };
}

function effortLabel(effort: ModelReasoningEffort): string {
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
