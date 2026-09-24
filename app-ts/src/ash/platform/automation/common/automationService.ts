import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type AutomationSchedule = { readonly type: 'once'; readonly at: number } | { readonly type: 'interval'; readonly anchor: number; readonly minutes: number } | { readonly type: 'weekly'; readonly timezone: string; readonly weekdays: readonly number[]; readonly hour: number; readonly minute: number };
export type AutomationSession = { readonly type: 'new' } | { readonly type: 'continue'; readonly sessionId: string; readonly threadId: string };
export type AutomationStatus = 'enabled' | 'paused';
export type AutomationRunStatus = 'pending' | 'running' | 'needsInput' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'skipped';

export interface AutomationDefinition {
	readonly title: string;
	readonly prompt: string;
	readonly directory: string;
	readonly session: AutomationSession;
	readonly schedule: AutomationSchedule;
}

export interface Automation {
	readonly id: string;
	readonly revision: number;
	readonly definition: AutomationDefinition;
	readonly status: AutomationStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly nextRunAt: number | null;
}

export interface AutomationRun {
	readonly id: string;
	readonly automationId: string;
	readonly status: AutomationRunStatus;
	readonly scheduledAt: number;
	readonly startedAt: number | null;
	readonly finishedAt: number | null;
	readonly sessionId: string | null;
	readonly threadId: string | null;
	readonly message: string | null;
}

/** Schedules and run history belong to the shared backend profile. */
export interface IAutomationService {
	readonly onDidChange: Event<void>;
	list(): Promise<readonly Automation[]>;
	save(id: string, revision: number, definition: AutomationDefinition, status: AutomationStatus): Promise<Automation>;
	delete(id: string, revision: number): Promise<void>;
	run(id: string): Promise<AutomationRun>;
	runs(id: string): Promise<readonly AutomationRun[]>;
	stop(runId: string): Promise<AutomationRun>;
}

export const IAutomationService = createServiceIdentifier<IAutomationService>('automationService');
