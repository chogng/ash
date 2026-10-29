import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IFileSearchService } from '../common/fileSearch.js';
import { CancellationError } from '../../../base/common/errors.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { URI } from '../../../base/common/uri.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';

export function createAppServerFileSearchApi(connection: AppServerProtocolClient): IFileSearchService {
	return {
		glob: async (directory, query, signal) => {
			const found = await runSearch(
				connection,
				signal,
				operationId =>
					appServerRequest(connection, 'file/search/glob', {
						operationId,
						target: directory.target,
						includePatterns: [...query.includePatterns],
						excludePatterns: [...query.excludePatterns],
						requiredPattern: query.requiredPattern,
						maxResults: query.maxResults,
					}),
				operationId => appServerRequest(connection, 'file/search/glob/cancel', { operationId }),
			);
			return {
				matches: found.paths.map(path => ({ path, resource: URI.joinPath(directory.resource, path) })),
				totalMatches: found.totalMatches,
			};
		},
		fuzzy: async (directory, query, signal) => {
			const found = await runSearch(
				connection,
				signal,
				// Allow process startup and directory registration before the bounded metadata query.
				operationId =>
					connection.request(
						APP_SERVER_METHODS['file/search/fuzzy'],
						{
							operationId,
							target: directory.target,
							query: query.query,
							...(query.includePatterns?.length ? { includePatterns: [...query.includePatterns] } : {}),
							...(query.excludePatterns?.length ? { excludePatterns: [...query.excludePatterns] } : {}),
							maxResults: query.maxResults,
						},
						{ timeoutMs: 3 * 60_000 },
					),
				operationId => appServerRequest(connection, 'file/search/fuzzy/cancel', { operationId }),
			);
			return {
				matches: found.matches.map(match => ({
					...match,
					resource: URI.joinPath(directory.resource, match.path),
				})),
				totalMatches: found.totalMatches,
			};
		},
	};
}

export function createDisconnectedFileSearchApi(unavailable: UnavailableOperation): IFileSearchService {
	return { glob: () => unavailable('fileSearch.glob'), fuzzy: () => unavailable('fileSearch.fuzzy') };
}

async function runSearch<T>(
	connection: AppServerProtocolClient,
	signal: AbortSignal | undefined,
	start: (operationId: string) => Promise<T>,
	cancelRequest: (operationId: string) => Promise<unknown>,
): Promise<T> {
	if (signal?.aborted) {
		throw new CancellationError();
	}
	const generation = connection.generation;
	let retired = false;
	using state = connection.onStateChange(value => {
		if (value !== 'ready') retired = true;
	});
	const isCurrent = (): boolean => !retired && connection.state === 'ready' && connection.generation === generation;
	if (!isCurrent()) {
		throw new CancellationError();
	}
	const operationId = generateUuid();
	const result = start(operationId);
	let cancellation: Promise<unknown> | undefined;
	const cancel = (): void => {
		// The old connection owns both the operation and its teardown. A late
		// AbortSignal must not address an operation on a replacement connection.
		if (!isCurrent()) {
			return;
		}
		// Leave the original request registered until its terminal server response.
		cancellation ??= cancelRequest(operationId);
		void cancellation.catch(() => undefined);
	};
	signal?.addEventListener('abort', cancel, { once: true });
	if (signal?.aborted) {
		cancel();
	}
	try {
		const found = await result;
		if (signal?.aborted || !isCurrent()) {
			throw new CancellationError();
		}
		return found;
	} catch (error) {
		if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') {
			throw new CancellationError();
		}
		throw error;
	} finally {
		signal?.removeEventListener('abort', cancel);
		await cancellation?.catch(() => undefined);
	}
}
