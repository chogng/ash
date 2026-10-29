import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { OpenSessionLink } from '../../../../platform/agentHost/common/openSessionLink.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';

/** A borrowed backend incarnation. Any state transition or Session-owner retirement invalidates it. */
export interface IChatSessionConnection extends IDisposable {
	readonly generation: number;
	/** Checks ownership and readiness before and after awaiting the owning backend's state. */
	assertCurrent(): Promise<void>;
}

/** Conversation destinations exposed by the session owner to workbench contributions. */
export interface IChatSessionNavigationService {
	readonly revision: number;
	/** Multi-host owners capture the selected Session's backend; unavailable Sessions must throw without ambient fallback. */
	captureConnection?(sessionId: string): IChatSessionConnection;
	/** Multi-host owners validate and return backend coordinates on the captured connection. */
	prepareConversationLink?(sessionId: string, threadId: string): Promise<OpenSessionLink>;
	/** Resolves an opaque authority without interpreting it in shared Workbench code. */
	openConversationLink?(address: OpenSessionLink): Promise<void>;
	getConversations(): readonly {
		readonly providerId?: string;
		readonly sessionId: string;
		readonly threadId: string;
		readonly title: string;
	}[];
	/** Appends a feature handoff without sending or replacing the existing draft and attachments. */
	appendToActiveDraft(text: string): void;
	getActiveConversation(): { readonly sessionId: string; readonly threadId: string } | undefined;
	captureActiveDraft(): Promise<
		{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined
	>;
	/** A supplied provider must be resolved before any host-local Session ID is used. */
	openConversation(sessionId: string, threadId: string, providerId?: string): Promise<void>;
	/** Starts voice through the visible Chat's controller, preserving its composer and submission policy. */
	startVoiceConversation(): Promise<void>;
}

export const IChatSessionNavigationService =
	createServiceIdentifier<IChatSessionNavigationService>('chatSessionNavigationService');
