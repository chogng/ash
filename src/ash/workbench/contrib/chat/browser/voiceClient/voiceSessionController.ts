import type { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { IAgentVoiceService } from '../../../../../platform/agentHost/common/agentService.js';
import { type AgentVoiceSource, type AgentVoiceTaskRequest, type AgentVoiceSessionState, type AgentVoiceSelection, type AgentVoiceConnectionChoice } from '../../../../../platform/agentHost/common/agent.js';

/** Browser controller for one Chat widget. AgentHost owns the connection; Core owns every transcript. */
interface IVoiceSessionController {
	readonly onDidChange: Emitter<void>['event'];
	readonly isAvailable: boolean;
	readonly isConnected: boolean;
	readonly isActive: boolean;
	setSource(source: AgentVoiceSource | undefined, draftIdentity?: string): void;
	connect(window: Window & typeof globalThis, select?: (connections: readonly AgentVoiceConnectionChoice[], signal: AbortSignal) => Promise<AgentVoiceSelection | undefined>): Promise<void>;
	disconnect(): Promise<void>;
	stopSpeaking(): Promise<void>;
}

export class VoiceSessionController extends Disposable implements IVoiceSessionController {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private target: AgentVoiceSource | undefined;
	private targetIdentity: string | undefined;
	private active: AgentVoiceSource | undefined;
	private controller: AbortController | undefined;
	private epoch: number | undefined;
	private readonly handled = new Set<string>();
	private stopping: Promise<void> | undefined;
	private connectedPreviously = false;
	private resource: string | undefined;
	private starting: Promise<AgentVoiceSessionState> | undefined;
	private pendingTasks: AgentVoiceTaskRequest[] = [];
	private preparing: AbortController | undefined;

	constructor(private readonly dispatch: (request: AgentVoiceTaskRequest, signal: AbortSignal) => Promise<void>, private readonly onError: (error: unknown) => void, private readonly prepare: (() => Promise<AgentVoiceSource>) | undefined,
		@IAgentVoiceService private readonly voice: IAgentVoiceService | undefined,
	) {
		super();
		if (voice) {
			this._register(voice.onDidChange(() => {
				const owned = this.resource !== undefined && voice.state?.resourceId === this.resource;
				if (owned && this.connectedPreviously && voice.state?.state === 'failed' && voice.state.error) onError(new Error(voice.state.error));
				this.connectedPreviously = owned && voice.state?.state === 'connected';
				if (!voice.isAvailable || !this.stopping && owned && voice.state && ['ended', 'failed'].includes(voice.state.state)) {
					this.controller?.abort(); this.controller = undefined; this.active = undefined; this.resource = undefined; this.pendingTasks = [];
				}
				if (owned && voice.state?.mediaEpoch !== this.epoch) { this.epoch = voice.state?.mediaEpoch; this.handled.clear(); }
				this.changed.fire();
			}));
			this._register(voice.onDidRequestTask(request => {
				if (!this.resource && this.controller && !this.controller.signal.aborted && sameSource(request, this.active) && sameSource(request, this.target)) {
					if (this.pendingTasks.length < 256) this.pendingTasks.push(request);
					return;
				}
				this.acceptTask(request);
			}));
		}
	}

	public get isAvailable(): boolean { return !this.isDisposed && !this.stopping && (!!this.target || !!this.prepare) && this.voice?.isAvailable === true && (!this.voice.state || ['ended', 'failed'].includes(this.voice.state.state) || this.voice.state.resourceId === this.resource); }
	public get isActive(): boolean { return !!this.controller && (!this.resource || !!this.stopping || this.voice?.state?.resourceId === this.resource && !['ended', 'failed'].includes(this.voice.state.state)); }
	public get isConnected(): boolean { return this.isActive && this.voice?.state?.state === 'connected' && this.voice.state.resourceId === this.resource && sameSource(this.voice.state, this.active); }
	public get isMuted(): boolean { return this.voice?.state?.muted ?? false; }
	public get inputMode(): AgentVoiceSessionState['inputMode'] { return this.voice?.state?.inputMode ?? 'openMic'; }
	public get isListening(): boolean { return this.isConnected && this.voice?.state?.listening === true; }
	public async setMuted(muted: boolean): Promise<void> { if (this.isConnected) await this.voice?.setMuted(muted); }
	public async setInputMode(mode: AgentVoiceSessionState['inputMode']): Promise<void> { if (this.isConnected) await this.voice?.setInputMode(mode); }
	public async pttDown(id: string): Promise<void> { if (this.isConnected) await this.voice?.pttDown(id); }
	public async pttUp(id: string): Promise<void> { if (this.isConnected) await this.voice?.pttUp(id); }

	public setSource(source: AgentVoiceSource | undefined, draftIdentity?: string): void {
		const identity = source ? `${source.sessionId}/${source.threadId}` : draftIdentity;
		if (sameSource(source, this.target) && identity === this.targetIdentity) return;
		this.targetIdentity = identity;
		this.target = source ? { ...source } : undefined;
		if (this.controller && this.preparing !== this.controller && !this.active || this.active && !sameSource(source, this.active)) void this.disconnect().catch(this.onError);
	}

	public async connect(window: Window & typeof globalThis, select?: (connections: readonly AgentVoiceConnectionChoice[], signal: AbortSignal) => Promise<AgentVoiceSelection | undefined>): Promise<void> {
		if (!window?.navigator.userActivation?.isActive) throw new Error(localize('chat.voice.userAction', 'Start voice conversation from a user action.'));
		if (!this.isAvailable || !this.voice) throw new Error(localize('chat.voice.unavailable', 'Voice conversation is unavailable in this host.'));
		if (this.controller) return;
		const originalTarget = this.target ? { ...this.target } : undefined; const originalIdentity = this.targetIdentity; const controller = new AbortController();
		let starting: Promise<AgentVoiceSessionState> | undefined;
		this.active = undefined; this.controller = controller; this.changed.fire();
		try {
			const connections = await this.voice.getOptions();
			if (controller.signal.aborted || this.isDisposed || !sameSource(originalTarget, this.target) || originalIdentity !== this.targetIdentity) throw canceled();
			const connection = connections.find(connection => connection.connectionId === 'openai') ?? connections[0];
			if (!connection) throw new Error(localize('chat.voice.configureProvider', 'Configure a supported voice provider with a direct API credential in Models settings.'));
			const model = connection.models.find(model => model.modelId === connection.defaultModel);
			const selection = select ? await select(connections, controller.signal) : { connectionId: connection.connectionId, modelId: connection.defaultModel, ...(model ? { voice: model.defaultVoice } : {}) };
			if (!selection || controller.signal.aborted || this.isDisposed || originalIdentity !== this.targetIdentity) throw canceled();
			this.preparing = controller;
			let target: AgentVoiceSource;
			try { target = originalTarget ?? await this.prepare!(); } finally { if (this.preparing === controller) this.preparing = undefined; }
			if (controller.signal.aborted || this.isDisposed || !sameSource(target, this.target)) throw canceled();
			this.active = target;
			starting = this.voice.start(target, selection, controller.signal);
			this.starting = starting;
			const status = await starting;
			if (controller.signal.aborted || this.isDisposed || this.controller !== controller) throw canceled();
			this.resource = status.resourceId; this.epoch = status.mediaEpoch; this.connectedPreviously = status.state === 'connected'; this.handled.clear();
			const pending = this.pendingTasks; this.pendingTasks = [];
			for (const request of pending) this.acceptTask(request);
		} catch (error) { if (this.controller === controller) { this.controller = undefined; this.active = undefined; this.resource = undefined; this.pendingTasks = []; } throw error; }
		finally { if (this.starting === starting) this.starting = undefined; this.changed.fire(); }
	}

	public async disconnect(): Promise<void> {
		if (this.stopping) return this.stopping;
		const controller = this.controller;
		if (!controller) return;
		controller.abort();
		const resource = this.resource;
		const stop = resource && this.voice?.state?.resourceId === resource ? this.voice.stop() : this.starting?.then(() => undefined, () => undefined) ?? Promise.resolve();
		this.stopping = stop; this.changed.fire();
		try { await stop; }
		finally { if (this.controller === controller) { this.controller = undefined; this.active = undefined; this.resource = undefined; this.pendingTasks = []; } this.stopping = undefined; this.changed.fire(); }
	}

	private acceptTask(request: AgentVoiceTaskRequest): void {
		const controller = this.controller; const voice = this.voice;
		if (!controller || !voice || controller.signal.aborted || request.resourceId !== this.resource || !sameSource(request, this.active) || !sameSource(request, this.target) || request.mediaEpoch !== voice.state?.mediaEpoch || this.handled.has(request.delegationId) || this.handled.size >= 256) return;
		this.handled.add(request.delegationId);
		void Promise.resolve().then(() => {
			if (controller.signal.aborted || request.resourceId !== this.resource || !sameSource(request, this.target) || request.mediaEpoch !== voice.state?.mediaEpoch) throw canceled();
			return this.dispatch(request, controller.signal);
		}).catch(error => { void voice.rejectTask(request).catch(() => undefined); if (!isCancellationError(error) && !controller.signal.aborted) this.onError(error); });
	}

	public async stopSpeaking(): Promise<void> { if (this.isConnected) await this.voice?.interrupt(); }
	protected override disposeCore(): void { void this.disconnect().catch(() => undefined); super.disposeCore(); }
}
function sameSource(left: AgentVoiceSource | undefined, right: AgentVoiceSource | undefined): boolean { return left?.sessionId === right?.sessionId && left?.threadId === right?.threadId; }

export function pickVoiceConversation(quickInput: IQuickInputService, connections: readonly AgentVoiceConnectionChoice[], signal: AbortSignal): Promise<AgentVoiceSelection | undefined> {
	const items = connections.flatMap(connection => connection.models.flatMap(model => model.voices.map(voice => ({
		label: voice, description: connection.name, detail: model.modelId,
		selection: { connectionId: connection.connectionId, modelId: model.modelId, voice },
		picked: model.modelId === connection.defaultModel && voice === model.defaultVoice,
	}))));
	if (signal.aborted) return Promise.resolve(undefined);
	if (items.length === 1) return Promise.resolve(items[0]!.selection);
	const resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<IQuickPickItem & { readonly selection: AgentVoiceSelection; }>());
	picker.items = items; picker.sortByLabel = false;
	picker.placeholder = localize('chat.voice.selection.hint', 'Choose a voice, model and provider for this conversation.');
	picker.ariaLabel = localize('chat.voice.selection.label', 'Voice conversation options');
	picker.activeItems = [items.find(item => item.picked) ?? items[0]!].filter(Boolean);
	return new Promise(resolve => {
		let settled = false;
		const finish = (selection?: AgentVoiceSelection) => { if (settled) return; settled = true; resolve(selection); picker.hide(); resources.dispose(); };
		const abort = () => finish();
		resources.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		resources.add(picker.onDidAccept(() => finish(picker.activeItems[0]?.selection)));
		resources.add(picker.onDidHide(() => finish()));
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) finish(); else picker.show();
	});
}
