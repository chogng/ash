import { localize } from '../../../../../../../nls.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

/** Uses the host catalog for names, including a selected entry hidden from the menu. */
export function getModelPickerLabel(automatic: boolean, model: ModelCatalogEntry | undefined, selected: ModelRef | undefined): string {
	return automatic ? localize('chat.modelPicker.auto', 'Auto')
		: model?.displayName ?? selected?.model ?? localize('chat.modelPicker.selectModel', 'Select model');
}
