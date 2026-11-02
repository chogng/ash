import { getToolSpecificDataDescription } from '../../../accessibility/chatResponseAccessibleView.js';
import { ChatMcpAppSubPart, type IChatMcpAppDelegate } from './chatMcpAppSubPart.js';
import { ChatResourceGroupWidget } from '../chatResourceGroupWidget.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import '../media/chatCollapsibleContentPart.css';
import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatImageGenerationProgressPart } from './chatImageGenerationProgressPart.js';
import { ChatGeneratedImageResultSubPart } from './chatGeneratedImageResultSubPart.js';
import { ChatCollapsibleInputOutputContentPart } from '../chatToolInputOutputContentPart.js';

/** A view of one backend call; it never starts a tool or infers success from a closed Turn. */
export class ChatToolInvocationPart extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly toolCallId: string;
	private readonly details: HTMLDetailsElement;
	private readonly summary: HTMLElement;
	private readonly statusIcon: HTMLElement;
	private readonly label: HTMLElement;
	private readonly source: HTMLElement;
	private readonly activity: HTMLElement;
	private readonly inputOutput: ChatCollapsibleInputOutputContentPart;
	private readonly mediaChanges = this._register(new MutableDisposable());
	private readonly app = this._register(new MutableDisposable<ChatMcpAppSubPart>());
	private readonly appChanges = this._register(new MutableDisposable());
	private readonly resources = this._register(new MutableDisposable<ChatResourceGroupWidget>());
	private readonly resourceChanges = this._register(new MutableDisposable());
	private readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	private readonly imageProgress = this._register(new MutableDisposable<ChatImageGenerationProgressPart>());
	private readonly generatedImages = this._register(new MutableDisposable<ChatGeneratedImageResultSubPart>());
	private readonly imageChanges = this._register(new MutableDisposable());
	private visible = true;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(document: Document, invocation: NonNullable<IChatListItem['toolInvocation']>, source: IChatListItem['attachmentSource'], private readonly appDelegate: IChatMcpAppDelegate | undefined, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.toolCallId = invocation.call.toolCallId;
		this.domNode = h(document, 'div');
		this.domNode.dataset.toolCallId = this.toolCallId;
		this.details = h(document, 'details');
		this.details.className = 'ash-chat-tool-invocation';
		this.summary = h(document, 'summary');
		this.summary.setAttribute('aria-live', 'polite');
		this.summary.setAttribute('aria-atomic', 'true');
		this.statusIcon = h(document, 'span');
		this.statusIcon.className = 'ash-chat-tool-status-icon';
		this.statusIcon.setAttribute('aria-hidden', 'true');
		this.label = h(document, 'span');
		this.summary.append(this.statusIcon, this.label);
		this.source = h(document, 'p');
		this.source.className = 'ash-chat-tool-source';
		this.activity = h(document, 'pre');
		this.inputOutput = this._register(new ChatCollapsibleInputOutputContentPart(document));
		this._register(this.inputOutput.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
		this.details.append(this.summary, this.source, this.activity, this.inputOutput.domNode);
		this.domNode.append(this.details);
		this._register(addDisposableListener(this.details, 'toggle', () => this._onDidChangeHeight.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
		this.render(invocation, source);
	}

	/** Updates text in place so a streaming result retains its disclosure and keyboard focus. */
	public render(invocation: NonNullable<IChatListItem['toolInvocation']>, source?: IChatListItem['attachmentSource']): void {
		const { call, result, stopped, output, waitingFor, executionStarted } = invocation;
		const imageGeneration = call.name === 'imagegen' || call.binding?.sourceChain.some(source => source.type === 'mcp' && source.remoteName === 'imagegen') === true;
		const content = result?.content ?? [];
		const generated = imageGeneration && result && !result.isError && content.some(part => part.type === 'imageUrl' || part.type === 'imageAttachment');
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
		} else if (waitingFor) {
			switch (waitingFor) {
				case 'approval':
					state = 'waitingForApproval';
					label = localize('chat.tool.awaitingApproval', '{0} · Awaiting approval', activity);
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
		if (this.details.dataset.state !== state) {
			this.details.dataset.state = state;
			this.details.setAttribute('aria-busy', String(state === 'pending' || state === 'running'));
			this.details.classList.toggle('running', state === 'running');
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
		this.details.classList.toggle('error', result?.isError === true);
		if (imageGeneration && !result && !stopped && !waitingFor) {
			if (!this.imageProgress.value) {
				const progress = this.imageProgress.value = this.instantiation.createInstance(ChatImageGenerationProgressPart, this.domNode.ownerDocument);
				this.domNode.append(progress.domNode);
				progress.setVisible(this.visible);
			}
		} else if (!generated) this.imageProgress.clear();
		if (generated) {
			if (!this.generatedImages.value) {
				const progress = this.imageProgress.value;
				const origin = progress && this.visible ? { container: progress.domNode, size: progress.size, takeSurface: () => progress.takeSurface() } : undefined;
				if (!origin) this.imageProgress.clear();
				const images = this.generatedImages.value = this.instantiation.createInstance(ChatGeneratedImageResultSubPart, this.domNode.ownerDocument, content, source, origin);
				this.domNode.append(images.domNode);
				if (progress?.domNode.hidden) this.imageProgress.clear();
				this.imageChanges.value = images.onDidChangeHeight(() => {
					if (this.imageProgress.value?.domNode.hidden) this.imageProgress.clear();
					this._onDidChangeHeight.fire();
				});
				images.setVisible(this.visible);
			} else this.generatedImages.value.render(content, source);
		} else { this.imageChanges.clear(); this.generatedImages.clear(); }
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
		this.setText(this.activity, getToolSpecificDataDescription(call.binding?.activity));
		this.inputOutput.render(invocation);
		const mediaContent = generated ? content.map(part => part.type === 'imageUrl' || part.type === 'imageAttachment' ? { type: 'text' as const, text: '' } : part) : content;
		if (mediaContent.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!this.media.value) {
				const media = this.instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: this.domNode.ownerDocument, variables: mediaContent, source });
				this.media.value = media;
				this.details.append(media.domNode);
				this.mediaChanges.value = media.onDidChangeHeight(() => this._onDidChangeHeight.fire());
			} else this.media.value.updateVariables(mediaContent, source);
		} else { this.mediaChanges.clear(); this.media.clear(); }
		if (content.some(part => part.type === 'artifact' && part.artifact.source.type !== 'mcpApp' && part.artifact.source.type !== 'viewMetadata')) {
			if (!this.resources.value) {
				const resources = this.instantiation.createInstance(ChatResourceGroupWidget, this.domNode.ownerDocument);
				this.resources.value = resources;
				this.details.append(resources.domNode);
				this.resourceChanges.value = resources.onDidChangeHeight(() => this._onDidChangeHeight.fire());
			}
			this.resources.value.render(content, JSON.stringify([source?.sessionId, source?.threadId, result?.itemId]), source);
		} else { this.resourceChanges.clear(); this.resources.clear(); }
		const appIndex = content.findIndex(part => part.type === 'artifact' && part.artifact.source.type === 'mcpApp');
		const artifact = content[appIndex];
		if (source && result && artifact?.type === 'artifact' && artifact.artifact.source.type === 'mcpApp') {
			const coordinate = { sessionId: source.sessionId, threadId: source.threadId, itemId: result.itemId, contentIndex: appIndex };
			const identity = JSON.stringify([coordinate, artifact.artifact.source, artifact.artifact.contentDigest]);
			if (this.app.value?.identity !== identity) {
				const app = this.instantiation.createInstance(ChatMcpAppSubPart, this.domNode.ownerDocument, coordinate, artifact.artifact, call.argumentsJson, result, this.appDelegate);
				this.app.value = app;
				this.appChanges.value = app.onDidChangeHeight(() => this._onDidChangeHeight.fire());
				this.details.append(app.domNode);
			} else this.app.value.update(call.argumentsJson, result);
		} else { this.appChanges.clear(); this.app.clear(); }
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.media.value?.setVisible(visible);
		this.imageProgress.value?.setVisible(visible);
		this.generatedImages.value?.setVisible(visible);
	}

	private setText(element: HTMLElement, text: string): void {
		if (element.textContent !== text) element.textContent = text;
		element.hidden = !text;
	}
}

/** Only backend activity metadata determines the label; tool names and arguments are not guessed. */
function getActivityLabel(call: NonNullable<IChatListItem['toolInvocation']>['call']): string {
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
