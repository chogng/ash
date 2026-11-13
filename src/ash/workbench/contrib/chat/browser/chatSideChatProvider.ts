import { canceled } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { observableFromEvent, type IObservable } from '../../../../base/common/observable.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { URI } from '../../../../base/common/uri.js';
import { IAgentThreadService } from '../../../../platform/agentHost/common/agentService.js';
import { localize } from '../../../../nls.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { resolveChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import { LocalChatSessionUri } from '../common/model/chatUri.js';
import { IChatSideChatService, type IChatSideChatOrigin, type IChatSideChatProvider, type IChatSideChatRequestOptions, type IChatSideChatSelection } from '../common/chatSideChatService.js';
import { IChatWidgetService, type IChatWidget } from './chat.js';

/** Uses the host's existing domain and navigation services in IDE and Agents windows. */
export class ChatSideChatProvider extends Disposable implements IChatSideChatProvider {
	static readonly ID = 'workbench.contrib.chatSideChat';
	private readonly listeners = this._register(new DisposableStore());
	private readonly changed = this._register(new Emitter<void>());

	constructor(
		@IChatSideChatService sideChats: IChatSideChatService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@IChatService private readonly chat: IChatService,
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
	) {
		super();
		this._register(sideChats.registerProvider(this));
		this._register(widgets.onDidChangeWidgets(() => this.bind()));
		this.bind();
	}

	private bind(): void {
		this.listeners.clear();
		for (const widget of this.widgets.getAllWidgets()) { if (widget.model) this.listeners.add(widget.model.onDidChange(() => this.changed.fire())); }
		this.changed.fire();
	}

	private widget(resource: URI): IChatWidget | undefined {
		const source = LocalChatSessionUri.parse(resource);
		if (!source) return undefined;
		const matching = this.widgets.getAllWidgets().filter(widget => widget.sessionId === source.sessionId && widget.threadId === source.threadId);
		return matching.find(widget => widget.visible) ?? matching[0];
	}

	canAskInSideChat(resource: URI): boolean {
		const widget = this.widget(resource);
		return !!widget?.visible && !widget.model?.inputState.aiDisabled && !widget.isTranscriptProgressActive && !!widget.model?.thread?.turns.length && !!widget.sessionId && this.threads.canCreateSideChat(widget.sessionId);
	}

	async askInSideChat(resource: URI, query: string, selection?: IChatSideChatSelection, options?: IChatSideChatRequestOptions): Promise<void> {
		const source = LocalChatSessionUri.parse(resource);
		const widget = this.widget(resource);
		const model = widget?.model;
		if (!source || !widget || !model || !this.canAskInSideChat(resource) || !query.trim()) throw new Error(localize('chat.btw.unavailable', 'Send a message in this conversation before starting a side chat.'));
		const generation = model.composerGeneration;
		const current = (): void => {
			if (this.isDisposed || options?.token?.isCancellationRequested || options?.signal?.aborted || !widget.visible || model.composerGeneration !== generation || widget.sessionId !== source.sessionId || widget.threadId !== source.threadId) throw canceled();
		};
		const state = model.inputState;
		const sourceTurnId = options?.sourceTurnId ?? model.thread!.turns.at(-1)!.turnId;
		const contexts = await Promise.all((options?.attachedContext ?? []).map(resolveChatContextAttachment));
		if (selection?.text.trim()) contexts.push({ name: localize('chat.btw.selection', 'Selected conversation text'), content: selection.text });
		current();
		const branch = await this.threads.createSideChat({ ...source, sourceTurnId, commandId: createUuid(), title: localize('chat.btw.title', 'Side question: {0}', Array.from(query.trim().replace(/\s+/gu, ' ')).slice(0, 100).join('')), ...(selection?.text.trim() ? { selection: selection.text } : {}) });
		current();
		const { thread } = await this.chat.readThread(branch.sessionId, branch.threadId, { type: 'latest', turnLimit: 1 });
		current();
		// Submit to the captured branch before navigation can replace the source composer's lifetime.
		await this.chat.startTurn({
			...branch, commandId: createUuid(), expectedSequence: thread.sequence, text: query, mode: state.mode,
			model: state.isAutomaticModel ? undefined : state.selectedModel, reasoningEffort: state.selectedReasoningEffort,
			...(state.isAutomaticModel && { modelRouting: 'auto' as const }),
			approvalMode: state.approvalMode, contexts, signal: options?.signal,
			...(model.commandInterpretation && { commandInterpretation: model.commandInterpretation }),
		});
		current();
		if (this.navigation.openSideConversation) {
			await this.navigation.openSideConversation(branch.sessionId, branch.threadId);
		} else {
			await this.navigation.openConversation(branch.sessionId, branch.threadId);
		}
	}

	observeSideChatOrigin(resource: URI): IObservable<IChatSideChatOrigin | undefined> {
		return observableFromEvent(this, this.changed.event, () => {
			const widget = this.widget(resource);
			const origin = widget?.model?.thread?.origin;
			if (!widget?.sessionId || origin?.type !== 'sideChat') return undefined;
			return {
				sourceSessionResource: LocalChatSessionUri.forSession(widget.sessionId, origin.parentThreadId), sourceTurnId: origin.sourceTurnId,
				sourceTitle: this.navigation.getConversations().find(chat => chat.sessionId === widget.sessionId && chat.threadId === origin.parentThreadId)?.title,
				...(origin.selection ? { selection: { text: origin.selection } } : {}),
			};
		});
	}

	async revealSideChatSource(resource: URI): Promise<void> {
		const origin = this.observeSideChatOrigin(resource).get();
		if (!origin) return;
		const source = LocalChatSessionUri.parse(origin.sourceSessionResource);
		if (!source) return;
		await this.navigation.openConversation(source.sessionId, source.threadId);
		const widget = this.widget(origin.sourceSessionResource);
		const model = widget?.model;
		if (!widget || !model) return;
		const generation = model.composerGeneration;
		while (!this.isDisposed && widget.visible && widget.model === model && model.composerGeneration === generation
			&& widget.sessionId === source.sessionId && widget.threadId === source.threadId) {
			const item = model.items.find(item => item.requestSource?.turnId === origin.sourceTurnId);
			if (item) {
				widget.reveal(item);
				return;
			}
			const turns = model.thread?.turns;
			if (!model.olderHistory || !model.loadOlderHistory || turns?.some(turn => turn.turnId === origin.sourceTurnId)) return;
			const oldestTurnId = turns?.[0]?.turnId;
			await model.loadOlderHistory();
			// The history owner reports failed loads without rejecting. Stop if the boundary did not advance.
			if (model.thread?.turns[0]?.turnId === oldestTurnId) return;
		}
	}
}
