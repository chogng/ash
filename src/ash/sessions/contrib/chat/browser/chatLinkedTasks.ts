import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IActiveSessionThread } from '../../../../workbench/services/sessions/common/session.js';
import { NativeChatPaneFactory } from './nativeChatPaneFactory.js';

export class ChatLinkedTasks {
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
	) { }

	async resolve(sessionId: string, threadId: string, signal: AbortSignal): Promise<IActiveSessionThread> {
		await this.sessions.whenDirectoriesReady(signal);
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session?.chats.some(thread => thread.threadId === threadId)) {
			throw new Error(localize('sessions.chat.linkedTaskUnavailable', 'This task could not be opened.'));
		}
		return { session, threadId };
	}

	createModel(active: IActiveSessionThread, owner: DisposableStore) {
		const factory = owner.add(this.instantiation.createInstance(NativeChatPaneFactory));
		return factory.createModel({ kind: 'session', active }, owner);
	}
}
