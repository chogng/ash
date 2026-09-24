import { type IObservable, observableValue } from '../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { type Position } from '../../common/core/position.js';
import { type Range } from '../../common/core/range.js';
import { type ITextModel } from '../../common/model.js';

export const IRenameSymbolTrackerService = createServiceIdentifier<IRenameSymbolTrackerService>('renameSymbolTrackerService');

export interface ITrackedWord {
	readonly model: ITextModel;
	readonly originalWord: string;
	readonly originalPosition: Position;
	readonly originalRange: Range;
	readonly currentWord: string;
	readonly currentRange: Range;
}

export interface IRenameSymbolTrackerService {
	readonly _serviceBrand: undefined;
	readonly trackedWord: IObservable<ITrackedWord | undefined>;
}

/** Explicit service used when rename tracking is not installed by the host. */
export class NullRenameSymbolTrackerService implements IRenameSymbolTrackerService {
	declare readonly _serviceBrand: undefined;
	readonly trackedWord = observableValue<ITrackedWord | undefined>(this, undefined);
}
