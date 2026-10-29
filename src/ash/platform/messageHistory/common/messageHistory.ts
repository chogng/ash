import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type MessageHistoryKind = 'agent' | 'shell' | 'command';

export interface MessageHistorySubmission {
	readonly text: string;
	readonly kind: MessageHistoryKind;
	readonly threadId?: string;
}

export interface MessageHistoryEntry extends MessageHistorySubmission {
	readonly id: string;
	readonly submittedAtMs: number;
}

export interface MessageHistoryQuery {
	readonly before?: string;
	readonly text: string;
	readonly kind?: MessageHistoryKind;
	readonly limit: number;
}

export interface MessageHistoryPage {
	readonly entries: readonly MessageHistoryEntry[];
	readonly nextBefore?: string;
}

/** The host's local Profile owns input records independently of the execution environment. */
export interface IMessageHistoryService {
	append(submission: MessageHistorySubmission): Promise<MessageHistoryEntry>;
	read(query: MessageHistoryQuery): Promise<MessageHistoryPage>;
	clear(): Promise<void>;
}

/** Hosts without Profile history explicitly register an unavailable capability. */
export const IMessageHistoryService = createServiceIdentifier<IMessageHistoryService | undefined>('messageHistoryService');
