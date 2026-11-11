import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { chatToolResultPresentation, type IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatToolOutputContentSubPart } from '../chatToolOutputContentSubPart.js';
import { ChatResultListSubPart } from './chatResultListSubPart.js';
import { ChatSessionTargetResultPillSubPart } from './chatSessionTargetResultPillSubPart.js';
import { ChatAutomationConfiguredResultSubPart } from './chatAutomationConfiguredResultSubPart.js';
import { ChatCollapsibleInputOutputContentPart, type IToolOutputPresentation } from '../chatToolInputOutputContentPart.js';

/** Owns streamed evidence and result resources. Backend coordinates remain attached to every media read. */
export class ChatToolOutputSubPart extends BaseChatToolInvocationSubPart {
	public getFileTreeInfos() { return this.resources.value?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTree() { return this.resources.value?.getLastFocusedFileTree(); }
	private readonly inputOutput: ChatCollapsibleInputOutputContentPart;
	private readonly resources = this._register(new MutableDisposable<ChatResultListSubPart>());
	private readonly resourceChanges = this._register(new MutableDisposable());
	private readonly preview: ChatToolOutputContentSubPart;
	private visible = true;
	private readonly resultTarget = this._register(new MutableDisposable<ChatSessionTargetResultPillSubPart | ChatAutomationConfiguredResultSubPart>());
	private targetIdentity: string | undefined;

	constructor(
		document: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(h(document, 'div'));
		this.inputOutput = this._register(instantiation.createInstance(ChatCollapsibleInputOutputContentPart, document));
		this.preview = this._register(instantiation.createInstance(ChatToolOutputContentSubPart, document));
		this._register(this.preview.onDidChangeHeight(() => this.changedHeight.fire()));
		this.domNode.append(this.inputOutput.domNode, this.preview.domNode);
		this._register(this.inputOutput.onDidChangeHeight(() => this.changedHeight.fire()));
	}

	public get codeblocks() { return this.preview.codeblocks; }

	public render(invocation: IChatToolInvocation, source: IChatListItem['attachmentSource'], options: { readonly generatedImages: boolean; }, presentation?: IToolOutputPresentation): void {
		const { result } = invocation;
		const content = result?.content ?? [];
		const target = invocation.subagentActivity ? undefined : chatToolResultPresentation(result);
		const targetIdentity = source && result && target ? JSON.stringify([source, result.itemId, target]) : undefined;
		if (targetIdentity !== this.targetIdentity) {
			this.targetIdentity = targetIdentity;
			this.resultTarget.clear();
			if (targetIdentity && target && source) {
				const part = target.type === 'sessionTarget'
					? this.instantiation.createInstance(ChatSessionTargetResultPillSubPart, this.domNode.ownerDocument, target, source.sessionId)
					: this.instantiation.createInstance(ChatAutomationConfiguredResultSubPart, this.domNode.ownerDocument, target, source.sessionId);
				this.resultTarget.value = part;
				part.setVisible(this.visible);
				this.domNode.append(part.domNode);
			}
		}
		this.preview.render(content, source, { generatedImages: options.generatedImages, hideFormattedResults: !!presentation });
		this.inputOutput.render(invocation, presentation, source);
		if (content.some(part => part.type === 'artifact' && part.artifact.source.type !== 'mcpApp' && part.artifact.source.type !== 'viewMetadata')) {
			if (!this.resources.value) {
				const resources = this.instantiation.createInstance(ChatResultListSubPart, this.domNode.ownerDocument);
				this.resources.value = resources;
				this.domNode.append(resources.domNode);
				this.resourceChanges.value = resources.onDidChangeHeight(() => this.changedHeight.fire());
			}
			this.resources.value.render(content, JSON.stringify([source?.sessionId, source?.threadId, result?.itemId]), source);
		} else {
			this.resourceChanges.clear();
			this.resources.clear();
		}
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.preview.setVisible(visible);
		this.resultTarget.value?.setVisible(visible);
	}
}
