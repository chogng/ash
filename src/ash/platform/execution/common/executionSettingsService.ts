import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { ApprovalMode } from '../../sessions/common/approvalModes.js';

export interface ExecutionSettings {
	readonly approvalMode: ApprovalMode;
	readonly commandFileAccess: 'readOnly' | 'directoryWrite';
	readonly commandNetworkAccess: 'denied' | 'allowed';
}

export interface ExecutionSettingsSnapshot {
	readonly revision: number;
	readonly settings: ExecutionSettings;
}

/** Backend profile defaults; directory grants and per-Turn approval remain separate authorities. */
export interface IExecutionSettingsService {
	readonly onDidChange: Event<void>;
	read(): Promise<ExecutionSettingsSnapshot>;
	configure(settings: ExecutionSettings, expectedRevision: number): Promise<void>;
}

export const IExecutionSettingsService = createServiceIdentifier<IExecutionSettingsService>('executionSettingsService');
