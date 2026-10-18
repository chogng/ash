import type { IAgentThreadService } from '../../../platform/agentHost/common/agentService.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';

type EventValue<T> = T extends Event<infer V> ? V : never;

/** Shared commands resolve their captured frontend Session identity through the same provider scope as Chat. */
export class SessionsAgentThreadService extends Disposable implements IAgentThreadService {
	private readonly listeners = this._register(new DisposableStore());
	private readonly onDidChangeConnectionEmitter = this._register(new Emitter<EventValue<IAgentThreadService['onDidChangeConnection']>>());
	readonly onDidChangeConnection = this.onDidChangeConnectionEmitter.event;
	private readonly onDidOfferInteractionEmitter = this._register(new Emitter<EventValue<IAgentThreadService['onDidOfferInteraction']>>());
	readonly onDidOfferInteraction = this.onDidOfferInteractionEmitter.event;
	private readonly onDidUpdateThreadEmitter = this._register(new Emitter<EventValue<IAgentThreadService['onDidUpdateThread']>>());
	readonly onDidUpdateThread = this.onDidUpdateThreadEmitter.event;
	private readonly onDidUpdateThreadTranscriptEmitter = this._register(new Emitter<EventValue<IAgentThreadService['onDidUpdateThreadTranscript']>>());
	readonly onDidUpdateThreadTranscript = this.onDidUpdateThreadTranscriptEmitter.event;
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {
		super(); this._register(scopes.onDidChangeScopes(() => this.bind())); this.bind();
	}
	private bind(): void {
		this.listeners.clear();
		for (const scope of this.scopes.getScopes()) {
			this.listeners.add(scope.thread.onDidChangeConnection(event => this.onDidChangeConnectionEmitter.fire(event)));
			this.listeners.add(scope.thread.onDidOfferInteraction(event => this.onDidOfferInteractionEmitter.fire(event)));
			this.listeners.add(scope.thread.onDidUpdateThread(event => this.onDidUpdateThreadEmitter.fire(event)));
			this.listeners.add(scope.thread.onDidUpdateThreadTranscript(event => this.onDidUpdateThreadTranscriptEmitter.fire(event)));
		}
	}
	fork(...args: Parameters<IAgentThreadService['fork']>): ReturnType<IAgentThreadService['fork']> { return this.scopes.getScope(args[0].sessionId).thread.fork(...args); }
	rewrite(...args: Parameters<IAgentThreadService['rewrite']>): ReturnType<IAgentThreadService['rewrite']> { return this.scopes.getScope(args[0].sessionId).thread.rewrite(...args); }
	rename(...args: Parameters<IAgentThreadService['rename']>): ReturnType<IAgentThreadService['rename']> { return this.scopes.getScope(args[0].sessionId).thread.rename(...args); }
	readAttachment(...args: Parameters<IAgentThreadService['readAttachment']>): ReturnType<IAgentThreadService['readAttachment']> { return this.scopes.getScope(args[0].sessionId).thread.readAttachment(...args); }
	listAppTools(...args: Parameters<IAgentThreadService['listAppTools']>): ReturnType<IAgentThreadService['listAppTools']> { return this.scopes.getScope(args[0].sessionId).thread.listAppTools(...args); }
	invokeAppTool(...args: Parameters<IAgentThreadService['invokeAppTool']>): ReturnType<IAgentThreadService['invokeAppTool']> { return this.scopes.getScope(args[0].sessionId).thread.invokeAppTool(...args); }
	readToolResource(...args: Parameters<IAgentThreadService['readToolResource']>): ReturnType<IAgentThreadService['readToolResource']> { return this.scopes.getScope(args[0].sessionId).thread.readToolResource(...args); }
	readAppResource(...args: Parameters<IAgentThreadService['readAppResource']>): ReturnType<IAgentThreadService['readAppResource']> { return this.scopes.getScope(args[0].sessionId).thread.readAppResource(...args); }
	readHistoryState(...args: Parameters<IAgentThreadService['readHistoryState']>): ReturnType<IAgentThreadService['readHistoryState']> { return this.scopes.getScope(args[0].sessionId).thread.readHistoryState(...args); }
	moveHistory(...args: Parameters<IAgentThreadService['moveHistory']>): ReturnType<IAgentThreadService['moveHistory']> { return this.scopes.getScope(args[0].sessionId).thread.moveHistory(...args); }
	readContext(...args: Parameters<IAgentThreadService['readContext']>): ReturnType<IAgentThreadService['readContext']> { return this.scopes.getScope(args[0].sessionId).thread.readContext(...args); }
	checkpoints(...args: Parameters<IAgentThreadService['checkpoints']>): ReturnType<IAgentThreadService['checkpoints']> { return this.scopes.getScope(args[0].sessionId).thread.checkpoints(...args); }
	restoreMessage(...args: Parameters<IAgentThreadService['restoreMessage']>): ReturnType<IAgentThreadService['restoreMessage']> { return this.scopes.getScope(args[0].sessionId).thread.restoreMessage(...args); }
	readTrace(...args: Parameters<IAgentThreadService['readTrace']>): ReturnType<IAgentThreadService['readTrace']> { return this.scopes.getScope(args[0].sessionId).thread.readTrace(...args); }
	readTraceDiagnostics(...args: Parameters<IAgentThreadService['readTraceDiagnostics']>): ReturnType<IAgentThreadService['readTraceDiagnostics']> { return this.scopes.getScope(args[0].sessionId).thread.readTraceDiagnostics(...args); }
	readTracePayload(...args: Parameters<IAgentThreadService['readTracePayload']>): ReturnType<IAgentThreadService['readTracePayload']> { return this.scopes.getScope(args[0].sessionId).thread.readTracePayload(...args); }
	readTraceGraph(...args: Parameters<IAgentThreadService['readTraceGraph']>): ReturnType<IAgentThreadService['readTraceGraph']> { return this.scopes.getScope(args[0].sessionId).thread.readTraceGraph(...args); }
	configureAdvisor(...args: Parameters<IAgentThreadService['configureAdvisor']>): ReturnType<IAgentThreadService['configureAdvisor']> { return this.scopes.getScope(args[0].sessionId).thread.configureAdvisor(...args); }
	read(...args: Parameters<IAgentThreadService['read']>): ReturnType<IAgentThreadService['read']> { return this.scopes.getScope(args[0].sessionId).thread.read(...args); }
	subscribe(...args: Parameters<IAgentThreadService['subscribe']>): ReturnType<IAgentThreadService['subscribe']> { return this.scopes.getScope(args[0].sessionId).thread.subscribe(...args); }
	unsubscribe(...args: Parameters<IAgentThreadService['unsubscribe']>): ReturnType<IAgentThreadService['unsubscribe']> { return this.scopes.getScope(args[0].sessionId).thread.unsubscribe(...args); }
}
