import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { getActiveWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAgentVoiceService, type AgentVoiceSource, type ThreadTranscriptEntry, type ThreadTranscriptSnapshot, type ThreadTranscriptUpdateEnvelope } from '../../../../platform/agentHost/common/agentService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import type { IAgentsVoiceWindowService } from '../common/agentsVoice.js';
import { AgentsVoiceSessionsPicker } from './agentsVoiceSessionsPicker.js';
import { AgentsVoiceWidget } from './agentsVoiceWidget.js';

/** The opener's connection remains the sole media owner, including while the auxiliary window has focus. */
export class AgentsVoiceWindowService extends Disposable implements IAgentsVoiceWindowService {
	private readonly opened = this._register(new Emitter<boolean>());
	readonly onDidChangeOpen = this.opened.event;
	private window: IAuxiliaryWindow | undefined;
	private readonly controls = this._register(new MutableDisposable<DisposableStore>());
	private widget: AgentsVoiceWidget | undefined;
	private opening: Promise<void> | undefined;
	private generation = 0;
	private source: AgentVoiceSource | undefined;
	private subscriptionOwner: object | undefined;
	private opener: Window | undefined;
	private previousFocus: HTMLElement | undefined;
	private revision = -1;
	private entries: readonly ThreadTranscriptEntry[] = [];
	private loading = false;
	private latestRevision = -1;

	constructor(@IAuxiliaryWindowService private readonly windows: IAuxiliaryWindowService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IAgentVoiceService private readonly voice: IAgentVoiceService | undefined,
		@IChatService private readonly chat: IChatService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	get isOpen(): boolean { return !!this.window; }

	openWindow(): Promise<void> {
		this.assertNotDisposed();
		if (this.window) { this.window.window.focus(); return Promise.resolve(); }
		if (this.opening) return this.opening;
		this.opener = getActiveWindow();
		const focused = this.opener.document.activeElement;
		this.previousFocus = isHTMLElement(focused) ? focused : undefined;
		const generation = ++this.generation;
		const operation = this.open(generation);
		this.opening = operation;
		void operation.finally(() => { if (this.opening === operation) this.opening = undefined; }).catch(() => undefined);
		return operation;
	}

	private async open(generation: number): Promise<void> {
		const window = await this.windows.open({ title: localize('agentsVoice.title', 'Voice conversation'), width: 400, height: 480 });
		if (this.isDisposed || generation !== this.generation) { window.dispose(); return; }
		this.window = window;
		const controls = new DisposableStore();
		this.controls.value = controls;
		try {
			const picker = controls.add(this.instantiation.createInstance(AgentsVoiceSessionsPicker));
			let hold: string | undefined;
			this.widget = controls.add(this.instantiation.createInstance(AgentsVoiceWidget, window.container, {
				openSession: () => this.run(async () => {
					this.opener?.focus();
					const source = this.voice?.state ?? this.navigation.getActiveConversation();
					if (source) await this.navigation.openConversation(source.sessionId, source.threadId);
					else picker.show();
				}),
				connect: () => this.run(() => this.navigation.startVoiceConversation()),
				toggleMute: () => this.run(() => this.voice?.setMuted(!this.voice.state?.muted)),
				toggleInputMode: () => this.run(() => this.voice?.setInputMode(this.voice.state?.inputMode === 'pushToTalk' ? 'openMic' : 'pushToTalk')),
				pttDown: () => { hold = generateUuid(); const id = hold; this.run(() => this.voice?.pttDown(id)); },
				pttUp: () => { const id = hold; hold = undefined; if (id) this.run(() => this.voice?.pttUp(id)); },
				disconnect: () => this.run(() => this.voice?.stop()),
				stopPlayback: () => this.run(() => this.voice?.interrupt()),
				closeWindow: () => this.closeWindow(),
				showSessionsPicker: () => { this.opener?.focus(); picker.show(); },
			}, {}));
			controls.add(window.onDidClose(() => this.closeWindow()));
			if (this.voice) controls.add(this.voice.onDidChange(() => this.update()));
			controls.add(this.chat.onDidUpdateThreadTranscript(update => {
				if (!this.sameSource(update, this.source)) return;
				this.latestRevision = Math.max(this.latestRevision, update.revision);
				if (this.loading) return;
				this.apply(update);
			}));
			this.update();
			this.opened.fire(true);
		} catch (error) { this.closeWindow(); throw error; }
	}

	closeWindow(): void {
		const wasOpen = this.isOpen;
		++this.generation;
		this.opening = undefined;
		const source = this.source;
		const owner = this.subscriptionOwner;
		this.source = undefined;
		this.subscriptionOwner = undefined;
		this.widget = undefined;
		this.entries = [];
		this.latestRevision = -1;
		this.loading = false;
		this.revision = -1;
		this.controls.clear();
		const window = this.window;
		this.window = undefined;
		window?.dispose();
		if (source && owner) void this.chat.unsubscribeThread(source.sessionId, source.threadId, owner).catch(() => undefined);
		if (wasOpen && this.previousFocus?.isConnected) { this.opener?.focus(); this.previousFocus.focus(); }
		this.previousFocus = undefined;
		this.opener = undefined;
		if (wasOpen) this.opened.fire(false);
	}

	async toggleWindow(): Promise<void> { if (this.isOpen || this.opening) this.closeWindow(); else await this.openWindow(); }

	private update(): void {
		const widget = this.widget;
		if (!widget) return;
		const state = this.voice?.state;
		widget.setConnected(state?.state === 'connected');
		widget.setConnecting(state?.state === 'connecting' || state?.state === 'stopping');
		widget.setMuted(state?.muted ?? false);
		widget.setInputMode(state?.inputMode ?? 'openMic');
		widget.setVoiceState(state?.listening ? 'listening' : 'idle');
		const title = state && this.navigation.getConversations().find(conversation => this.sameSource(conversation, state))?.title;
		const text = state?.state === 'connected' ? state.muted ? localize('agentsVoice.mutedStatus', 'Microphone muted') : state.listening ? localize('agentsVoice.listening', 'Listening…') : localize('agentsVoice.readyPtt', 'Press and hold to speak')
			: state?.state === 'connecting' ? localize('agentsVoice.connecting', 'Connecting…')
				: state?.state === 'stopping' ? localize('agentsVoice.stopping', 'Disconnecting…')
					: state?.state === 'failed' ? localize('agentsVoice.failed', 'Voice connection failed: {0}', state.error ?? '')
						: localize('agentsVoice.idle', 'Start voice from Chat.');
		widget.setStatusText(title ? localize('agentsVoice.statusWithChat', '{0} · {1}', text, title) : text);
		const source = state ? { sessionId: state.sessionId, threadId: state.threadId } : undefined;
		if (this.sameSource(source, this.source)) return;
		const previous = this.source;
		const previousOwner = this.subscriptionOwner;
		this.source = source;
		const owner = this.subscriptionOwner = source ? {} : undefined;
		this.entries = [];
		this.revision = -1;
		this.latestRevision = -1;
		widget.setTranscriptTurns([]);
		++this.generation;
		if (previous && previousOwner) void this.chat.unsubscribeThread(previous.sessionId, previous.threadId, previousOwner).catch(() => undefined);
		if (source && owner) this.run(() => this.load(source, true, owner));
	}

	private async load(source: AgentVoiceSource, subscribe: boolean, owner: object): Promise<void> {
		const generation = this.generation;
		this.loading = true;
		try {
			let acquiring = subscribe;
			do {
				const result = acquiring
					? await this.chat.subscribeThread(source.sessionId, source.threadId, 0, owner)
					: await this.chat.readThread(source.sessionId, source.threadId);
				if (generation !== this.generation || this.isDisposed || !this.widget) {
					// A late acquisition must release its owner too; it cannot revive a closed view.
					if (acquiring) await this.chat.unsubscribeThread(source.sessionId, source.threadId, owner);
					return;
				}
				this.acceptSnapshot(result.transcript);
				acquiring = false;
				// Events during acquisition need only a revision fence, not an unbounded copy of transcript deltas.
			} while (this.latestRevision > this.revision);
		} finally { if (generation === this.generation) this.loading = false; }
	}

	private acceptSnapshot(snapshot: ThreadTranscriptSnapshot): void {
		this.revision = snapshot.revision;
		this.entries = snapshot.entries.filter(entry => entry.type === 'voiceTranscript');
		this.renderTranscript();
	}

	private apply(update: ThreadTranscriptUpdateEnvelope): void {
		if (update.revision <= this.revision) return;
		if (update.revision !== this.revision + 1) {
			const source = this.source;
			const owner = this.subscriptionOwner;
			if (source && owner) this.run(() => this.load(source, false, owner));
			return;
		}
		this.revision = update.revision;
		for (const change of update.changes) {
			if (change.type === 'remove') this.entries = this.entries.filter(entry => !change.entryIds.includes(entry.entryId));
			else if (change.type === 'upsert') {
				const index = this.entries.findIndex(entry => entry.entryId === change.entry.entryId);
				if (change.entry.type === 'voiceTranscript') {
					const entries = [...this.entries];
					if (index < 0) entries.push(change.entry); else entries[index] = change.entry;
					this.entries = entries;
				} else if (index >= 0) this.entries = this.entries.filter(entry => entry.entryId !== change.entry.entryId);
			}
		}
		this.renderTranscript();
	}

	private renderTranscript(): void {
		this.widget?.setTranscriptTurns(this.entries.flatMap(entry => entry.type === 'voiceTranscript' ? [entry.transcript] : []));
	}

	private sameSource(left: AgentVoiceSource | undefined, right: AgentVoiceSource | undefined): boolean {
		return left?.sessionId === right?.sessionId && left?.threadId === right?.threadId;
	}

	private run(operation: () => Promise<unknown> | undefined): void {
		const generation = this.generation;
		try {
			void operation()?.catch(error => { if (!this.isDisposed && this.isOpen && generation === this.generation) this.notifications.error(localize('agentsVoice.operationFailed', 'Voice conversation: {0}', String(error))); });
		} catch (error) { if (!this.isDisposed) this.notifications.error(localize('agentsVoice.operationFailed', 'Voice conversation: {0}', String(error))); }
	}

	protected override disposeCore(): void { this.closeWindow(); super.disposeCore(); }
}
