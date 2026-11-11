import type { ModelRef } from '../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../services/chat/common/modelCatalog.js';

export function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left === right || (left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model);
}

export function findModelForChatInput(models: readonly ModelCatalogEntry[], model: ModelRef | undefined): ModelCatalogEntry | undefined {
	return model && models.find(entry => sameModel(entry.model, model));
}
