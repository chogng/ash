import { localize } from '../../../../../../../nls.js';
import type { ModelReasoningEffort } from '../../../../../../services/chat/common/modelCatalog.js';

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
