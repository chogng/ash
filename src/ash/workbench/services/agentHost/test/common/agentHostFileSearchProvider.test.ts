import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileSearchService, type FileSearchDirectory, type FileSearchResult } from '../../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { QueryBuilder } from '../../../search/common/queryBuilder.js';
import { AgentHostFileSearchProvider } from '../../common/agentHostFileSearchProvider.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

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
		async glob() {
			assert.fail('fuzzy query');
		},
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
		async fuzzy(_directory, _query, signal) {
			started.complete(signal!);
			return response.p;
		},
		async glob() {
			assert.fail('fuzzy query');
		},
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
		async fuzzy() {
			assert.fail('invalid roots must not start backend work');
		},
		async glob() {
			assert.fail('invalid roots must not start backend work');
		},
	});
	using provider = services.createInstance(AgentHostFileSearchProvider);
	await assert.rejects(provider.fileSearch(new QueryBuilder().file([folder.uri, URI.parse('ash-remote://other/workspace')])));
});

for (const kind of ['fuzzy', 'glob'] as const) {
	for (const late of ['success', 'error'] as const) {
		test(`Agent Host ${kind} query retires its workspace scope and isolates a late ${late}`, async () => {
			using services = new InstantiationService();
			using workspace = new TestWorkspaceService({ id: 'remote', folders: [folder] });
			services.registerInstance(IWorkspaceContextService, workspace);
			const oldResponse = new DeferredPromise<FileSearchResult>();
			const newResponse = new DeferredPromise<FileSearchResult>();
			const oldStarted = new DeferredPromise<AbortSignal>();
			const newStarted = new DeferredPromise<AbortSignal>();
			// The fuzzy case changes the grant identity without changing the root URI.
			const replacement = {
				...folder,
				id: 'replacement',
				uri: kind === 'fuzzy' ? folder.uri : URI.parse('ash-remote://host/next'),
			};
			let calls = 0;
			const search = (directory: FileSearchDirectory, signal: AbortSignal | undefined): Promise<FileSearchResult> => {
				if (++calls === 1) {
					assert.deepEqual(directory, {
						resource: folder.uri,
						target: { type: 'workspace', dirId: folder.id },
					});
					oldStarted.complete(signal!);
					return oldResponse.p;
				}
				assert.deepEqual(directory, {
					resource: replacement.uri,
					target: { type: 'workspace', dirId: replacement.id },
				});
				newStarted.complete(signal!);
				return newResponse.p;
			};
			services.registerInstance(IFileSearchService, {
				fuzzy: (directory, _query, signal) => search(directory, signal),
				glob: (directory, _query, signal) => search(directory, signal),
			});
			using provider = services.createInstance(AgentHostFileSearchProvider);
			const query = (uri: URI) => new QueryBuilder().file([uri], { shouldGlobMatchFilePattern: kind === 'glob' });
			const oldQuery = provider.fileSearch(query(folder.uri));
			const rejected = assert.rejects(oldQuery, isCancellationError);
			const oldSignal = await oldStarted.p;
			try {
				workspace.updateWorkspace({ id: 'remote', folders: [replacement] });
				assert.equal(oldSignal.aborted, true);
				await rejected;
				assert.equal(oldResponse.isSettled, false, 'workspace retirement must not wait for the backend');
				const newQuery = provider.fileSearch(query(replacement.uri));
				const newSignal = await newStarted.p;
				if (late === 'success') {
					oldResponse.complete({
						matches: [{ resource: URI.joinPath(folder.uri, 'old.ts'), path: 'old.ts' }],
						totalMatches: 1,
					});
				} else {
					oldResponse.error(new Error('Retired backend failed'));
				}
				await oldResponse.p.catch(() => undefined);
				assert.equal(newSignal.aborted, false);
				assert.equal(newResponse.isSettled, false);
				const resource = URI.joinPath(replacement.uri, 'new.ts');
				newResponse.complete({ matches: [{ resource, path: 'new.ts' }], totalMatches: 1 });
				assert.deepEqual(await newQuery, { results: [{ resource }], limitHit: false, messages: [] });
				assert.equal(calls, 2);
			} finally {
				oldResponse.complete({ matches: [], totalMatches: 0 });
				newResponse.complete({ matches: [], totalMatches: 0 });
			}
		});
	}
}

for (const nested of [false, true]) {
	test(`Agent Host workspace retirement preserves replacement queries from ${nested ? 'nested changes in an' : 'an'} earlier listener`, async () => {
		using services = new InstantiationService();
		using workspace = new TestWorkspaceService({ id: 'remote', folders: [folder] });
		services.registerInstance(IWorkspaceContextService, workspace);
		const oldResponse = new DeferredPromise<FileSearchResult>();
		const newResponse = new DeferredPromise<FileSearchResult>();
		const oldStarted = new DeferredPromise<AbortSignal>();
		const newStarted = new DeferredPromise<AbortSignal>();
		const replacement = { ...folder, id: 'replacement' };
		services.registerInstance(IFileSearchService, {
			async fuzzy(directory, _query, signal) {
				if (directory.target.type === 'workspace' && directory.target.dirId === folder.id) {
					oldStarted.complete(signal!);
					return oldResponse.p;
				}
				assert.deepEqual(directory, {
					resource: replacement.uri,
					target: { type: 'workspace', dirId: replacement.id },
				});
				newStarted.complete(signal!);
				return newResponse.p;
			},
			async glob() {
				assert.fail('fuzzy query');
			},
		});
		let provider: AgentHostFileSearchProvider;
		let replacementQuery: ReturnType<AgentHostFileSearchProvider['fileSearch']> | undefined;
		using earlier = workspace.onDidChangeWorkspace(() => {
			if (replacementQuery) {
				return;
			}
			if (nested) {
				workspace.updateWorkspace({ id: 'remote', folders: [replacement] });
			}
			replacementQuery = provider.fileSearch(new QueryBuilder().file([replacement.uri]));
		});
		using owner = services.createInstance(AgentHostFileSearchProvider);
		provider = owner;
		const oldQuery = provider.fileSearch(new QueryBuilder().file([folder.uri]));
		const rejected = assert.rejects(oldQuery, isCancellationError);
		const oldSignal = await oldStarted.p;
		try {
			workspace.updateWorkspace({
				id: 'remote',
				folders: [nested ? { ...folder, id: 'intermediate' } : replacement],
			});
			const newSignal = await newStarted.p;
			await rejected;
			assert.equal(oldSignal.aborted, true);
			assert.equal(oldResponse.isSettled, false);
			assert.equal(newSignal.aborted, false);
			assert.ok(replacementQuery);
			const resource = URI.joinPath(replacement.uri, 'new.ts');
			newResponse.complete({ matches: [{ resource, path: 'new.ts' }], totalMatches: 1 });
			assert.deepEqual(await replacementQuery, { results: [{ resource }], limitHit: false, messages: [] });
		} finally {
			oldResponse.complete({ matches: [], totalMatches: 0 });
			newResponse.complete({ matches: [], totalMatches: 0 });
		}
	});
}
