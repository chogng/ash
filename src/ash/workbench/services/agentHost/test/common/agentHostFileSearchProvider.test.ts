import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileSearchService, type FileSearchResult } from '../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { QueryBuilder } from '../../../search/common/queryBuilder.js';
import { AgentHostFileSearchProvider } from '../../common/agentHostFileSearchProvider.js';

const folder = { id: 'remote', name: 'remote', index: 0, uri: URI.parse('ash-remote://host/workspace') };

test('Agent Host filename search cancels before an uncooperative backend completes', async () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'remote', folders: [folder] });
	services.registerInstance(IWorkspaceContextService, workspace);
	const response = new DeferredPromise<FileSearchResult>();
	const started = new DeferredPromise<AbortSignal>();
	services.registerInstance(IFileSearchService, {
		async fuzzy(directory, _query, signal) {
			assert.deepEqual(directory, { resource: folder.uri, target: { type: 'workspace', dirId: folder.id } });
			started.complete(signal!);
			return response.p;
		},
		async glob() { assert.fail('fuzzy query'); },
	});
	using provider = services.createInstance(AgentHostFileSearchProvider);
	using cancellation = new CancellationTokenSource();
	const pending = provider.fileSearch(new QueryBuilder().file([folder.uri]), cancellation.token);
	const rejected = assert.rejects(pending, isCancellationError);
	const signal = await started.p;
	cancellation.cancel();
	try {
		await rejected;
		assert.equal(signal.aborted, true);
		assert.equal(response.isSettled, false);
	} finally {
		response.complete({ matches: [], totalMatches: 0 });
	}
});

test('Agent Host filename provider disposal retires pending queries without disposing borrowed services', async () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'remote', folders: [folder] });
	services.registerInstance(IWorkspaceContextService, workspace);
	const response = new DeferredPromise<FileSearchResult>();
	const started = new DeferredPromise<AbortSignal>();
	const backend: IFileSearchService = {
		async fuzzy(_directory, _query, signal) { started.complete(signal!); return response.p; },
		async glob() { assert.fail('fuzzy query'); },
	};
	services.registerInstance(IFileSearchService, backend);
	using provider = services.createInstance(AgentHostFileSearchProvider);
	const query = new QueryBuilder().file([folder.uri]);
	const pending = provider.fileSearch(query);
	const rejected = assert.rejects(pending, isCancellationError);
	const signal = await started.p;
	provider.dispose();
	try {
		await rejected;
		assert.equal(signal.aborted, true);
		assert.equal(services.get(IFileSearchService), backend);
		await assert.rejects(provider.fileSearch(query), isCancellationError);
	} finally {
		response.complete({ matches: [], totalMatches: 0 });
	}
});

test('Agent Host filename search rejects unavailable dependencies and unauthorized roots before starting work', async () => {
	using services = new InstantiationService();
	using workspace = new TestWorkspaceService({ id: 'remote', folders: [folder] });
	services.registerInstance(IWorkspaceContextService, workspace);
	assert.throws(() => services.createInstance(AgentHostFileSearchProvider), /fileSearchService/);
	services.registerInstance(IFileSearchService, {
		async fuzzy() { assert.fail('invalid roots must not start backend work'); },
		async glob() { assert.fail('invalid roots must not start backend work'); },
	});
	using provider = services.createInstance(AgentHostFileSearchProvider);
	await assert.rejects(provider.fileSearch(new QueryBuilder().file([folder.uri, URI.parse('ash-remote://other/workspace')])));
});
