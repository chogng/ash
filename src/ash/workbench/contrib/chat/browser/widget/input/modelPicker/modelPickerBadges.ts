import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

export interface IModelBadge {
	readonly text: string;
	readonly tone: 'warning' | 'provider';
}

export interface IModelBadgeContext {
	readonly providerLabel?: string;
}

/** Notices come from the selected connection's catalog, independently of configuration. */
export function getModelBadge(model: ModelCatalogEntry, context: IModelBadgeContext): IModelBadge | undefined {
	if (model.retirement) {
		return {
			text: model.retirement.shutdownDate
				? localize('chat.modelPicker.retirementDate', 'Retires on {0}', model.retirement.shutdownDate)
				: localize('chat.modelPicker.retiring', 'Retiring soon'),
			tone: 'warning',
		};
	}
	return context.providerLabel ? { text: context.providerLabel, tone: 'provider' } : undefined;
}
