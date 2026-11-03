import { observableValue } from '../../base/common/observable.js';
import type { Thread } from '../../workbench/services/chat/common/chatService.js';
import type { IActiveSessionThread, ModelRef, ThreadId } from '../services/sessions/common/session.js';

/** Owns unsent model choices for one composer as it switches between durable threads. */
export class SessionModelSelection {
	// An entry with no model is explicit Auto. An absent entry restores the durable model.
	private readonly choices = observableValue<ReadonlyMap<ThreadId, ModelRef | undefined>>(this, new Map());

	select(threadId: ThreadId, model: ModelRef | undefined): void {
		this.choices.set(new Map(this.choices.get()).set(threadId, model));
	}

	isAutomatic(threadId: ThreadId): boolean {
		const choices = this.choices.get();
		return choices.has(threadId) && choices.get(threadId) === undefined;
	}

	resolveModel(active: IActiveSessionThread, thread: Thread | undefined): ModelRef | undefined {
		const lastTurn = thread?.threadId === active.threadId ? thread.turns.at(-1) : undefined;
		return this.choices.get().get(active.threadId) ?? lastTurn?.model ?? active.session.model ?? undefined;
	}
}
