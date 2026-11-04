import { h } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { IClipboardService } from '../../../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { ChatToolOutputSubPart } from './chatToolOutputPart.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import '../media/chatTerminalToolProgressPart.css';

/** Command coordinates come from the frozen binding; command output remains literal evidence. */
export class ChatTerminalToolProgressPart extends BaseChatToolInvocationSubPart {
	private readonly executed = this._register(new Emitter<void>());
	public readonly onCommandExecuted = this.executed.event;
	private readonly finished = this._register(new Emitter<void>());
	public readonly onCommandFinished = this.finished.event;
	private readonly data = this._register(new Emitter<void>());
	public readonly onWillData = this.data.event;
	private active = false;
	private lastOutput: IChatToolInvocation['output'] = [];
	public get hasRealOutput(): boolean { return this.lastOutput.some(part => part.text.trim().length > 0); }
	private readonly command: HTMLElement;
	private readonly directory: HTMLElement;
	private readonly copy: Button;
	private readonly output: ChatToolOutputSubPart;

	constructor(document: Document,
		@IInstantiationService instantiation: IInstantiationService,
		@IClipboardService clipboard: IClipboardService,
		@INotificationService notifications: INotificationService,
	) {
		super(h(document, 'div'));
		this.domNode.className = 'ash-chat-tool-io';
		this.command = h(document, 'pre');
		this.command.tabIndex = 0;
		this.command.setAttribute('aria-label', localize('chat.approval.command', 'Command and arguments'));
		this.directory = h(document, 'p');
		const actions = h(document, 'div');
		this.copy = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('chat.tool.copyCommand', 'Copy command and arguments'),
			presentation: 'secondary',
			onClick: () => {
				void clipboard.writeText(this.command.textContent ?? '').then(() => {
					if (!this.isDisposed) { status(localize('chat.tool.commandCopied', 'Command and arguments copied.')); }
				}, error => {
					if (!this.isDisposed) { notifications.error(localize('chat.tool.commandCopyFailed', 'Could not copy the command: {0}', String(error))); }
				});
			},
		}));
		this.copy.domNode.classList.add('ash-chat-tool-copy-command');
		this.output = this._register(instantiation.createInstance(ChatToolOutputSubPart, document));
		this._register(this.output.onDidChangeHeight(() => this.changedHeight.fire()));
		this.domNode.append(this.command, this.directory, actions, this.output.domNode);
	}

	public render(invocation: IChatToolInvocation, source: IChatListItem['attachmentSource'], options: { readonly generatedImages: boolean; }): void {
		const running = !invocation.result && !invocation.stopped && !invocation.waitingFor
			&& (invocation.executionStarted === true || invocation.output.length > 0);
		if (running && !this.active) { this.executed.fire(); }
		const changed = this.lastOutput !== invocation.output;
		this.lastOutput = invocation.output;
		if (running && changed && this.hasRealOutput) { this.data.fire(); }
		if (!running && this.active) { this.finished.fire(); }
		this.active = running;
		const activity = invocation.call.binding?.activity;
		const command = activity?.type === 'command' ? activity : undefined;
		this.command.textContent = command ? `${command.program} ${JSON.stringify(command.arguments)}` : '';
		this.command.hidden = !command;
		this.directory.textContent = command ? localize('chat.tool.workingDirectory', 'Working directory: {0}', command.workingDirectory) : '';
		this.directory.hidden = !command;
		this.copy.enabled = command !== undefined;
		this.output.render(invocation, source, options);
	}

	public getFileTreeInfos() { return this.output.getFileTreeInfos(); }
	public getLastFocusedFileTree() { return this.output.getLastFocusedFileTree(); }

	public get codeblocks() { return this.output.codeblocks; }

	public setVisible(visible: boolean): void {
		this.output.setVisible(visible);
	}
}
