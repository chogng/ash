import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import type { ITurnChangesApi } from '../common/turnChangesApi.js';
import type { TurnChangeSetSummary, TurnChangeDetails, TurnCommitPreview, TurnChangesUpdate } from '../common/turnChangesApi.js';
import type { TurnChangeSetSummary as TurnChangeSetSummaryDto, TurnChangesReadResult, TurnChangesPrepareCommitResult } from '../../../../../.build/protocol/typescript/index.js';
import { Event } from '../../../base/common/event.js';

export function createDisconnectedTurnChangesApi(unavailable: UnavailableOperation): ITurnChangesApi {
	return {
		onDidChange: Event.None,
		list: () => unavailable('turnChanges.list'),
		summary: () => unavailable('turnChanges.summary'),
		summaryFile: () => unavailable('turnChanges.summaryFile'),
		read: () => unavailable('turnChanges.read'),
		readFile: () => unavailable('turnChanges.readFile'),
		generateMessage: () => unavailable('turnChanges.generateMessage'),
		updateDraft: () => unavailable('turnChanges.updateDraft'),
		prepareCommit: () => unavailable('turnChanges.prepareCommit'),
		readCommit: () => unavailable('turnChanges.readCommit'),
		readCommitFile: () => unavailable('turnChanges.readCommitFile'),
		commit: () => unavailable('turnChanges.commit'),
		discardThread: () => unavailable('turnChanges.discardThread'),
	};
}

export function createAppServerTurnChangesApi(connection: AppServerProtocolClient): ITurnChangesApi {
	const changes = (result: { readonly changeSets: readonly TurnChangeSetSummaryDto[]; }) => ({ changeSets: result.changeSets.map(toSummary) });
	return {
		onDidChange: Event.any<TurnChangesUpdate>((listener, thisArgs) => connection.onNotification(event => {
			if (event.method === 'turnChanges/changed') listener.call(thisArgs, { sessionId: event.params.sessionId, threadId: event.params.threadId, ...changes(event.params) });
		})),
		list: params => appServerRequest(connection, 'turnChanges/list', params).then(changes),
		summary: async params => {
			const result = await appServerRequest(connection, 'turnChanges/summary', params);
			return {
				...result, statistics: { ...result.statistics }, warnings: [...result.warnings],
				repositories: result.repositories.map(repository => ({ repositoryId: repository.repositoryId, files: repository.files.map(file => ({ ...file })) })),
			};
		},
		summaryFile: async params => ({ ...await appServerRequest(connection, 'turnChanges/summaryFile', params) }),
		read: params => appServerRequest(connection, 'turnChanges/read', params).then(toDetails),
		readFile: async params => ({ ...await appServerRequest(connection, 'turnChanges/readFile', params) }),
		generateMessage: params => appServerRequest(connection, 'turnChanges/generateMessage', params).then(changes),
		updateDraft: params => appServerRequest(connection, 'turnChanges/updateDraft', params).then(changes),
		prepareCommit: params => appServerRequest(connection, 'turnChanges/prepareCommit', { ...params, selections: params.selections.map(selection => ({ ...selection, paths: [...selection.paths] })) }).then(toCommitPreview),
		readCommit: params => appServerRequest(connection, 'turnChanges/readCommit', params).then(toCommitPreview),
		readCommitFile: async params => ({ ...await appServerRequest(connection, 'turnChanges/readCommitFile', params) }),
		commit: params => appServerRequest(connection, 'turnChanges/commit', params).then(changes),
		discardThread: params => appServerRequest(connection, 'turnChanges/discardThread', params).then(changes),
	};
}

function toSummary(summary: TurnChangeSetSummaryDto): TurnChangeSetSummary {
	return {
		...summary, statistics: { ...summary.statistics },
		dependencies: [...summary.dependencies], externalDependencyPaths: [...summary.externalDependencyPaths],
		warnings: [...summary.warnings], conflictPaths: [...summary.conflictPaths], committedPaths: [...summary.committedPaths],
	};
}

function toDetails(details: TurnChangesReadResult): TurnChangeDetails {
	return { ...details, summary: toSummary(details.summary), files: details.files.map(file => ({ ...file })) };
}

function toCommitPreview(preview: TurnChangesPrepareCommitResult): TurnCommitPreview {
	return { ...preview, files: preview.files.map(file => ({ ...file })), warnings: [...preview.warnings] };
}
