import type { URI } from '../../../../../base/common/uri.js';
import type { AutomationSchedule, AutomationSession } from '../../../../../platform/automation/common/automationService.js';

/** Frontend values retain the scheduling formats supported by the Rust authority. */
export type IAutomationSchedule = AutomationSchedule;

export interface AutomationTarget {
	readonly providerId: string;
	readonly directory: string;
	readonly session: AutomationSession;
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
