import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import type { IActiveSessionThread, ISession, ModelRef, SessionId, ThreadId } from "./session.js";

/** Adapts one backend into frontend Session and Chat objects. */
export interface ISessionsProvider extends IDisposable {
	readonly onDidChangeSession: Event<SessionId>;
	list(): Promise<readonly ISession[]>;
	subscribe(session: ISession): Promise<ISession>;
	unsubscribe(sessionId: SessionId): Promise<void>;
	create(title: string, model?: ModelRef): Promise<IActiveSessionThread>;
	setModel(model: ModelRef): Promise<void>;
	archive(session: ISession): Promise<ISession>;
	stop(session: ISession): Promise<ISession>;
	interrupt(session: ISession, threadId: ThreadId): Promise<void>;
}
