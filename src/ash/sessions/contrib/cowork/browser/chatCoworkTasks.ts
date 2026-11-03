import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IActiveSessionThread } from '../../../services/sessions/common/session.js';
import type { ChatTimelineTask } from '../../../browser/chatTimelineStorage.js';
import { CoworkPaneFactory } from './cowork.contribution.js';

export class ChatCoworkTasks {
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { }

	async prepare(prompt: string, signal: AbortSignal, owner: DisposableStore) {
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
			throw new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.'));
		}
		const draft = this.sessions.createUntitledSession(prompt.slice(0, 80), undefined, undefined, false);
		try {
			const factory = owner.add(this.instantiation.createInstance(CoworkPaneFactory));
			const model = factory.createModel({ kind: 'untitled', session: draft }, owner);
			const target = await model.prepareConversation(signal);
			return { ...target, model };
		} catch (error) {
			this.sessions.discardUntitledSession(draft.untitledSessionId);
			throw error;
		}
	}

	async resolve(task: ChatTimelineTask, signal: AbortSignal): Promise<IActiveSessionThread> {
		await this.sessions.whenDirectoriesReady(signal);
		const session = this.sessions.sessions.find(candidate => candidate.sessionId === task.sessionId);
		if (!session?.chats.some(thread => thread.threadId === task.threadId)) {
			throw new Error(localize('sessions.chat.coworkUnavailable', 'This Cowork task could not be opened.'));
		}
		return { session, threadId: task.threadId };
	}

	createModel(active: IActiveSessionThread, owner: DisposableStore) {
		const factory = owner.add(this.instantiation.createInstance(CoworkPaneFactory));
		return factory.createModel({ kind: 'session', active }, owner);
	}
}
