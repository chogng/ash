import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const HookEvents = [
	'preToolUse', 'postToolUse', 'postToolUseFailure', 'postToolBatch', 'permissionDenied',
	'notification', 'userPromptSubmit', 'userPromptExpansion', 'sessionStart', 'stop', 'stopFailure',
	'subagentStart', 'subagentStop', 'preCompact', 'postCompact', 'preModelSwitch', 'postModelSwitch',
	'sessionEnd', 'permissionRequest', 'setup', 'teammateIdle', 'taskCreated', 'taskCompleted',
	'elicitation', 'elicitationResult', 'configChange', 'instructionsLoaded', 'worktreeCreate',
	'worktreeRemove', 'cwdChanged', 'fileChanged', 'directoryAdded', 'messageDisplay',
] as const;

export type HookEvent = typeof HookEvents[number] | 'beforeTool' | 'afterTool' | 'turnCompleted';

export interface HookDeclaration {
	readonly id: string;
	readonly event: HookEvent;
	readonly enabled: boolean;
	readonly toolNames: readonly string[];
	readonly program: string;
	readonly args: readonly string[];
}

export interface HookSource {
	readonly namespace: string;
	readonly configPath: string;
	readonly hooks: readonly HookDeclaration[];
}

/** Backend declarations, including disabled Hooks, with their authoritative configuration paths. */
export interface IHooksService {
	readonly onDidChange: Event<void>;
	/** Available only in hosts that can open their local profile's TOML. */
	readonly userConfigurationEditor: (() => Promise<void>) | undefined;
	read(sessionId?: string): Promise<readonly HookSource[]>;
}

export const IHooksService = createServiceIdentifier<IHooksService>('hooksService');
