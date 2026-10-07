import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IFileSearchService } from '../common/fileSearch.js';
import { CancellationError } from '../../../base/common/errors.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { URI } from '../../../base/common/uri.js';

export function createAppServerFileSearchApi(connection: AppServerProtocolClient): IFileSearchService {
	return {
		glob: async (directory, query, signal) => {
			if (signal?.aborted) { throw new CancellationError(); }
			const operationId = generateUuid();
			const result = appServerRequest(connection, 'file/search/glob', { operationId, target: directory.target, includePatterns: [...query.includePatterns], excludePatterns: [...query.excludePatterns], maxResults: query.maxResults });
			let cancellation: Promise<unknown> | undefined;
			const cancel = (): void => {
				// Leave the original request registered until its terminal server response.
				cancellation = appServerRequest(connection, 'file/search/glob/cancel', { operationId });
				void cancellation.catch(() => undefined);
			};
			signal?.addEventListener('abort', cancel, { once: true });
			try {
				const found = await result;
				if (signal?.aborted) { throw new CancellationError(); }
				return { matches: found.paths.map(path => ({ path, resource: URI.joinPath(directory.resource, path) })), totalMatches: found.totalMatches };
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') { throw new CancellationError(); }
				throw error;
			} finally {
				signal?.removeEventListener('abort', cancel);
				await cancellation;
			}
		},
	};
}

export function createDisconnectedFileSearchApi(unavailable: UnavailableOperation): IFileSearchService {
	return { glob: () => unavailable('fileSearch.glob') };
}
