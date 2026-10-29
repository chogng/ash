import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IObservable } from '../../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type {
	AutomationTarget,
	IAutomationDescriptor,
	IAutomationRun,
	IAutomationRunResult,
	IAutomationSchedule,
} from './automation.js';

export type AutomationCatalogueState = 'loading' | 'ready' | 'unavailable' | 'error';

export interface ICreateAutomationOptions {
	readonly name: string;
	readonly prompt: string;
	readonly schedule: IAutomationSchedule;
	readonly target: AutomationTarget;
	readonly enabled?: boolean;
}

export interface IUpdateAutomationOptions {
	readonly name?: string;
	readonly prompt?: string;
	readonly schedule?: IAutomationSchedule;
	readonly target?: AutomationTarget;
	readonly enabled?: boolean;
}

export type IGuardedAutomationUpdateResult =
	| { readonly kind: 'updated'; readonly automation: IAutomationDescriptor }
	| { readonly kind: 'conflict'; readonly current: IAutomationDescriptor | undefined };

export type IAutomationRunRequestResult = {
	readonly kind: 'dispatched';
	readonly run: IAutomationRun;
	readonly whenCompleted: Promise<void>;
	cancel(): void;
};

export interface IAutomationProviderDescriptor {
	readonly id: string;
	readonly label: string;
}

/** Provider-owned frontend catalogues; persistence and execution remain on the host. */
export interface IAutomationStore {
	readonly catalogueState: IObservable<AutomationCatalogueState>;
	/** History failures do not invalidate definitions already confirmed by the host. */
	readonly historyState?: IObservable<AutomationCatalogueState>;
	readonly automations: IObservable<readonly IAutomationDescriptor[]>;
	readonly runs: IObservable<readonly IAutomationRun[]>;
	refresh(): Promise<void>;
	getAutomation(id: string): IAutomationDescriptor | undefined;
	createAutomation(options: ICreateAutomationOptions): Promise<IAutomationDescriptor>;
	updateAutomation(id: string, patch: IUpdateAutomationOptions): Promise<IAutomationDescriptor>;
	updateAutomationIfUnchanged(
		id: string,
		patch: IUpdateAutomationOptions,
		expected: IAutomationDescriptor,
	): Promise<IGuardedAutomationUpdateResult>;
	deleteAutomation(id: string): Promise<void>;
	runAutomation(id: string, token?: CancellationToken): Promise<IAutomationRunRequestResult>;
	stopRun(run: IAutomationRun): Promise<void>;
	readRunResult(run: IAutomationRun): Promise<IAutomationRunResult>;
	previewSchedule(providerId: string, schedule: IAutomationSchedule): Promise<readonly number[]>;
	canStopRun(run: IAutomationRun): boolean;
	canRunAutomation(id: string): boolean;
	canUpdateAutomation(id: string): boolean;
	canDeleteAutomation(id: string): boolean;
}

export interface IAutomationService extends IAutomationStore {
	readonly availableProviders: IObservable<readonly IAutomationProviderDescriptor[]>;
	canCreateAutomation(providerId: string | undefined): boolean;
}

export const IAutomationService = createServiceIdentifier<IAutomationService>('automationService');
