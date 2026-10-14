import type { URI } from '../../../../../base/common/uri.js';

/** Product schedule values are mapped to the owning provider's backend contract. */
export type IAutomationSchedule =
	| { readonly type: 'once'; readonly at: number; }
	| { readonly type: 'interval'; readonly anchor: number; readonly minutes: number; }
	| { readonly type: 'weekly'; readonly timezone: string; readonly weekdays: readonly number[]; readonly hour: number; readonly minute: number; };

export interface AutomationTarget {
	readonly providerId: string;
	readonly directory: string;
	readonly session: { readonly type: 'new'; } | { readonly type: 'continue'; readonly sessionId: string; readonly threadId: string; };
}

export interface IAutomationDescriptor {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly target: AutomationTarget;
	readonly schedule: IAutomationSchedule;
	readonly enabled: boolean;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly nextRunAt: number | null;
}

export interface IAutomationRun {
	readonly id: string;
	readonly automationId: string;
	readonly providerId: string;
	readonly status: 'pending' | 'running' | 'needsInput' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'skipped';
	readonly scheduledAt: number;
	readonly sessionId: string | null;
	readonly threadId: string | null;
	readonly sessionResource?: URI;
	readonly message: string | null;
}
