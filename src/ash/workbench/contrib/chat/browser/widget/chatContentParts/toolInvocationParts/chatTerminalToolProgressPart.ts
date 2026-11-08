import { h } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { IClipboardService } from '../../../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import type { IAgentCommandTerminalTarget } from '../../../../../../../platform/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { ChatToolOutputSubPart } from './chatToolOutputPart.js';
import type { IToolOutputPresentation } from '../chatToolInputOutputContentPart.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { TerminalChatCommandId } from '../../../../../terminal/terminalContribChatExports.js';
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
	public hasRealOutput = false;
	private readonly command: HTMLElement;
	private readonly directory: HTMLElement;
	private readonly copy: Button;
	private readonly terminalActions: HTMLElement;
	private terminalTarget: IAgentCommandTerminalTarget | undefined;
	private readonly output: ChatToolOutputSubPart;

	constructor(document: Document,
		@IInstantiationService instantiation: IInstantiationService,
		@IClipboardService clipboard: IClipboardService,
		@INotificationService notifications: INotificationService,
		@ICommandService commands: ICommandService,
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
		this.terminalActions = h(document, 'div');
		this.terminalActions.className = 'ash-chat-tool-terminal-actions';
		this.terminalActions.hidden = true;
		for (const [label, takeInput] of [
			[localize('chat.tool.openAgentTerminal', 'Show Terminal'), false],
			[localize('chat.tool.takeAgentTerminalInput', 'Take Over Terminal Input'), true],
		] as const) {
			this._register(new Button(this.terminalActions, {
				...defaultButtonStyles, label, presentation: 'secondary',
				onClick: () => {
					const target = this.terminalTarget;
					if (target) void commands.executeCommand(TerminalChatCommandId.RevealAgentCommand, target, takeInput).then(() => {
						if (takeInput && !this.isDisposed) status(localize('chat.tool.agentTerminalInputTaken', 'You now control the Agent terminal input.'));
					}).catch(() => {
						if (!this.isDisposed) notifications.error(localize('chat.tool.agentTerminalUnavailable', 'Could not connect to the Agent terminal. It may have ended or be controlled by another window.'));
					});
				},
			}));
		}
		actions.append(this.terminalActions);
		this.output = this._register(instantiation.createInstance(ChatToolOutputSubPart, document));
		this._register(this.output.onDidChangeHeight(() => this.changedHeight.fire()));
		this.domNode.append(this.command, this.directory, actions, this.output.domNode);
	}

	public render(invocation: IChatToolInvocation, source: IChatListItem['attachmentSource'], options: { readonly generatedImages: boolean; }): void {
		const session = getShellTerminalSession(invocation);
		const presentation = session?.output ?? getShellCommandOutput(invocation);
		this.terminalTarget = !invocation.stopped && session && invocation.commandTerminalSource
			? { ...invocation.commandTerminalSource, toolCallId: invocation.call.toolCallId, commandSessionId: session.id }
			: undefined;
		this.terminalActions.hidden = !this.terminalTarget;
		const running = !invocation.result && !invocation.stopped && !invocation.waitingFor
			&& (invocation.executionStarted === true || invocation.output.length > 0);
		if (running && !this.active) { this.executed.fire(); }
		const changed = this.lastOutput !== invocation.output;
		this.lastOutput = invocation.output;
		this.hasRealOutput = presentation
			? !!(presentation.stdout.trim() || presentation.stderr.trim())
			: this.lastOutput.some(part => part.text.trim().length > 0);
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
		this.output.render(invocation, source, options, presentation);
	}

	public getFileTreeInfos() { return this.output.getFileTreeInfos(); }
	public getLastFocusedFileTree() { return this.output.getLastFocusedFileTree(); }

	public get codeblocks() { return this.output.codeblocks; }

	public setVisible(visible: boolean): void {
		this.output.setVisible(visible);
	}
}

function getShellTerminalSession(invocation: IChatToolInvocation): { id: string; output: IToolOutputPresentation; } | undefined {
	const { call, result } = invocation;
	if (call.name !== 'shell-session' || !result || result.isError || !isLocalCommand(call)) return undefined;
	try {
		const session = JSON.parse(result.text);
		if (session?.terminal !== true || session.status !== 'running' || typeof session.session_id !== 'string' || !/^cmd-[a-f0-9]{32}$/i.test(session.session_id)
			|| typeof session.stdout?.text !== 'string' || typeof session.stderr?.text !== 'string') return undefined;
		return {
			id: session.session_id,
			output: { stdout: session.stdout.text, stderr: session.stderr.text, result: localize('chat.tool.agentTerminalStarted', 'Terminal session started.') },
		};
	} catch {
		return undefined;
	}
}

function isLocalCommand(call: IChatToolInvocation['call']): boolean {
	return call.binding?.sourceChain.some(source => source.type === 'product' && source.component === 'ash-app-server') ?? false;
}

/** Built-in shell results carry process output in the model-facing JSON envelope. */
function getShellCommandOutput(invocation: IChatToolInvocation): IToolOutputPresentation | undefined {
	const { call, result, output } = invocation;
	if (call.name !== 'shell-command' || result?.isError || !isLocalCommand(call)) return undefined;
	const content = result?.content;
	if (content?.length && (content.length !== 1 || content[0].type !== 'text')) return undefined;
	const text = content?.[0]?.type === 'text' ? content[0].text : result?.text
		?? (output.length === 1 && output[0].stream === 'stdout' ? output[0].text : undefined);
	if (!text?.startsWith('{')) return undefined;
	try {
		const envelope = JSON.parse(text);
		const command = envelope?.tool === 'shell-command' ? envelope.result : undefined;
		if (!command || typeof command.stdout !== 'string' || typeof command.stderr !== 'string'
			|| typeof command.stdout_truncated !== 'boolean' || typeof command.stderr_truncated !== 'boolean'
			|| (command.exit_code !== null && !Number.isInteger(command.exit_code))) return undefined;
		const status = command.exit_code === null
			? localize('chat.tool.commandNoExitCode', 'Process ended without an exit code.')
			: localize('chat.tool.commandExitCode', 'Exit code: {0}', command.exit_code);
		const details = [status];
		if (!command.stdout && !command.stderr) details.push(localize('chat.tool.commandNoOutput', 'No output.'));
		if (command.stdout_truncated) details.push(localize('chat.tool.commandStdoutTruncated', 'Standard output was truncated.'));
		if (command.stderr_truncated) details.push(localize('chat.tool.commandStderrTruncated', 'Standard error was truncated.'));
		return { stdout: command.stdout, stderr: command.stderr, result: details.join('\n') };
	} catch {
		return undefined;
	}
}
