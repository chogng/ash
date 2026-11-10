import { RunOnceScheduler } from '../../../../base/common/async.js';
import { canceled } from '../../../../base/common/errors.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatReplyError } from '../../../common/chatReplyBackend.js';
import { canAttachChatGPTFiles, chatGPTAttachmentLimitMessage, IChatGPTService } from '../browser/chatGPTService.js';
import { chatGPTModelEntries } from './chatGPTWidgetModel.js';

/** A project draft stays independent of the selected ChatGPT conversation until it is submitted. */
export class ChatGPTProjectDraftModel extends Disposable implements IChatWidgetModel {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	readonly onDidChangeComposer = Event.None;
	readonly composerGeneration = 0;
	readonly sessionId = undefined;
	readonly threadId = undefined;
	readonly untitledSessionId = undefined;
	readonly goal = undefined;
	readonly items = [];
	private readonly id = crypto.randomUUID();
	private readonly lifetime = new AbortController();
	private readonly models;
	private readonly reveal: RunOnceScheduler;
	private text = '';
	private files: { readonly id: string; readonly file: File; }[] = [];
	private selection: { readonly model: string; readonly preset?: string; } | undefined;
	private pending = false;
	private uncertain: string | undefined;
	private conversationId: string | undefined;

	constructor(
		private readonly projectId: string,
		private readonly scope: string,
		isVisible: () => boolean,
		open: (id: string, signal: AbortSignal) => Promise<void>,
		@IChatGPTService private readonly backend: IChatGPTService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.models = chatGPTModelEntries(backend);
		this._register(toDisposable(() => this.lifetime.abort()));
		this._register(autorun(reader => {
			const state = backend.state.read(reader);
			if (!this.selection && state.catalogScope === scope && state.model) {
				this.selection = { model: state.model, preset: state.modelPreset };
			}
			this.changed.fire();
		}));
		this.reveal = this._register(new RunOnceScheduler(() => {
			if (isVisible() && backend.state.get().catalogScope === scope && this.conversationId) {
				void open(this.conversationId, this.lifetime.signal).catch(error => {
					if (!this.lifetime.signal.aborted) notifications.error(toErrorMessage(error));
				});
			}
		}, 0));
	}

	get submitted(): boolean { return this.conversationId !== undefined; }

	readonly draft: NonNullable<IChatWidgetModel['draft']> = {
		setText: text => { this.text = text; this.changed.fire(); },
		attachFiles: async files => {
			if (this.pending || this.submitted) return;
			if (!canAttachChatGPTFiles([...this.files.map(entry => entry.file), ...files])) throw new Error(chatGPTAttachmentLimitMessage());
			this.files.push(...files.map(file => ({ id: crypto.randomUUID(), file })));
			this.changed.fire();
		},
		readImage: async id => this.files.find(entry => entry.id === id && entry.file.type.startsWith('image/'))?.file,
		// Uploads happen on Send. A failure leaves the original files available for the next submission.
		retryFile: async () => { },
		removeFile: id => {
			if (this.pending || this.submitted) return;
			this.files = this.files.filter(entry => entry.id !== id);
			this.changed.fire();
		},
	};

	get inputState(): ChatInputState {
		const state = this.backend.state.get();
		const models = this.models.get();
		const model = this.selection?.model ?? state.model;
		const selectedModel = models.find(entry => entry.model.model === model)?.model;
		const available = state.catalogScope === this.scope && state.projects.some(project => project.id === this.projectId);
		const blocked = !available || this.submitted || this.pending || !!this.uncertain;
		return {
			draftIdentity: { id: this.id, generation: this.composerGeneration },
			draft: {
				text: this.text, readOnly: !available || this.pending || this.submitted,
				canAttachFiles: !blocked,
				files: this.files.map(({ id, file }) => ({ id, name: file.name, size: file.size, status: 'ready' })),
			},
			mode: 'ask', phase: this.pending ? 'submitting' : 'ready', queuedMessages: 0, approvalMode: 'manual',
			inputBlocked: blocked || !selectedModel || !state.connected || !state.networkAvailable || state.busy || state.sending || state.managing || state.voice !== 'idle',
			canInterrupt: this.pending && state.sending && state.localConversationId === this.id,
			interruptKind: 'reply',
			status: this.pending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…') : undefined,
			error: this.uncertain,
			models, canSelectModel: !blocked,
			selectedModel,
			selectedPreset: this.selection ? this.selection.preset : state.modelPreset,
			isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false,
		};
	}

	async selectModel(model: ModelRef): Promise<void> {
		const family = this.backend.state.get().models.find(entry => model.provider === 'chatgpt' && entry.id === model.model);
		if (family && !this.pending) {
			this.selection = { model: family.id, preset: family.defaultPreset };
			this.changed.fire();
		}
	}

	async selectPreset(preset: string): Promise<void> {
		const model = this.inputState.selectedModel?.model;
		if (model && !this.pending && this.backend.state.get().models.find(entry => entry.id === model)?.presets.some(entry => entry.id === preset)) {
			this.selection = { model, preset };
			this.changed.fire();
		}
	}

	async send(text: string, _mode?: unknown, _skills?: unknown, _contexts?: unknown, options?: Parameters<IChatWidgetModel['send']>[4]): Promise<void> {
		const state = this.inputState;
		if (state.inputBlocked || !state.selectedModel) throw canceled();
		const signal = options?.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
		this.pending = true;
		this.changed.fire();
		try {
			this.conversationId = await this.backend.sendProjectMessage({
				draftId: this.id, projectId: this.projectId, scope: this.scope,
				text, files: this.files.map(entry => entry.file), model: state.selectedModel.model, preset: state.selectedPreset
			}, signal);
			this.text = '';
			this.files = [];
			if (!this.isDisposed) this.reveal.schedule();
		} catch (error) {
			if (error instanceof ChatReplyError && error.outcome === 'uncertain') this.uncertain = error.message;
			throw error;
		} finally {
			this.pending = false;
			this.changed.fire();
		}
	}

	async interrupt(): Promise<void> {
		if (this.inputState.canInterrupt) await this.backend.stop();
	}
}
