import { APP_SERVER_METHODS, type MessageHistoryEntry as EntryDto } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { localize } from '../../../nls.js';
import type { IMessageHistoryService, MessageHistoryEntry, MessageHistoryPage, MessageHistoryQuery, MessageHistorySubmission } from '../common/messageHistory.js';

export class AppServerMessageHistoryService implements IMessageHistoryService {
	constructor(private readonly client: AppServerProtocolClient) {}

	async append(submission: MessageHistorySubmission): Promise<MessageHistoryEntry> {
		const entry = await this.client
			.request(APP_SERVER_METHODS['messageHistory/append'], {
				text: submission.text,
				kind: submission.kind,
				threadId: submission.threadId ?? null,
			})
			.catch(explain);
		return toEntry(entry);
	}

	async read(query: MessageHistoryQuery): Promise<MessageHistoryPage> {
		const page = await this.client
			.request(APP_SERVER_METHODS['messageHistory/read'], {
				before: query.before ?? null,
				text: query.text,
				kind: query.kind ?? null,
				limit: query.limit,
			})
			.catch(explain);
		return { entries: page.entries.map(toEntry), nextBefore: page.nextBefore ?? undefined };
	}

	async clear(): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['messageHistory/clear'], {}).catch(explain);
	}
}

function toEntry(entry: EntryDto): MessageHistoryEntry {
	return {
		id: entry.id,
		submittedAtMs: entry.submittedAtMs,
		text: entry.text,
		kind: entry.kind,
		threadId: entry.threadId ?? undefined,
	};
}

function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		if (error.errorName === 'MessageHistoryUnavailable' || error.errorName === 'ResourceNotOwner') {
			throw new Error(localize('messageHistory.unavailable', 'Input history is unavailable on this connection.'));
		}
		if (error.errorName === 'MessageHistoryOperationFailed') {
			throw new Error(localize('messageHistory.failed', 'Could not access the Profile input history.'));
		}
	}
	throw error;
}
