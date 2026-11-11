import type { IReader } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Window-scoped submission guards survive disposal of the visible Checks surface. */
export interface IChecksOperationService {
	isBlocked(key: string, reader?: IReader): boolean;
	tryStart(key: string): boolean;
	markUncertain(key: string): void;
	finish(key: string): void;
}

export const IChecksOperationService = createServiceIdentifier<IChecksOperationService>('checksOperationService');
