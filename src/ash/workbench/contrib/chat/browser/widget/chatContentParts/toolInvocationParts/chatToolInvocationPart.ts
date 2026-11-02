import { ChatTerminalToolProgressPart } from './chatTerminalToolProgressPart.js';
import { TerminalToolAutoExpand } from './terminalToolAutoExpand.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { ChatMcpAppSubPart } from './chatMcpAppSubPart.js';
import type { IChatMcpAppDelegate } from './chatMcpAppModel.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatToolOutputSubPart } from './chatToolOutputPart.js';
import { ChatToolProgressSubPart } from './chatToolProgressPart.js';
import { isImageGenerationToolInvocation } from './chatToolPartUtilities.js';
import type { IChatContentPart } from '../chatContentParts.js';

/** A view of one backend call; it never starts a tool or infers success from a closed Turn. */
export class ChatToolInvocationPart extends Disposable implements IChatContentPart {
	public getFileTreeInfos() { return this.output.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTree() { return this.output.getLastFocusedFileTree(); }
	public readonly domNode: HTMLElement;
	public readonly toolCallId: string;
	private readonly details: HTMLDetailsElement;
	private readonly progress: ChatToolProgressSubPart;
	private readonly output: ChatToolOutputSubPart | ChatTerminalToolProgressPart;
	private readonly app = this._register(new MutableDisposable<ChatMcpAppSubPart>());
	private readonly appChanges = this._register(new MutableDisposable());
	private visible = true;
	private autoExpanded = false;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(
		document: Document,
		private invocation: IChatToolInvocation,
		source: IChatListItem['attachmentSource'],
		private readonly appDelegate: IChatMcpAppDelegate | undefined,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.toolCallId = invocation.call.toolCallId;
		this.domNode = h(document, 'div');
		this.domNode.dataset.toolCallId = this.toolCallId;
		this.progress = this._register(new ChatToolProgressSubPart(document));
		this.details = this.progress.domNode;
		this._register(this.progress.onDidChangeHeight(() => {
			this.app.value?.setVisible(this.visible && this.details.open);
			this._onDidChangeHeight.fire();
		}));
		this.output = this._register(invocation.call.binding?.activity?.type === 'command'
			? this.instantiation.createInstance(ChatTerminalToolProgressPart, document)
			: this.instantiation.createInstance(ChatToolOutputSubPart, document));
		this._register(this.output.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
		if (this.output instanceof ChatTerminalToolProgressPart) {
			const terminal = this.output;
			const autoExpand = this._register(new TerminalToolAutoExpand({
				onCommandExecuted: terminal.onCommandExecuted,
				onCommandFinished: terminal.onCommandFinished,
				onWillData: terminal.onWillData,
				shouldAutoExpand: () => this.visible && !this.details.open && !this.progress.hasUserInteracted,
				hasRealOutput: () => terminal.hasRealOutput,
			}));
			this._register(autoExpand.onDidRequestExpand(() => { this.autoExpanded = true; this.details.open = true; }));
		}
		this.details.append(this.output.domNode);
		this.domNode.append(this.details);
		this._register(toDisposable(() => this.domNode.remove()));
		this.render(invocation, source);
	}

	/** Updates text in place so a streaming result retains its disclosure and keyboard focus. */
	public render(invocation: IChatToolInvocation, source?: IChatListItem['attachmentSource']): void {
		this.invocation = invocation;
		const { call, result } = invocation;
		this.progress.render(invocation);
		const imageGeneration = isImageGenerationToolInvocation(invocation);
		const content = result?.content ?? [];
		this.output.render(invocation, source, {
			generatedImages: imageGeneration && !!result && !result.isError && content.some(part => part.type === 'imageUrl' || part.type === 'imageAttachment'),
		});
		if (this.output instanceof ChatTerminalToolProgressPart && !this.progress.hasUserInteracted) {
			if (result?.isError && this.configuration.getValue<boolean>(ChatConfiguration.AutoExpandToolFailures) !== false) {
				this.autoExpanded = true;
				this.details.open = true;
			} else if (result && !result.isError && this.autoExpanded) {
				this.details.open = false;
				this.autoExpanded = false;
			}
		}
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
				app.setVisible(this.visible && this.details.open);
			} else {
				this.app.value.update(call.argumentsJson, result);
			}
		} else {
			this.appChanges.clear();
			this.app.clear();
		}
	}

	public hasSameContent(other: IChatListItem): boolean {
		const next = other.toolInvocation;
		const current = this.invocation;
		if (current === next) { return true; }
		return !!next && current.call === next.call && current.result === next.result && current.stopped === next.stopped
			&& current.waitingFor === next.waitingFor && current.executionStarted === next.executionStarted
			&& current.output.length === next.output.length && current.output.every((output, index) => output === next.output[index]);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.app.value?.setVisible(visible && this.details.open);
		this.output.setVisible(visible);
	}
}
