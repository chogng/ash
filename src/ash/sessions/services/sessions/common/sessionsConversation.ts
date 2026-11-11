import type { IActiveSessionThread, IUntitledChatSession } from './session.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export type SessionsConversationKind = 'code' | 'chat';

/** Entry navigation selects the conversation UI before revealing or focusing its Part. */
export interface ISessionsConversationService {
	readonly newDraftVisible: IObservable<boolean>;
	openInNewWindow(selection: { readonly kind: 'session'; readonly active: IActiveSessionThread; } | { readonly kind: 'untitled'; readonly session: IUntitledChatSession; }): Promise<void>;
	setConversationKind(kind: SessionsConversationKind): Promise<void>;
	focusDraftPicker(picker: 'workspace' | 'environment'): void;
}

export const ISessionsConversationService = createServiceIdentifier<ISessionsConversationService>('sessionsConversationService');
