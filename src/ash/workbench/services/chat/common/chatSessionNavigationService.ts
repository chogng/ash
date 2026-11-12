import { canceled } from '../../../../base/common/errors.js';
import type { IAppServerApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { localize } from '../../../../nls.js';
import type { ChatAgent, IChatService, ThreadRead } from './chatService.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { OpenSessionLink } from '../../../../platform/agentHost/common/openSessionLink.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ToolResultPresentation } from '../../../../platform/agentHost/common/agent.js';
import type { SessionKind } from '../../../../platform/agentHost/common/agent.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';

/** A borrowed backend incarnation. Any state transition or Session-owner retirement invalidates it. */
export interface IChatSessionConnection extends IDisposable {
	readonly generation: number;
	/** Checks ownership and readiness before and after awaiting the owning backend's state. */
	assertCurrent(): Promise<void>;
}

/** One owner-validated read supplies both the address and its execution directory. */
export interface IPreparedChatConversation {
	readonly link: OpenSessionLink;
	readonly directory: ThreadRead['directory'];
}

/** Conversation destinations exposed by the session owner to workbench contributions. */
export interface IChatSessionNavigationService {
	/** Resolves backend-local result coordinates through the originating Session's host. */
	openToolResult?(sourceSessionId: string, target: ToolResultPresentation, signal: AbortSignal, options?: { readonly sideBySide?: boolean; }): Promise<void>;
	readonly revision: number;
	/** Multi-host owners capture the selected Session's backend; unavailable Sessions must throw without ambient fallback. */
	captureConnection?(sessionId: string): IChatSessionConnection;
	/** Multi-host owners validate and return backend coordinates on the captured connection. */
	prepareConversationLink?(sessionId: string, threadId: string): Promise<OpenSessionLink>;
	/** Prepares a cross-window handoff without relying on a cached Session directory. */
	prepareConversation?(sessionId: string, threadId: string): Promise<IPreparedChatConversation>;
	/** Resolves an opaque authority without interpreting it in shared Workbench code. */
	openConversationLink?(address: OpenSessionLink, options?: { readonly sideBySide?: boolean; }): Promise<void>;
	/** Creates and selects an unsent draft; focus reveals its presentation. False means the host picker was canceled. */
	createNewConversation(options?: { readonly focus?: boolean; readonly providerId?: string; readonly agent?: ChatAgent; }): boolean | void | Promise<boolean | void>;
	/** Hosts with their own conversation presentation also own its history picker. */
	showConversationHistory?(): void | Promise<void>;
	getConversations(): readonly { readonly providerId?: string; readonly providerLabel?: string; readonly kind?: SessionKind; readonly sessionId: string; readonly threadId: string; readonly title: string; }[];
	/** Uses the renderer identities that the composer and transcript service share. */
	getConversationsForReference?(): readonly { readonly providerId: string; readonly providerLabel?: string; readonly sessionId: string; readonly threadId: string; readonly title: string; }[];
	/** Appends a feature handoff without sending or replacing the existing draft and attachments. */
	appendToActiveDraft(text: string): void;
	getActiveConversation(): { readonly sessionId: string; readonly threadId: string; } | undefined;
	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined>;
	/** A supplied provider must be resolved before any host-local Session ID is used. */
	openConversation(sessionId: string, threadId: string, providerId?: string): Promise<void>;
	openSideConversation?(sessionId: string, threadId: string): Promise<void>;
	/** Starts voice through the visible Chat's controller, preserving its composer and submission policy. */
	startVoiceConversation(): Promise<void>;
}

export const IChatSessionNavigationService = createServiceIdentifier<IChatSessionNavigationService>('chatSessionNavigationService');

/** Keeps local conversation reads and their consumers within the captured backend incarnation. */
export async function withChatConversation(
	chat: IChatService,
	appServer: IAppServerApi,
	sessionId: string,
	threadId: string,
	operation: (conversation: ThreadRead) => Promise<void>,
): Promise<void> {
	const generation = appServer.connectionGeneration;
	let retired = false;
	// Close can retire a resolved response before its consumer runs without changing generation.
	const listener = appServer.onConnectionState(state => {
		if (state !== 'ready') {
			retired = true;
		}
	});
	try {
		const result = await chat.readThread(sessionId, threadId);
		const state = await appServer.getConnectionState();
		if (retired || generation !== appServer.connectionGeneration || state !== 'ready') {
			throw canceled();
		}
		if (result.thread.sessionId !== sessionId || result.thread.threadId !== threadId) {
			throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
		}
		await operation(result);
	} finally {
		listener.dispose();
	}
}
