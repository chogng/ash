import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Numeric activity attached to one registered View Container. */
export class NumberBadge {
	constructor(readonly number: number, readonly description: string) {
		if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('Activity badge count must be nonnegative');
	}
}

export interface IActivityService {
	showViewContainerActivity(containerId: string, badge: NumberBadge): IDisposable;
}

export const IActivityService = createServiceIdentifier<IActivityService>('activityService');
