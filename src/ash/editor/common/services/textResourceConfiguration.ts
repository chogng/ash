import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

export const ITextResourcePropertiesService = createDecorator<ITextResourcePropertiesService>('textResourcePropertiesService');

/** Resolves resource-specific physical text properties used while creating a model. */
export interface ITextResourcePropertiesService {
	readonly _serviceBrand: undefined;
	getEOL(resource: URI, language?: string): string;
}
