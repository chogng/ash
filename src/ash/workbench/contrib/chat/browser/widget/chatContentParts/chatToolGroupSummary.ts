import { getNLSLanguage, localize } from '../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { isImageGenerationToolInvocation } from './toolInvocationParts/chatToolPartUtilities.js';

type ToolActivityState = 'pending' | 'waitingForApproval' | 'waitingForPermissions' | 'waitingForUserInput' | 'waitingForCapability' | 'running' | 'completed' | 'failed' | 'stopped';

/** Projects one call's current status from its execution evidence. */
export function getToolActivityPresentation(invocation: IChatToolInvocation): { readonly state: ToolActivityState; readonly label: string; } {
	const { call, result, stopped, output, waitingFor, executionStarted } = invocation;
	const imageGeneration = isImageGenerationToolInvocation(invocation);
	const activity = getActivityLabel(call);
	let state: ToolActivityState;
	let label: string;
	if (result) {
		state = result.isError ? 'failed' : 'completed';
		if (imageGeneration) {
			label = result.isError ? localize('chat.imageGeneration.failed', 'Image generation failed') : localize('chat.imageGeneration.completed', 'Generated image');
		} else {
			label = result.isError ? localize('chat.tool.failed', '{0} · Failed', activity) : localize('chat.tool.completed', '{0} · Completed', activity);
		}
	} else if (stopped) {
		state = 'stopped';
		label = imageGeneration ? localize('chat.imageGeneration.stopped', 'Image generation stopped') : localize('chat.tool.stopped', '{0} · No result', activity);
	} else if (invocation.streaming) {
		state = 'pending';
		label = localize('chat.tool.preparing', '{0} · Receiving arguments', activity);
	} else if (waitingFor) {
		switch (waitingFor) {
			case 'approval':
			case 'toolResultReview':
				state = 'waitingForApproval';
				label = waitingFor === 'toolResultReview'
					? localize('chat.resultReview.waiting', '{0} · Awaiting result review', activity)
					: localize('chat.tool.awaitingApproval', '{0} · Awaiting approval', activity);
				break;
			case 'permissions':
				state = 'waitingForPermissions';
				label = localize('chat.tool.awaitingPermissions', '{0} · Awaiting permissions', activity);
				break;
			case 'userInput':
				state = 'waitingForUserInput';
				label = localize('chat.tool.awaitingUserInput', '{0} · Awaiting your response', activity);
				break;
			case 'dynamicTool':
				state = 'waitingForCapability';
				label = localize('chat.tool.awaitingCapability', '{0} · Awaiting client tool', activity);
				break;
		}
	} else if (imageGeneration) {
		state = 'running';
		label = localize('chat.imageGeneration.placeholder', 'Generating image');
	} else if (executionStarted || output.length > 0) {
		state = 'running';
		label = localize('chat.tool.running', '{0} · Running', activity);
	} else {
		state = 'pending';
		label = localize('chat.tool.pending', '{0} · Awaiting result', activity);
	}
	return { state, label };
}

/** Describes adjacent tool outcomes without reading their arguments or tool output. */
export function getToolGroupSummary(tools: readonly IChatToolInvocation[]): string {
	const states = new Map(tools.map(tool => [tool.call.toolCallId, getToolActivityPresentation(tool).state]));
	let completed = 0;
	let failed = 0;
	let stopped = 0;
	for (const state of states.values()) {
		if (state === 'completed') completed++;
		else if (state === 'failed') failed++;
		else if (state === 'stopped') stopped++;
	}
	const pending = states.size - completed - failed - stopped;
	const outcomes = [
		completed && localize('chat.tool.group.completed', '{0} completed', completed),
		failed && localize('chat.tool.group.failed', '{0} failed', failed),
		stopped && localize('chat.tool.group.stopped', '{0} stopped', stopped),
		pending && localize('chat.tool.group.pending', '{0} pending', pending),
	].filter((outcome): outcome is string => typeof outcome === 'string');
	return new Intl.ListFormat(getNLSLanguage()).format(outcomes);
}

function getActivityLabel(call: IChatToolInvocation['call']): string {
	const activity = call.binding?.activity;
	switch (activity?.type) {
		case 'read': return localize('chat.tool.activity.read', 'Read {0}', activity.target);
		case 'fileRead': return localize('chat.tool.activity.read', 'Read {0}', activity.path);
		case 'search': return localize('chat.tool.activity.search', 'Search {0}', activity.target);
		case 'fileSearch': return localize('chat.tool.activity.searchIn', 'Search {0} in {1}', activity.pattern, activity.path);
		case 'list': return localize('chat.tool.activity.list', 'List {0}', activity.target);
		case 'fileList': return localize('chat.tool.activity.listIn', 'List {0} in {1}', activity.pattern, activity.path);
		case 'edit': return localize('chat.tool.activity.edit', 'Edit {0}', activity.target);
		case 'fileEdit': return localize('chat.tool.activity.edit', 'Edit {0}', activity.path);
		case 'command': return localize('chat.tool.activity.command', 'Run {0}', [activity.program, ...activity.arguments.map(argument => JSON.stringify(argument))].join(' '));
		case 'run': return localize('chat.tool.activity.run', 'Run {0}', call.name);
		default: return call.name;
	}
}
