import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import { getToolSpecificDataDescription } from '../../../accessibility/chatResponseAccessibleView.js';
import { isImageGenerationToolInvocation } from './chatToolPartUtilities.js';
import '../media/chatCollapsibleContentPart.css';

/** Owns the stable disclosure and summary; execution state is projected from transcript evidence. */
export class ChatToolProgressSubPart extends BaseChatToolInvocationSubPart<HTMLDetailsElement> {
	private userInteracted = false;
	public get hasUserInteracted(): boolean { return this.userInteracted; }
	private readonly summary: HTMLElement;
	private readonly statusIcon: HTMLElement;
	private readonly label: HTMLElement;
	private readonly source: HTMLElement;
	private readonly activity: HTMLElement;

	constructor(document: Document) {
		super(h(document, 'details'));
		this.domNode.className = 'ash-chat-tool-invocation';
		this.summary = h(document, 'summary');
		this.summary.setAttribute('aria-live', 'polite');
		this.summary.setAttribute('aria-atomic', 'true');
		this._register(addDisposableListener(this.summary, 'click', () => { this.userInteracted = true; }));
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			if (event.target !== this.summary) { this.userInteracted = true; }
		}));
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => {
			if (!this.summary.contains(event.target as Node | null)) { this.userInteracted = true; }
		}));
		this.statusIcon = h(document, 'span');
		this.statusIcon.className = 'ash-chat-tool-status-icon';
		this.statusIcon.setAttribute('aria-hidden', 'true');
		this.label = h(document, 'span');
		this.summary.append(this.statusIcon, this.label);
		this.source = h(document, 'p');
		this.source.className = 'ash-chat-tool-source';
		this.activity = h(document, 'pre');
		this.domNode.append(this.summary, this.source, this.activity);
		this._register(addDisposableListener(this.domNode, 'toggle', () => this.changedHeight.fire()));
	}

	public render(invocation: IChatToolInvocation): void {
		const { call, result, stopped, output, waitingFor, executionStarted } = invocation;
		const imageGeneration = isImageGenerationToolInvocation(invocation);
		const activity = getActivityLabel(call);
		let state: 'pending' | 'waitingForApproval' | 'waitingForPermissions' | 'waitingForUserInput' | 'waitingForCapability' | 'running' | 'completed' | 'failed' | 'stopped';
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
		if (this.label.textContent !== label) {
			this.label.textContent = label;
		}
		if (this.domNode.dataset.state !== state) {
			this.domNode.dataset.state = state;
			this.domNode.setAttribute('aria-busy', String(state === 'pending' || state === 'running'));
			this.domNode.classList.toggle('running', state === 'running');
			this.statusIcon.replaceChildren();
			const icons = {
				pending: Lxicon.clockface,
				waitingForApproval: Lxicon.lock,
				waitingForPermissions: Lxicon.lock,
				waitingForUserInput: Lxicon.question,
				waitingForCapability: Lxicon.plug,
				running: Lxicon.play,
				completed: Lxicon.check,
				failed: Lxicon.error,
				stopped: Lxicon.stopCircle,
			};
			appendIcon(icons[state], this.statusIcon);
		}
		this.domNode.classList.toggle('error', result?.isError === true);
		const sources = call.binding?.sourceChain.map(source => {
			switch (source.type) {
				case 'product': return localize('chat.tool.product', 'Product: {0}', source.component);
				case 'plugin': return localize('chat.tool.plugin', 'Plugin: {0} ({1})', source.pluginId, source.version);
				case 'mcp': return localize('chat.tool.mcp', 'MCP: {0} / {1}', source.serverId, source.remoteName);
				case 'dynamic': return localize('chat.tool.dynamic', 'Dynamic tool: {0}', source.name);
				case 'extension': return localize('chat.tool.extension', 'Extension: {0}', source.id);
				case 'system': return localize('chat.tool.system', 'System: {0}', source.id);
			}
		}) ?? [];
		if (call.binding?.activity) {
			sources.unshift(localize('chat.tool.name', 'Tool: {0}', call.name));
		}
		if (call.binding?.caller.type === 'codeMode') sources.push(localize('chat.tool.parent', 'Parent call: {0}', call.binding.caller.parentToolCallId));
		this.setText(this.source, sources.join(' · '));
		this.setText(this.activity, call.binding?.activity?.type === 'command' ? '' : getToolSpecificDataDescription(call.binding?.activity));
	}

	private setText(element: HTMLElement, text: string): void {
		if (element.textContent !== text) {
			element.textContent = text;
		}
		element.hidden = !text;
	}
}

/** Only backend activity metadata determines the label; tool names and arguments are not guessed. */
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
