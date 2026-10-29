import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IViewContainerDescriptor } from '../../../common/views.js';

/** Describes activity independently of the UI that presents it. */
export interface IBadge {
	getDescription(): string;
}

export interface IActivity {
	readonly badge: IBadge;
}

/** Numeric activity with a description that retains the full count. */
export class NumberBadge implements IBadge {
	constructor(readonly number: number, private readonly descriptorFn: (number: number) => string) { }

	getDescription(): string {
		return this.descriptorFn(this.number);
	}
}

export interface IActivityService {
	readonly onDidChangeActivity: Event<string | IViewContainerDescriptor>;
	showViewContainerActivity(viewContainerId: string, activity: IActivity): IDisposable;
	getViewContainerActivities(viewContainerId: string): IActivity[];
	showViewActivity(viewId: string, activity: IActivity): IDisposable;
}

export const IActivityService = createServiceIdentifier<IActivityService>('activityService');
