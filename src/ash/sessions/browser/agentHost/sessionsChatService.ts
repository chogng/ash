import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { IChatService, ThreadRead, Thread, ThreadGoal } from '../../../workbench/services/chat/common/chatService.js';
import type { AgentInteractionOffer } from '../../../platform/agentHost/common/agent.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from './sessionProviderScopeService.js';

type EventValue<T> = T extends Event<infer V> ? V : never;

/** Routes window Chat calls to the Session's exact host and qualifies backend events. */
export class SessionsChatService extends Disposable implements IChatService {
	// Chat models use offer identity to reject responses after replacement or reconnection.
	// Qualifying IDs must preserve that identity without retaining retired host scopes/offers.
	private readonly scopedOffers = new WeakMap<ISessionProviderScope, WeakMap<AgentInteractionOffer, AgentInteractionOffer>>();
	private readonly listeners = this._register(new DisposableStore());
	private readonly onDidSubmitRequestEmitter = this._register(new Emitter<EventValue<IChatService['onDidSubmitRequest']>>());
	readonly onDidSubmitRequest = this.onDidSubmitRequestEmitter.event;
	private readonly onDidChangeInteractionOfferEmitter = this._register(new Emitter<EventValue<IChatService['onDidChangeInteractionOffer']>>());
	readonly onDidChangeInteractionOffer = this.onDidChangeInteractionOfferEmitter.event;
	private readonly onDidChangeSessionEmitter = this._register(new Emitter<EventValue<IChatService['onDidChangeSession']>>());
	readonly onDidChangeSession = this.onDidChangeSessionEmitter.event;
	private readonly onDidUpdateThreadEmitter = this._register(new Emitter<EventValue<IChatService['onDidUpdateThread']>>());
	readonly onDidUpdateThread = this.onDidUpdateThreadEmitter.event;
	private readonly onDidUpdateThreadTranscriptEmitter = this._register(new Emitter<EventValue<IChatService['onDidUpdateThreadTranscript']>>());
	readonly onDidUpdateThreadTranscript = this.onDidUpdateThreadTranscriptEmitter.event;
	private readonly onDidUpdateGoalEmitter = this._register(new Emitter<EventValue<IChatService['onDidUpdateGoal']>>());
	readonly onDidUpdateGoal = this.onDidUpdateGoalEmitter.event;
	private readonly onDidBecomeReadyEmitter = this._register(new Emitter<EventValue<IChatService['onDidBecomeReady']>>());
	readonly onDidBecomeReady = this.onDidBecomeReadyEmitter.event;
	private readonly onDidUpdateTurnChangesEmitter = this._register(new Emitter<EventValue<IChatService['onDidUpdateTurnChanges']>>());
	readonly onDidUpdateTurnChanges = this.onDidUpdateTurnChangesEmitter.event;
	private readonly onDidChangeQueueEmitter = this._register(new Emitter<EventValue<IChatService['onDidChangeQueue']>>());
	readonly onDidChangeQueue = this.onDidChangeQueueEmitter.event;
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {
		super();
		this._register(scopes.onDidChangeScopes(() => this.bindEvents()));
		this.bindEvents();
	}
	private bindEvents(): void {
		this.listeners.clear();
		for (const scope of this.scopes.getScopes()) {
			const chat = scope.services.chat;
			this.listeners.add(chat.onDidSubmitRequest(event => this.onDidSubmitRequestEmitter.fire(pair(event, scope))));
			this.listeners.add(chat.onDidChangeInteractionOffer(event => this.onDidChangeInteractionOfferEmitter.fire({ ...pair(event, scope), offer: event.offer && this.qualifyOffer(event.offer, scope) })));
			this.listeners.add(chat.onDidChangeSession(event => this.onDidChangeSessionEmitter.fire({ ...event, sessionId: scope.identity(event.sessionId) })));
			this.listeners.add(chat.onDidUpdateThread(event => this.onDidUpdateThreadEmitter.fire(pair(event, scope))));
			this.listeners.add(chat.onDidUpdateThreadTranscript(event => this.onDidUpdateThreadTranscriptEmitter.fire(pair(event, scope))));
			this.listeners.add(chat.onDidUpdateGoal(event => this.onDidUpdateGoalEmitter.fire({ ...event, threadId: scope.identity(event.threadId), goal: event.goal && goal(event.goal, scope) })));
			this.listeners.add(chat.onDidBecomeReady(() => this.onDidBecomeReadyEmitter.fire()));
			this.listeners.add(chat.onDidUpdateTurnChanges(event => this.onDidUpdateTurnChangesEmitter.fire({ ...pair(event, scope), changeSets: event.changeSets.map(value => pair(value, scope)) })));
			this.listeners.add(chat.onDidChangeQueue(() => this.onDidChangeQueueEmitter.fire()));
		}
	}
	private async run<T>(sessionId: string | undefined, operation: (scope: ISessionProviderScope) => Promise<T>): Promise<T> {
		const scope = this.scopes.getScope(sessionId);
		scope.assertCurrent();
		const result = await operation(scope);
		scope.assertCurrent();
		return result;
	}
	getInteractionOffer(...args: Parameters<IChatService['getInteractionOffer']>): ReturnType<IChatService['getInteractionOffer']> {
		try {
			const scope = this.scopes.getScope(args[0]);
			scope.assertCurrent();
			const offer = scope.services.chat.getInteractionOffer(scope.backendIdentity(args[0]), scope.backendIdentity(args[1]));
			return offer && this.qualifyOffer(offer, scope);
		} catch { return undefined; }
	}
	private qualifyOffer(offer: AgentInteractionOffer, scope: ISessionProviderScope): AgentInteractionOffer {
		let offers = this.scopedOffers.get(scope);
		if (!offers) { offers = new WeakMap(); this.scopedOffers.set(scope, offers); }
		let qualified = offers.get(offer);
		if (!qualified) { qualified = pair(offer, scope); offers.set(offer, qualified); }
		return qualified;
	}
	renameThread(...args: Parameters<IChatService['renameThread']>): ReturnType<IChatService['renameThread']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.renameThread(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readHistoryState(...args: Parameters<IChatService['readHistoryState']>): ReturnType<IChatService['readHistoryState']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readHistoryState(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readCheckpoints(...args: Parameters<IChatService['readCheckpoints']>): ReturnType<IChatService['readCheckpoints']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readCheckpoints(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readThread(...args: Parameters<IChatService['readThread']>): ReturnType<IChatService['readThread']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readThread(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return threadRead(result, scope);
		});
	}
	readContextUsage(...args: Parameters<IChatService['readContextUsage']>): ReturnType<IChatService['readContextUsage']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readContextUsage(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	subscribeThread(...args: Parameters<IChatService['subscribeThread']>): ReturnType<IChatService['subscribeThread']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.subscribeThread(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return { ...threadRead(result, scope), updates: result.updates.map(update => pair(update, scope)) };
		});
	}
	unsubscribeThread(...args: Parameters<IChatService['unsubscribeThread']>): ReturnType<IChatService['unsubscribeThread']> {
		let scope: ISessionProviderScope;
		try { scope = this.scopes.getScope(args[0]); scope.assertCurrent(); }
		catch { return Promise.resolve(); } // Retiring a host has already released its connection-owned leases.
		return scope.services.chat.unsubscribeThread(scope.backendIdentity(args[0]), scope.backendIdentity(args[1]), args[2]);
	}

	queuedMessageCount(...args: Parameters<IChatService['queuedMessageCount']>): ReturnType<IChatService['queuedMessageCount']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.queuedMessageCount(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	listTurnChanges(...args: Parameters<IChatService['listTurnChanges']>): ReturnType<IChatService['listTurnChanges']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.listTurnChanges(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result.map(value => pair(value, scope));
		});
	}
	readThreadChanges(...args: Parameters<IChatService['readThreadChanges']>): ReturnType<IChatService['readThreadChanges']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readThreadChanges(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readThreadChangeFile(...args: Parameters<IChatService['readThreadChangeFile']>): ReturnType<IChatService['readThreadChangeFile']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readThreadChangeFile(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readTurnChange(...args: Parameters<IChatService['readTurnChange']>): ReturnType<IChatService['readTurnChange']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readTurnChange(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return { ...result, summary: pair(result.summary, scope) };
		});
	}
	readTurnChangeFile(...args: Parameters<IChatService['readTurnChangeFile']>): ReturnType<IChatService['readTurnChangeFile']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readTurnChangeFile(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	generateTurnChangeMessage(...args: Parameters<IChatService['generateTurnChangeMessage']>): ReturnType<IChatService['generateTurnChangeMessage']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.generateTurnChangeMessage(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result.map(value => pair(value, scope));
		});
	}
	updateTurnChangeDraft(...args: Parameters<IChatService['updateTurnChangeDraft']>): ReturnType<IChatService['updateTurnChangeDraft']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.updateTurnChangeDraft(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result.map(value => pair(value, scope));
		});
	}
	prepareTurnCommit(...args: Parameters<IChatService['prepareTurnCommit']>): ReturnType<IChatService['prepareTurnCommit']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.prepareTurnCommit(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readTurnCommit(...args: Parameters<IChatService['readTurnCommit']>): ReturnType<IChatService['readTurnCommit']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readTurnCommit(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	readTurnCommitFile(...args: Parameters<IChatService['readTurnCommitFile']>): ReturnType<IChatService['readTurnCommitFile']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.readTurnCommitFile(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result;
		});
	}
	commitTurnChange(...args: Parameters<IChatService['commitTurnChange']>): ReturnType<IChatService['commitTurnChange']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.commitTurnChange(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result.map(value => pair(value, scope));
		});
	}
	discardThreadChanges(...args: Parameters<IChatService['discardThreadChanges']>): ReturnType<IChatService['discardThreadChanges']> {
		return this.run(args[0], async scope => {
			const [sessionId, threadId, ...rest] = args;
			const result = await scope.services.chat.discardThreadChanges(scope.backendIdentity(sessionId), scope.backendIdentity(threadId), ...rest);
			return result.map(value => pair(value, scope));
		});
	}
	rewriteRequest(options: Parameters<IChatService['rewriteRequest']>[0]): ReturnType<IChatService['rewriteRequest']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.rewriteRequest(backendOptions(options, scope));
			return pair(result, scope);
		});
	}
	moveHistory(options: Parameters<IChatService['moveHistory']>[0]): ReturnType<IChatService['moveHistory']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.moveHistory(backendOptions(options, scope));
			return result;
		});
	}
	restoreCheckpoint(options: Parameters<IChatService['restoreCheckpoint']>[0]): ReturnType<IChatService['restoreCheckpoint']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.restoreCheckpoint(backendOptions(options, scope));
			return pair(result, scope);
		});
	}
	startTurn(options: Parameters<IChatService['startTurn']>[0]): ReturnType<IChatService['startTurn']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.startTurn(backendOptions(options, scope));
			return result;
		});
	}
	queueTurn(options: Parameters<IChatService['queueTurn']>[0]): ReturnType<IChatService['queueTurn']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.queueTurn(backendOptions(options, scope));
			return result;
		});
	}
	compactContext(options: Parameters<IChatService['compactContext']>[0]): ReturnType<IChatService['compactContext']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.compactContext(backendOptions(options, scope));
			return result;
		});
	}
	configureAdvisor(options: Parameters<IChatService['configureAdvisor']>[0]): ReturnType<IChatService['configureAdvisor']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.configureAdvisor(backendOptions(options, scope));
			return result;
		});
	}
	consultAdvisor(options: Parameters<IChatService['consultAdvisor']>[0]): ReturnType<IChatService['consultAdvisor']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.consultAdvisor(backendOptions(options, scope));
			return result;
		});
	}
	steerTurn(options: Parameters<IChatService['steerTurn']>[0]): ReturnType<IChatService['steerTurn']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.steerTurn(backendOptions(options, scope));
			return result;
		});
	}
	interruptTurn(options: Parameters<IChatService['interruptTurn']>[0]): ReturnType<IChatService['interruptTurn']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.interruptTurn(backendOptions(options, scope));
			return result;
		});
	}
	resolveInteraction(options: Parameters<IChatService['resolveInteraction']>[0]): ReturnType<IChatService['resolveInteraction']> {
		return this.run(options.sessionId, async scope => {
			const result = await scope.services.chat.resolveInteraction(backendOptions(options, scope));
			return result;
		});
	}
	listSlashCommands(...args: Parameters<IChatService['listSlashCommands']>): ReturnType<IChatService['listSlashCommands']> {
		return this.run(undefined, scope => scope.services.chat.listSlashCommands(...args));
	}
	readAdvisorDefault(...args: Parameters<IChatService['readAdvisorDefault']>): ReturnType<IChatService['readAdvisorDefault']> {
		return this.run(undefined, scope => scope.services.chat.readAdvisorDefault(...args));
	}
	saveAdvisorDefault(...args: Parameters<IChatService['saveAdvisorDefault']>): ReturnType<IChatService['saveAdvisorDefault']> {
		return this.run(undefined, scope => scope.services.chat.saveAdvisorDefault(...args));
	}
}

function pair<T extends { readonly sessionId: string; readonly threadId: string; }>(value: T, scope: ISessionProviderScope): T {
	return { ...value, sessionId: scope.identity(value.sessionId), threadId: scope.identity(value.threadId) };
}
function goal(value: ThreadGoal, scope: ISessionProviderScope): ThreadGoal { return { ...value, threadId: scope.identity(value.threadId) }; }
function thread(value: Thread, scope: ISessionProviderScope): Thread {
	const origin = value.origin.type === 'root' ? value.origin : value.origin.type === 'replacement'
		? { ...value.origin, sourceThreadId: scope.identity(value.origin.sourceThreadId) }
		: { ...value.origin, parentThreadId: scope.identity(value.origin.parentThreadId) };
	return { ...pair(value, scope), origin, goal: value.goal && goal(value.goal, scope) };
}
function threadRead<T extends ThreadRead>(value: T, scope: ISessionProviderScope): T {
	return { ...value, thread: thread(value.thread, scope), transcript: pair(value.transcript, scope) };
}
function backendOptions<T extends { readonly sessionId: string; readonly threadId: string; readonly source?: { readonly sessionId: string; readonly threadId: string; }; }>(value: T, scope: ISessionProviderScope): T {
	return {
		...value, sessionId: scope.backendIdentity(value.sessionId), threadId: scope.backendIdentity(value.threadId),
		...('source' in value ? { source: value.source && { sessionId: scope.backendIdentity(value.source.sessionId), threadId: scope.backendIdentity(value.source.threadId) } } : {}),
	};
}
