import { Emitter } from '../../../../base/common/event.js';
import { canceled } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IReader } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { IReplyChatEditorModel } from '../../chat/browser/replyChatEditor.js';
import type { ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { chatListItem, type IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { ChatSubmissionOptions } from '../../../../workbench/services/chat/common/chatService.js';
import { decodeChatGPTReply } from '../../chat/browser/chatGPTRichContent.js';
import type { ChatReplyMessage } from '../../../common/chatReplyBackend.js';
import { canQueueChatGPTCreation, coworkTaskStatus, IChatGPTService, isCoworkSubmission, pendingCreationStatus, selectedChatConversationId, type ChatGPTState } from './chatGPTService.js';

/** Projects the provider's one conversation record into the existing Chat widget. */
export class ChatGPTWidgetModel extends Disposable implements IReplyChatEditorModel {
	private readonly changed = this._register(new Emitter<void>());
	private readonly composerChanged = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly onDidChangeComposer = this.composerChanged.event;

	readonly sessionId = undefined;
	readonly threadId = undefined;
	readonly goal = undefined;
	private generation = 0;
	private draftRevision = 0;
	private localId: string | undefined;
	private catalog: ChatGPTState['models'] | undefined;
	private entries: readonly ModelCatalogEntry[] = [];
	private currentItems: readonly IChatListItem[] = [];
	private transcriptState: ChatGPTState | undefined;
	private readonly decoded = new WeakMap<ChatReplyMessage, { readonly conversationId: string | undefined; readonly reply: ReturnType<typeof decodeChatGPTReply>; }>();
	private sources = new Map<string, { readonly messageId: string; readonly conversationId: string | undefined; }>();

	constructor(@IChatGPTService private readonly backend: IChatGPTService) {
		super();
		this._register(autorun(reader => {
			const state = backend.state.read(reader);
			const switched = this.localId !== state.localConversationId || this.draftRevision !== backend.newDraftRevision;
			this.draftRevision = backend.newDraftRevision;
			this.localId = state.localConversationId;
			if (switched) this.generation++;
			if (this.catalog !== state.models) {
				this.catalog = state.models;
				this.entries = state.models.flatMap(family => family.presets.map(preset => ({
					model: { provider: 'chatgpt', model: JSON.stringify([family.id, preset.id]) },
					displayName: family.presets.length === 1 ? family.title : `${family.title} · ${preset.label}`,
					longContext: null,
				})));
			}
			const previous = this.transcriptState;
			if (!previous || previous.messages !== state.messages || previous.voiceTranscript !== state.voiceTranscript
				|| previous.coworkTasks !== state.coworkTasks || previous.sending !== state.sending
				|| previous.conversationId !== state.conversationId || previous.localConversationId !== state.localConversationId) {
				this.currentItems = this.projectTranscript(state);
			}
			this.transcriptState = state;
			if (switched) this.composerChanged.fire();
			this.changed.fire();
		}));
	}

	get composerGeneration(): number { return this.generation; }
	get untitledSessionId(): string | undefined { return this.backend.state.get().conversationId ? undefined : this.localId; }
	get items(): readonly IChatListItem[] { return this.currentItems; }

	newChat(): void { this.backend.newChat(); }

	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined {
		const state = this.backend.state.read(reader);
		if (state.conversationId || state.coworkTasks.length || state.messages.length || state.loading?.kind === 'conversation') return undefined;
		return { id: state.localConversationId, revision: this.backend.newDraftRevision };
	}

	getUnsentDraftText(): string | undefined {
		const state = this.backend.state.get();
		return selectedChatConversationId(state) || state.pendingCreation || state.messages.length ? undefined : state.draft;
	}

	readonly draft: NonNullable<IReplyChatEditorModel['draft']> = {
		setText: text => this.backend.setDraft(text),
		attachFiles: files => this.backend.attachFiles(files),
		retryFile: id => this.backend.retryAttachment(id),
		removeFile: id => this.backend.removeAttachment(id),
	};

	get voice(): NonNullable<IReplyChatEditorModel['voice']> {
		const thisModel = this;
		return {
			get isAvailable() { return thisModel.voiceAvailable; },
			get isActive() { return thisModel.backend.state.get().voice !== 'idle'; },
			get isConnected() { return thisModel.backend.state.get().voice === 'connected'; },
			start: window => this.backend.startVoice(window),
			stop: () => this.backend.stopVoice(),
		};
	}

	private get voiceAvailable(): boolean {
		const state = this.backend.state.get();
		return state.connected && state.networkAvailable && !state.pendingCreation && !state.busy && !state.sending
			&& !state.managing && !state.coworkStarting && !state.uncertain;
	}

	get inputState(): ChatInputState {
		const state = this.backend.state.get();
		const voice = state.voice !== 'idle';
		const loading = state.loading?.kind === 'conversation';
		const canSend = !state.pendingCreation && (isCoworkSubmission(state) || canQueueChatGPTCreation(state)
			|| state.connected && state.networkAvailable && !state.uncertain && state.attachments.every(file => file.status === 'ready'));
		return {
			draftIdentity: { id: state.localConversationId, generation: this.generation },
			draft: {
				text: state.draft, files: state.attachments,
				readOnly: state.busy || state.sending || !!state.pendingCreation || voice,
				canAttachFiles: state.connected && state.networkAvailable && !state.pendingCreation && !state.busy && !state.sending && !state.managing && !voice,
			},
			mode: 'ask',
			phase: loading ? 'loading' : state.sending ? 'submitting' : 'ready',
			inputBlocked: !canSend || state.busy || state.managing || state.coworkStarting || voice,
			canInterrupt: state.sending,
			interruptKind: 'reply',
			error: state.error || undefined,
			status: state.voice === 'connecting' ? localize('sessions.chatgpt.voiceConnecting', 'Connecting voice…')
				: state.voice === 'connected' ? localize('sessions.chatgpt.voiceConnected', 'Voice conversation is active')
					: state.voice === 'stopping' ? localize('sessions.chatgpt.voiceStopping', 'Finishing voice conversation…')
						: loading ? localize('sessions.loadingConversation', 'Loading conversation…')
							: state.sending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…')
								: state.coworkStarting ? localize('sessions.chat.coworkPreparing', 'Preparing Cowork task…')
									: state.stopped ? localize('sessions.chatgpt.replyStopped', 'Reply stopped') : pendingCreationStatus(state),
			queuedMessages: 0,
			approvalMode: 'manual',
			models: this.entries,
			canSelectModel: !state.busy && !state.sending && !state.managing && !state.coworkStarting && !voice,
			selectedModel: this.entries.find(entry => entry.model.model === JSON.stringify([state.model, state.modelPreset]))?.model,
			isAutomaticModel: false,
			slashCommands: [],
			skillSelectors: [],
			canSelectAgent: false,
		};
	}

	async selectModel(model: ModelRef): Promise<void> {
		if (model.provider !== 'chatgpt') return;
		for (const family of this.backend.state.get().models) {
			const preset = family.presets.find(candidate => JSON.stringify([family.id, candidate.id]) === model.model);
			if (preset) {
				this.backend.setModel(family.id, preset.id);
				return;
			}
		}
	}

	async send(text: string, _mode?: unknown, _skills?: unknown, _contexts?: unknown, options?: ChatSubmissionOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		if (text !== this.backend.state.get().draft) this.backend.setDraft(text);
		await this.backend.send();
	}

	interrupt(): Promise<void> { return this.backend.stop(); }

	readResponseResource(item: IChatListItem, resource: URI, signal: AbortSignal): Promise<Blob> {
		const source = this.sources.get(item.id);
		if (!source || this.isDisposed) return Promise.reject(canceled());
		return this.backend.readResource(resource.toString(), source.conversationId, source.messageId, signal);
	}

	private projectTranscript(state: ChatGPTState): readonly IChatListItem[] {
		const result: IChatListItem[] = [];
		const sources = this.sources = new Map();
		const id = (kind: string, value: string): string => JSON.stringify([state.localConversationId, kind, value]);
		const anchors = new Set(state.messages.map(message => message.id));
		const appendTasks = (anchor: string | undefined, orphaned = false): void => {
			for (const task of state.coworkTasks.filter(task => orphaned
				? task.afterMessageId !== undefined && !anchors.has(task.afterMessageId) : task.afterMessageId === anchor)) {
				const prefix = id('task', JSON.stringify([task.sessionId, task.threadId]));
				result.push({
					id: prefix, type: 'agentMessage', text: coworkTaskStatus(task), label: localize('sessions.chat.coworkTask', 'Cowork task'),
					detail: [task.prompt, task.thread?.turns.at(-1)?.error?.message ?? task.error ?? task.readError].filter(Boolean).join('\n'),
					conversationLink: { label: localize('sessions.chat.openCoworkTask', 'Open Cowork task'), sessionId: task.sessionId, threadId: task.threadId },
					transient: false,
				});
				for (const turn of task.thread?.turns ?? []) {
					for (const item of turn.items) {
						if (item.type !== 'agentMessage' && item.type !== 'plan' && item.type !== 'toolResult') continue;
						const entry = chatListItem(item);
						result.push({ ...entry, id: `${prefix}:${entry.id}`, attachmentSource: { sessionId: task.sessionId, threadId: task.threadId, itemId: item.itemId, kind: item.type === 'toolResult' ? 'toolResult' : 'item' } });
					}
				}
			}
		};
		const groups = new Map<string, ChatReplyMessage[]>();
		let group: ChatReplyMessage[] | undefined;
		let latest: ChatReplyMessage | undefined;
		for (const message of state.messages) {
			if (message.activity || message.text.trim() || message.resources?.length) latest = message;
			if (message.role === 'user') group = undefined;
			if (!message.activity) continue;
			if (!group) {
				group = [];
				groups.set(message.id, group);
			}
			group.push(message);
		}
		appendTasks(undefined);
		for (const message of state.messages) {
			const itemId = id('message', message.id);
			if (message.activity) {
				const entries = groups.get(message.id);
				if (entries) result.push(activityItem(itemId, entries, state.sending && entries.at(-1) === latest));
			} else {
				const decoded = message.role === 'assistant' ? this.decodeReply(message, state.conversationId) : undefined;
				const candidates = [...decoded?.resources ?? [], ...message.resources ?? []];
				const resources = candidates.length ? candidates.filter((resource, index) =>
					(!resource.uri.startsWith('sandbox:') || state.conversationId) && candidates.findIndex(candidate => candidate.uri === resource.uri) === index) : undefined;
				sources.set(itemId, { messageId: message.id, conversationId: state.conversationId });
				result.push({
					id: itemId,
					type: message.role === 'user' ? 'userMessage' : 'agentMessage',
					text: decoded?.text ?? message.text,
					markdown: decoded && { supportHtml: true },
					label: message.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT',
					resources,
					transient: state.sending && message === state.messages.at(-1),
				});
			}
			appendTasks(message.id);
		}
		appendTasks(undefined, true);
		for (const entry of state.voiceTranscript) {
			result.push({ id: id('voice', entry.id), type: 'voiceTranscript', label: entry.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT', text: entry.text, transient: true });
		}
		return result;
	}

	private decodeReply(message: ChatReplyMessage, conversationId: string | undefined): ReturnType<typeof decodeChatGPTReply> {
		const cached = this.decoded.get(message);
		if (cached && cached.conversationId === conversationId) return cached.reply;
		const reply = decodeChatGPTReply(message.text, message.references, conversationId);
		this.decoded.set(message, { conversationId, reply });
		return reply;
	}
}

function activityItem(id: string, messages: readonly ChatReplyMessage[], transient: boolean): IChatListItem {
	const tool = messages.at(-1)?.activity?.tool;
	const failed = messages.some(message => message.activity?.failed);
	const steps = messages.length === 1 ? localize('sessions.chatgpt.activityOneStep', '1 step') : localize('sessions.chatgpt.activitySteps', '{0} steps', messages.length);
	const label = failed ? localize('sessions.chatgpt.activityFailed', 'Execution process · Some steps failed') : transient
		? tool ? localize('sessions.chatgpt.activityUsing', 'Using {0}… · {1}', tool, steps) : localize('sessions.chatgpt.activityWorking', 'Working… · {0}', steps)
		: localize('sessions.chatgpt.activityComplete', 'Execution process · {0}', steps);
	return {
		id, type: 'toolCall', text: label, label, transient, isError: failed,
		contextEntries: messages.map(message => {
			const activity = message.activity!;
			const name = activity.kind === 'call' ? localize('sessions.chatgpt.activityCall', 'Tool call: {0}', activity.tool ?? '')
				: activity.kind === 'result' ? localize('sessions.chatgpt.activityResult', 'Tool result: {0}', activity.tool ?? '')
					: localize('sessions.chatgpt.activityProgress', 'Progress');
			return { id: message.id, label: activity.failed ? localize('sessions.chatgpt.activityStepFailed', '{0} · Failed', name) : name, text: message.text };
		}),
	};
}
