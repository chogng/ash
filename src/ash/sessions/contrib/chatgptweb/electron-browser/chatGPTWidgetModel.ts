import { Emitter } from '../../../../base/common/event.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { canceled } from '../../../../base/common/errors.js';
import { isPortableLinkTarget } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableSignalFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { IReplyChatEditorModel } from '../../chat/browser/replyChatEditor.js';
import type { ChatResponseActions } from '../../../../workbench/contrib/chat/browser/widget/chatListRenderer.js';
import type { ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { chatListItem, type IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { ChatSubmissionOptions } from '../../../../workbench/services/chat/common/chatService.js';
import { decodeChatGPTReply } from '../browser/chatGPTRichContent.js';
import type { ChatReplyMessage } from '../../../common/chatReplyBackend.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { OPEN_ASH_CHAT_WITH_MODEL_COMMAND } from '../../chat/common/constants.js';
import { canQueueChatGPTCreation, coworkTaskStatus, IChatGPTService, pendingCreationStatus, selectedChatConversationId, type ChatGPTState } from '../browser/chatGPTService.js';
import { shareChatGPTConversation } from './chatGPTShare.js';

export function canUseAshModels(state: ChatGPTState): boolean {
	// Existing conversations and drafts with provider-owned attachments keep their reply route.
	return !selectedChatConversationId(state) && !state.pendingCreation && !state.uncertain
		&& state.loading?.kind !== 'conversation' && !state.messages.length && !state.coworkTasks.length && !state.attachments.length;
}

export function chatGPTModelEntries(backend: IChatGPTService): IObservable<readonly ModelCatalogEntry[]> {
	return backend.state.map(state => state.models).map(families => families.map(family => ({
		model: { provider: 'chatgpt', model: family.id },
		displayName: family.title,
		longContext: null,
		presets: family.presets,
	})));
}

/** Projects ChatGPT's data into the Ash composer and offers the host's Ash Chat draft handoff. */
export class ChatGPTWidgetModel extends Disposable implements IReplyChatEditorModel {
	private readonly changed = this._register(new Emitter<void>());
	private readonly composerChanged = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly onDidChangeComposer = this.composerChanged.event;

	readonly sessionId = undefined;
	readonly threadId = undefined;
	readonly untitledSessionId = undefined;
	readonly goal = undefined;
	private generation = 0;
	private draftRevision = 0;
	private localId: string | undefined;
	private readonly webEntries: IObservable<readonly ModelCatalogEntry[]>;
	private readonly ashCatalog = observableValue<readonly ModelCatalogEntry[]>(this, []);
	private readonly ashEntries: IObservable<readonly ModelCatalogEntry[]>;
	private readonly pickerEntries: IObservable<readonly ModelCatalogEntry[]>;
	private ashCatalogRequest = 0;
	private currentItems: readonly IChatListItem[] = [];
	private transcriptState: ChatGPTState | undefined;
	private readonly decoded = new WeakMap<ChatReplyMessage, { readonly conversationId: string | undefined; readonly reply: ReturnType<typeof decodeChatGPTReply>; }>();
	private sources = new Map<string, { readonly messageId: string; readonly conversationId: string | undefined; }>();
	private readonly playback = this._register(new MutableDisposable());

	constructor(
		@IChatGPTService private readonly backend: IChatGPTService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IDialogService private readonly dialogs: IDialogService,
		@IOpenerService private readonly opener: IOpenerService,
		@ISessionPrimaryProviderServices private readonly primary: SessionProviderServices,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		const ashModelsChanged = observableSignalFromEvent(this, primary.models.onDidChangeModels);
		this.webEntries = chatGPTModelEntries(backend);
		this.ashEntries = derived(reader => {
			// Visibility is a local preference and can change while App Server reads are pending.
			ashModelsChanged.read(reader);
			return this.ashCatalog.read(reader).filter(entry => primary.models.isModelVisible(entry.model));
		});
		const ashEligible = backend.state.map(canUseAshModels);
		this.pickerEntries = derived(reader => {
			const web = this.webEntries.read(reader);
			return ashEligible.read(reader) ? [...web, ...this.ashEntries.read(reader)] : web;
		});
		this._register(autorun(reader => {
			this.pickerEntries.read(reader);
			const state = backend.state.read(reader);
			const switched = this.localId !== state.localConversationId || this.draftRevision !== backend.newDraftRevision;
			this.draftRevision = backend.newDraftRevision;
			this.localId = state.localConversationId;
			if (switched) {
				this.generation++;
				this.playback.clear();
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
		this._register(autorun(reader => {
			ashModelsChanged.read(reader);
			void this.loadAshModels();
		}));
	}

	get composerGeneration(): number { return this.generation; }
	get items(): readonly IChatListItem[] { return this.currentItems; }

	newChat(): void { this.backend.newChat(); }

	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined {
		const state = this.backend.state.read(reader);
		if (state.conversationId || state.coworkTasks.length || state.messages.length || state.loading?.kind === 'conversation') return undefined;
		return { id: state.localConversationId, revision: this.backend.newDraftRevision };
	}

	private async loadAshModels(): Promise<void> {
		const request = ++this.ashCatalogRequest;
		// The handoff needs the catalog, not the backend's default model.
		const entries = await this.primary.models.listModelCatalog().catch(() => []);
		if (this.isDisposed || request !== this.ashCatalogRequest) return;
		this.ashCatalog.set(entries);
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
			&& !state.managing && !state.uncertain;
	}

	get inputState(): ChatInputState {
		const state = this.backend.state.get();
		const voice = state.voice !== 'idle';
		const loading = state.loading?.kind === 'conversation';
		const canSend = !state.pendingCreation && (canQueueChatGPTCreation(state)
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
			inputBlocked: !canSend || state.busy || state.managing || voice,
			canInterrupt: state.sending,
			interruptKind: 'reply',
			error: state.error || undefined,
			// The destination row shows loading; an empty status suppresses the composer's fallback text.
			status: state.voice === 'connecting' ? localize('sessions.chatgpt.voiceConnecting', 'Connecting voice…')
				: state.voice === 'connected' ? localize('sessions.chatgpt.voiceConnected', 'Voice conversation is active')
					: state.voice === 'stopping' ? localize('sessions.chatgpt.voiceStopping', 'Finishing voice conversation…')
						: loading ? ''
							: state.sending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…')
								: state.stopped ? localize('sessions.chatgpt.replyStopped', 'Reply stopped') : pendingCreationStatus(state),
			queuedMessages: 0,
			approvalMode: 'manual',
			models: this.pickerEntries.get(),
			canSelectModel: !state.busy && !state.sending && !state.managing && !voice,
			selectedModel: this.webEntries.get().find(entry => entry.model.model === state.model)?.model
				?? this.webEntries.get().find(entry => entry.model.model === JSON.stringify([state.model, state.modelPreset]))?.model,
			selectedPreset: state.modelPreset,
			isAutomaticModel: false,
			slashCommands: [],
			skillSelectors: [],
			canSelectAgent: false,
		};
	}

	async selectModel(model: ModelRef): Promise<void> {
		const state = this.backend.state.get();
		if (state.busy || state.sending || state.managing || state.voice !== 'idle') return;
		if (model.provider === 'chatgpt') {
			const family = state.models.find(candidate => candidate.id === model.model);
			if (family) {
				this.backend.setModel(family.id);
				return;
			}
			for (const f of state.models) {
				const preset = f.presets.find(candidate => JSON.stringify([f.id, candidate.id]) === model.model);
				if (preset) {
					this.backend.setModel(f.id, preset.id);
					return;
				}
			}
		}
		if (canUseAshModels(state) && this.ashEntries.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
			await this.commands.executeCommand(OPEN_ASH_CHAT_WITH_MODEL_COMMAND, model);
			return;
		}
		throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
	}

	async selectPreset(presetId: string): Promise<void> {
		const state = this.backend.state.get();
		if (state.busy || state.sending || state.managing || state.voice !== 'idle') return;
		this.backend.setModel(state.model, presetId);
	}

	async send(text: string, _mode?: unknown, _skills?: unknown, _contexts?: unknown, options?: ChatSubmissionOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		if (text !== this.backend.state.get().draft) this.backend.setDraft(text);
		await this.backend.send();
	}

	interrupt(): Promise<void> { return this.backend.stop(); }

	getResponseLinkOpener(item: IChatListItem): ((target: string) => Promise<void>) | undefined {
		// Embedded Cowork output has a real Ash source. Web replies use the adapter's link policy.
		return item.attachmentSource ? undefined : this.openWebResponseLink;
	}

	private readonly openWebResponseLink = async (target: string): Promise<void> => {
		if (isPortableLinkTarget(target)) {
			await this.opener.open(target, { openExternal: true, fromUserGesture: true });
		}
	};

	getResponseActions(item: IChatListItem): ChatResponseActions | undefined {
		const state = this.backend.state.get();
		const source = this.sources.get(item.id);
		if (item.type !== 'agentMessage' || item.transient || item.isError || !source?.conversationId || source.conversationId !== state.conversationId) return undefined;
		const { conversationId, messageId } = source;
		const openOriginal = {
			label: localize('sessions.chatgpt.openConversationOnWeb', 'Open conversation in ChatGPT'),
			icon: Lxicon.openai,
			run: async () => {
				const url = `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
				if (!await this.opener.open(url, { openExternal: true, fromUserGesture: true })) {
					throw new Error(localize('sessions.chatgpt.openConversationOnWebFailed', 'Could not open the conversation in ChatGPT.'));
				}
			},
		};
		if (!state.connected || !state.networkAvailable || state.loading?.kind === 'conversation' || state.uncertain) return { openOriginal };
		return {
			openOriginal,
			remote: {
				readAloud: (window, signal) => this.readResponseAloud(conversationId, messageId, window, signal),
				forkLabel: localize('sessions.chatgpt.forkResponse', 'Fork in ChatGPT'),
				fork: async () => {
					const url = `https://chatgpt.com/branch/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`;
					if (!await this.opener.open(url, { openExternal: true })) {
						throw new Error(localize('sessions.chatgpt.openForkFailed', 'Could not open the conversation branch in ChatGPT.'));
					}
				},
				share: () => shareChatGPTConversation(this.backend, this.dialogs, this.clipboard, conversationId, state.title, messageId),
			},
		};
	}

	private async readResponseAloud(conversationId: string, messageId: string, window: Window & typeof globalThis, signal: AbortSignal): Promise<void> {
		const controller = new AbortController();
		const playback = toDisposable(() => controller.abort());
		this.playback.value = playback;
		const lifetime = AbortSignal.any([signal, controller.signal]);
		try {
			const blob = await this.backend.readResponseAudio(conversationId, messageId, lifetime);
			lifetime.throwIfAborted();
			const url = window.URL.createObjectURL(blob);
			using audioLifetime = new DisposableStore();
			const audio = new window.Audio(url);
			audioLifetime.add(toDisposable(() => {
				audio.pause();
				audio.removeAttribute('src');
				audio.load();
				window.URL.revokeObjectURL(url);
			}));
			const finished = new Promise<void>((resolve, reject) => {
				audioLifetime.add(addDisposableListener(audio, 'ended', () => resolve()));
				audioLifetime.add(addDisposableListener(audio, 'error', () => reject(new Error(localize('sessions.chatgpt.playResponseFailed', 'ChatGPT audio could not be played.')))));
			});
			await raceCancellationError(Promise.all([audio.play(), finished]), lifetime);
		} finally {
			if (this.playback.value === playback) this.playback.clear();
		}
	}

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
