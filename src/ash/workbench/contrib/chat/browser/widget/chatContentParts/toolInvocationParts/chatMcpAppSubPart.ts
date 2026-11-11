import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { AgentAttachmentSource, ChatContentPart, ThreadItem } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { ChatMcpAppModel, type IChatMcpAppDelegate } from './chatMcpAppModel.js';
import '../media/chatMarkdownPart.css';

type ToolResult = Extract<ThreadItem, { readonly type: 'toolResult'; }>;
type Artifact = Extract<ChatContentPart, { readonly type: 'artifact'; }>['artifact'];

/** Owns the App controls and viewport. The model owns the frame and asynchronous operations. */
export class ChatMcpAppSubPart extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly identity: string;
	private readonly viewport: HTMLElement;
	private readonly launch: Button;
	private readonly close: Button;
	private readonly error: HTMLElement;
	private readonly model: ChatMcpAppModel;
	private readonly attachment = this._register(new MutableDisposable());
	private readonly height = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.height.event;
	private visible = true;
	private opened = false;
	public get keepMounted(): boolean { return this.opened; }

	constructor(document: Document, coordinate: AgentAttachmentSource & { readonly contentIndex: number; }, artifact: Artifact, argumentsJson: string, result: ToolResult, delegate: IChatMcpAppDelegate | undefined,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.identity = JSON.stringify([coordinate, artifact.source, artifact.contentDigest]);
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-chat-mcp-app';
		this.domNode.setAttribute('aria-label', localize('chat.mcpApp.label', 'Interactive MCP App'));
		this.launch = this._register(new Button(this.domNode, {
			...defaultButtonStyles, label: localize('chat.mcpApp.open', 'Open interactive view'), presentation: 'secondary',
		}));
		this.close = this._register(new Button(this.domNode, {
			...defaultButtonStyles, label: localize('chat.mcpApp.close', 'Close interactive view'), presentation: 'secondary',
		}));
		this.close.domNode.hidden = true;
		this.error = h(document, 'p');
		this.error.setAttribute('role', 'status');
		this.error.hidden = true;
		this.domNode.append(this.error);
		this.viewport = h(document, 'div');
		this.viewport.className = 'ash-chat-mcp-app-viewport';
		this.viewport.hidden = true;
		this.domNode.append(this.viewport);
		this.model = this._register(instantiation.createInstance(ChatMcpAppModel, coordinate, this.identity, argumentsJson, result, delegate));
		this._register(this.model.onDidChangeHeight(() => this.height.fire()));
		this._register(autorun(reader => {
			const state = this.model.loadState.read(reader);
			const { status } = state;
			this.error.hidden = status !== 'error';
			this.error.textContent = state.status === 'error'
				? localize('chat.mcpApp.openFailed', 'Could not open the interactive view: {0}', String(state.error))
				: '';
			if (status === 'loading') {
				this.launch.domNode.setAttribute('aria-busy', 'true');
			} else {
				this.launch.domNode.removeAttribute('aria-busy');
			}
			this.launch.domNode.hidden = status === 'loaded';
			this.close.domNode.hidden = status !== 'loaded' && status !== 'loading';
			this.viewport.hidden = status !== 'loaded';
		}));
		this._register(this.launch.onDidClick(() => {
			this.opened = true;
			this.mount({ focus: true });
		}));
		this._register(this.close.onDidClick(() => {
			this.opened = false;
			this.attachment.clear();
			this.launch.focus();
			this.height.fire();
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(argumentsJson: string, result: ToolResult): void {
		this.model.update(argumentsJson, result);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.mount();
		} else {
			this.attachment.clear();
		}
	}

	private mount(options: { readonly focus?: boolean; } = {}): void {
		if (!this.visible || !this.opened) {
			return;
		}
		if (!this.attachment.value) {
			this.attachment.value = this.model.attach(this.viewport, { target: this.domNode, focus: options.focus === true });
		} else {
			void this.model.retry();
		}
	}
}
