import { ChatMcpAppSubPart, type IChatMcpAppDelegate } from './chatMcpAppSubPart.js';
import { ChatResourceGroupWidget } from '../chatResourceGroupWidget.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import '../media/chatCollapsibleContentPart.css';
import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../../nls.js';
import type { ChatToolCallBinding } from '../../../../../../services/chat/common/chatService.js';
import type { IChatListItem } from '../../chatListItems.js';

/** A view of one backend call; it never starts a tool or infers success from a closed Turn. */
export class ChatToolInvocationPart extends Disposable {
	public readonly domNode: HTMLDetailsElement;
	public readonly toolCallId: string;
	private readonly summary: HTMLElement;
	private readonly source: HTMLElement;
	private readonly activity: HTMLElement;
	private readonly parameters: HTMLElement;
	private readonly stdout: HTMLElement;
	private readonly stderr: HTMLElement;
	private readonly result: HTMLElement;
	private readonly mediaChanges = this._register(new MutableDisposable());
	private readonly app = this._register(new MutableDisposable<ChatMcpAppSubPart>());
	private readonly appChanges = this._register(new MutableDisposable());
	private readonly resources = this._register(new MutableDisposable<ChatResourceGroupWidget>());
	private readonly resourceChanges = this._register(new MutableDisposable());
	private readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(document: Document, invocation: NonNullable<IChatListItem['toolInvocation']>, source: IChatListItem['attachmentSource'], private readonly appDelegate: IChatMcpAppDelegate | undefined, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.toolCallId = invocation.call.toolCallId;
		this.domNode = h(document, 'details');
		this.domNode.className = 'ash-chat-tool-invocation';
		this.domNode.dataset.toolCallId = this.toolCallId;
		this.summary = h(document, 'summary');
		this.source = h(document, 'p');
		this.source.className = 'ash-chat-tool-source';
		this.activity = h(document, 'pre');
		this.parameters = h(document, 'pre');
		this.stdout = h(document, 'pre');
		this.stderr = h(document, 'pre');
		this.stderr.className = 'ash-chat-tool-stderr';
		this.result = h(document, 'pre');
		this.domNode.append(this.summary, this.source, this.activity, this.parameters, this.stdout, this.stderr, this.result);
		this._register(addDisposableListener(this.domNode, 'toggle', () => this._onDidChangeHeight.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
		this.render(invocation, source);
	}

	/** Updates text in place so a streaming result retains its disclosure and keyboard focus. */
	public render(invocation: NonNullable<IChatListItem['toolInvocation']>, source?: IChatListItem['attachmentSource']): void {
		const { call, result, output, stopped } = invocation;
		this.summary.textContent = result
			? result.isError ? localize('chat.tool.failed', '{0} · Failed', call.name) : localize('chat.tool.completed', '{0} · Completed', call.name)
			: stopped ? localize('chat.tool.stopped', '{0} · No result', call.name) : localize('chat.tool.pending', '{0} · Awaiting result', call.name);
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
		if (call.binding?.caller.type === 'codeMode') sources.push(localize('chat.tool.parent', 'Parent call: {0}', call.binding.caller.parentToolCallId));
		this.setText(this.source, sources.join(' · '));
		this.setText(this.activity, activityText(call.binding?.activity));
		this.setText(this.parameters, call.argumentsJson, localize('chat.tool.input', 'Input'));
		this.setText(this.stdout, output.filter(value => value.stream === 'stdout').map(value => value.text).join('\n'), localize('chat.tool.stdout', 'Standard output'));
		this.setText(this.stderr, output.filter(value => value.stream === 'stderr').map(value => value.text).join('\n'), localize('chat.tool.stderr', 'Standard error'));
		const resultText = result?.content ? result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : result?.text ?? '';
		this.setText(this.result, resultText, result?.isError ? localize('chat.tool.error', 'Error') : localize('chat.tool.result', 'Result'));
		const content = result?.content ?? [];
		if (content.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!this.media.value) {
				const media = this.instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: this.domNode.ownerDocument, variables: content, source });
				this.media.value = media;
				this.domNode.append(media.domNode);
				this.mediaChanges.value = media.onDidChangeHeight(() => this._onDidChangeHeight.fire());
			} else this.media.value.updateVariables(content, source);
		} else { this.mediaChanges.clear(); this.media.clear(); }
		if (content.some(part => part.type === 'artifact' && part.artifact.source.type !== 'mcpApp' && part.artifact.source.type !== 'viewMetadata')) {
			if (!this.resources.value) {
				const resources = this.instantiation.createInstance(ChatResourceGroupWidget, this.domNode.ownerDocument);
				this.resources.value = resources;
				this.domNode.append(resources.domNode);
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
				this.domNode.append(app.domNode);
			} else this.app.value.update(call.argumentsJson, result);
		} else { this.appChanges.clear(); this.app.clear(); }
	}

	public setVisible(visible: boolean): void { this.media.value?.setVisible(visible); }

	private setText(element: HTMLElement, text: string, label?: string): void {
		const value = text && label ? `${label}\n${text}` : text;
		if (element.textContent !== value) element.textContent = value;
		element.hidden = !text;
	}
}

function activityText(activity: ChatToolCallBinding['activity']): string {
	if (!activity) return '';
	switch (activity.type) {
		case 'command': return localize('chat.tool.command', 'Command: {0}\nArguments: {1}\nDirectory: {2}', activity.program, JSON.stringify(activity.arguments), activity.workingDirectory);
		case 'fileRead': return localize('chat.tool.read', 'Read: {0}', activity.path);
		case 'fileSearch': return localize('chat.tool.search', 'Search: {0}\nDirectory: {1}', activity.pattern, activity.path);
		case 'fileList': return localize('chat.tool.list', 'List: {0}\nDirectory: {1}', activity.pattern, activity.path);
		case 'fileEdit': return localize('chat.tool.edit', 'Edit: {0}', activity.path);
		case 'read': return localize('chat.tool.read', 'Read: {0}', activity.target);
		case 'search': return localize('chat.tool.searchTarget', 'Search: {0}', activity.target);
		case 'list': return localize('chat.tool.listTarget', 'List: {0}', activity.target);
		case 'edit': return localize('chat.tool.edit', 'Edit: {0}', activity.target);
		case 'run': return localize('chat.tool.run', 'Run');
	}
}
