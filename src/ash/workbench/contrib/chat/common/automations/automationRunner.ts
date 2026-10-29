import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { URI } from '../../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAutomationDescriptor, IAutomationRun } from './automation.js';

export type IAutomationRunDispatch =
	| { readonly kind: 'accepted' }
	| { readonly kind: 'started'; readonly run: IAutomationRun; readonly sessionResource: URI }
	| { readonly kind: 'notStarted'; readonly reason: 'deleted' | 'targetUnavailable' | 'cancelled' | 'error' };

export interface IAutomationRunOperation {
	readonly whenDispatched: Promise<IAutomationRunDispatch>;
	readonly whenCompleted: Promise<void>;
}

export interface IAutomationRunner {
	runOnce(automation: IAutomationDescriptor, token?: CancellationToken): IAutomationRunOperation;
}

export const IAutomationRunner = createServiceIdentifier<IAutomationRunner>('automationRunner');
