import type { HookEvent } from '../../../../../platform/agentHost/common/appServerApi.js';

/** Ash lifecycle events offered by Hook configuration; legacy declarations remain readable. */
export const HookEvents = [
	'preToolUse', 'postToolUse', 'postToolUseFailure', 'postToolBatch', 'permissionDenied',
	'notification', 'userPromptSubmit', 'userPromptExpansion', 'sessionStart', 'stop', 'stopFailure',
	'subagentStart', 'subagentStop', 'preCompact', 'postCompact', 'preModelSwitch', 'postModelSwitch',
	'sessionEnd', 'permissionRequest', 'setup', 'teammateIdle', 'taskCreated', 'taskCompleted',
	'elicitation', 'elicitationResult', 'configChange', 'instructionsLoaded', 'worktreeCreate',
	'worktreeRemove', 'cwdChanged', 'fileChanged', 'directoryAdded', 'messageDisplay',
] as const satisfies readonly HookEvent[];
