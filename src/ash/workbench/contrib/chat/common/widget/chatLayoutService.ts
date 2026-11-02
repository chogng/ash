import type { IObservable } from '../../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';

export const IChatLayoutService = createServiceIdentifier<IChatLayoutService>('chatLayoutService');

/** Message typography projected from configuration; lists retain layout and scroll ownership. */
export interface IChatLayoutService {
	readonly _serviceBrand: undefined;
	readonly fontFamily: IObservable<string | null>;
	readonly fontSize: IObservable<number>;
}
