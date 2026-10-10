import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { IContentSearchService, type ContentSearchMatch } from '../../../../../platform/search/common/search.js';
import { BrowserContentSearchService } from '../../../../../platform/search/browser/searchService.js';
import type { IContentSearchApi } from '../../../../../platform/search/common/searchApi.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { IFileTextModelService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { BulkEditTestServices } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { SearchResultImpl } from '../../../../contrib/search/browser/searchTreeModel/searchResult.js';
import { BrowserFileSearchService } from '../../../../../platform/search/browser/browserFileSearchService.js';
import { IFileSearchService } from '../../../../../platform/search/common/fileSearch.js';
import { SearchService } from '../../common/searchService.js';
import { QueryBuilder } from '../../common/queryBuilder.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import translatedWorkbench from '../../../../../../../localization/zh-CN/workbench.json' with { type: 'json' };

const folders = [
	{ id: 'first', name: 'first', index: 0, uri: URI.file('/workspace') },
	{ id: 'second', name: 'second', index: 1, uri: URI.parse('ssh://host/other') },
];
const resource = URI.joinPath(folders[0]!.uri, 'main.ts');
const pattern = { pattern: 'needle', isCaseSensitive: true };
const query = (): ReturnType<QueryBuilder['text']> => new QueryBuilder().text(pattern, folders.map(folder => folder.uri));
const content: ContentSearchMatch = { path: 'main.ts', lineNumber: 1, preview: 'disk needle', ranges: [{ start: 5, end: 11 }] };

test('Workbench text search reads current models, suppresses zero-match disk results and preserves root identity', async () => {
	using fixture = new BulkEditTestServices([[resource, 'disk needle']]);
	using reference = await fixture.models.acquire({ resource }, new AbortController().signal);
	reference.model.setValue('edited without a match');
	using workspace = new WorkspaceContextService({ id: 'workspace', folders });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IFileSearchService, new BrowserFileSearchService(fixture.files));
	services.registerInstance(IFileTextModelService, fixture.models);
	services.registerInstance(IContentSearchService, {
		async search(folder, _query, options) {
			options?.onProgress?.([{ ...content, dirId: folder.id }]);
			return { resultCount: 1, limitHit: false, error: undefined };
		},
	});
	const service = services.createInstance(SearchService);
	const result = new SearchResultImpl(folders);
	const complete = await service.textSearch(query(), CancellationToken.None, progress => {
		if ('resource' in progress) { result.addFileMatch(progress); }
	});
	assert.deepEqual({ files: result.files.map(file => file.resource.toString()), count: result.count, limitHit: complete.limitHit, disk: fixture.store.text(resource) }, {
		files: [URI.joinPath(folders[1]!.uri, 'main.ts').toString()], count: 1, limitHit: false, disk: 'disk needle',
	});
	reference.model.setValue('中文😀 needle needle\r\nneedle');
	const edited = new SearchResultImpl(folders);
	await service.textSearch(query(), CancellationToken.None, progress => {
		if ('resource' in progress) { edited.addFileMatch(progress); }
	});
	assert.deepEqual(edited.files[0]!.matches.map(match => ({ ...match.range })), [
		{ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 12 },
		{ startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: 19 },
		{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 },
	]);
});

test('Workbench model results obey includes, parent excludes, case and multiline regular expressions', async () => {
	const nested = URI.joinPath(folders[0]!.uri, 'src/main.ts');
	using fixture = new BulkEditTestServices([[nested, '中文😀 first\r\nsecond end\r\nFIRST\r\nsecond']]);
	using reference = await fixture.models.acquire({ resource: nested }, new AbortController().signal);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders: folders.slice(0, 1) });
	const service = new SearchService({ async search() { return { resultCount: 0, limitHit: false, error: undefined }; } }, workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	const builder = new QueryBuilder();
	const textQuery = builder.text({ pattern: 'first\nsecond', isRegExp: true, isCaseSensitive: true }, [folders[0]!.uri], { includePattern: 'src/**' });
	const result = new SearchResultImpl(folders);
	await service.textSearch(textQuery, CancellationToken.None, progress => {
		if ('resource' in progress) { result.addFileMatch(progress); }
	});
	assert.deepEqual(result.files[0]!.matches.map(match => ({ ...match.range })), [{ startLineNumber: 1, startColumn: 6, endLineNumber: 2, endColumn: 7 }]);
	textQuery.excludePattern = { src: true };
	assert.deepEqual((await service.textSearch(textQuery)).results, []);
	textQuery.excludePattern = undefined;
	textQuery.includePattern = { 'docs/**': true };
	assert.deepEqual((await service.textSearch(textQuery)).results, []);
});

test('Workbench budget counts occurrences and releases the backend job before starting another root', async () => {
	using fixture = new BulkEditTestServices([]);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders });
	const started: string[] = [];
	const released: string[] = [];
	const api: IContentSearchApi = {
		async start(params) { started.push(params.dirId!); return { searchId: 'job' }; },
		async read() {
			return { searchId: 'job', matches: [{ ...content, preview: 'needle needle needle', ranges: [{ start: 0, end: 6 }, { start: 7, end: 13 }, { start: 14, end: 20 }] }], nextMatch: 1, completed: true, limitHit: false, error: null };
		},
		async cancel(params) { released.push(params.searchId); },
	};
	const service = new SearchService(new BrowserContentSearchService(api), workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	const result = new SearchResultImpl(folders);
	const complete = await service.textSearch({ ...query(), maxResults: 2 }, CancellationToken.None, progress => {
		if ('resource' in progress) { result.addFileMatch(progress); }
	});
	assert.deepEqual({ count: result.count, limitHit: complete.limitHit, started, released }, { count: 2, limitHit: true, started: ['first'], released: ['job'] });
});

test('an exact Workbench budget remains complete when no additional occurrence exists', async () => {
	using fixture = new BulkEditTestServices([[resource, 'needle']]);
	using reference = await fixture.models.acquire({ resource }, new AbortController().signal);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders: folders.slice(0, 1) });
	const service = new SearchService({
		async search(_folder, _query, options) {
			options?.onProgress?.([content]);
			return { resultCount: 1, limitHit: false, error: undefined };
		}
	}, workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	const complete = await service.textSearch(new QueryBuilder().text(pattern, [folders[0]!.uri], { maxResults: 1 }));
	assert.deepEqual({ count: complete.results.length, limitHit: complete.limitHit }, { count: 1, limitHit: false });
});

test('whole-word model search excludes longer and Unicode-adjacent words', async () => {
	using fixture = new BulkEditTestServices([[resource, 'needles needle 中文needle needle_ needle.']]);
	using reference = await fixture.models.acquire({ resource }, new AbortController().signal);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders: folders.slice(0, 1) });
	const service = new SearchService({ async search() { return { resultCount: 0, limitHit: false, error: undefined }; } }, workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	const complete = await service.textSearch(new QueryBuilder().text({ ...pattern, isWordMatch: true }, [folders[0]!.uri]));
	assert.deepEqual(complete.results[0]!.results!.flatMap(match => match.rangeLocations.map(location => location.source.startColumn)), [8, 32]);
});

test('overlapping roots count and publish a source occurrence once', async () => {
	const nested = { id: 'nested', name: 'nested', index: 1, uri: URI.joinPath(folders[0]!.uri, 'src') };
	using fixture = new BulkEditTestServices([]);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders: [folders[0]!, nested] });
	const service = new SearchService({
		async search(folder, _query, options) {
			options?.onProgress?.([{ ...content, path: folder.id === 'first' ? 'src/main.ts' : 'main.ts' }]);
			return { resultCount: 1, limitHit: false, error: undefined };
		}
	}, workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	let delivered = 0;
	const complete = await service.textSearch(new QueryBuilder().text(pattern, [folders[0]!.uri, nested.uri], { maxResults: 1 }), CancellationToken.None, () => delivered++);
	assert.deepEqual({ delivered, files: complete.results.length, matches: complete.results[0]!.results!.length, limitHit: complete.limitHit }, { delivered: 1, files: 1, matches: 1, limitHit: false });
});

test('Workbench cancellation suppresses a pending backend read and releases its job', async () => {
	using fixture = new BulkEditTestServices([]);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders });
	using cancellation = new CancellationTokenSource();
	const reading = new DeferredPromise<void>();
	const response = new DeferredPromise<Awaited<ReturnType<IContentSearchApi['read']>>>();
	const released: string[] = [];
	let progressCount = 0;
	const api: IContentSearchApi = {
		async start() { return { searchId: 'pending' }; },
		async read() { reading.complete(); return response.p; },
		async cancel(params) { released.push(params.searchId); },
	};
	const pending = new SearchService(new BrowserContentSearchService(api), workspace, fixture.models, new BrowserFileSearchService(fixture.files)).textSearch(query(), cancellation.token, () => progressCount++);
	const rejected = assert.rejects(pending, isCancellationError);
	await reading.p;
	cancellation.cancel();
	await rejected;
	response.complete({ searchId: 'pending', matches: [{ ...content, ranges: [...content.ranges] }], nextMatch: 1, completed: true, limitHit: false, error: null });
	assert.deepEqual({ progressCount, released }, { progressCount: 0, released: ['pending'] });
});

test('Workbench search requires model registration and localizes an empty workspace', async () => {
	using fixture = new BulkEditTestServices([]);
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	using services = new InstantiationService();
	services.registerInstance(IContentSearchService, { async search() { assert.fail('no directory to search'); } });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IFileSearchService, new BrowserFileSearchService(fixture.files));
	assert.throws(() => services.createInstance(SearchService), /fileTextModelService/);
	services.registerInstance(IFileTextModelService, fixture.models);
	setNlsMessages('zh-CN', { ash: translatedWorkbench.ash });
	try {
		assert.deepEqual(await services.createInstance(SearchService).textSearch(new QueryBuilder().text(pattern)), { results: [], limitHit: false, messages: [{ text: '请打开文件夹以搜索文件。' }] });
		await assert.rejects(services.createInstance(SearchService).textSearch(query()), { message: '搜索目录不属于当前工作区。' });
		workspace.updateWorkspace({ id: 'workspace', folders });
		await assert.rejects(services.createInstance(SearchService).textSearch({ ...query(), maxResults: 0 }), { message: '搜索结果上限必须介于 1 和 5000 之间。' });
	} finally { resetNlsResolver(); }
});

test('explicit open resources search outside the workspace without disk access and retain their URI through dismissal', async () => {
	const draft = URI.parse('untitled:/Untitled-1');
	const outside = URI.file('/outside/main.ts');
	using fixture = new BulkEditTestServices([]);
	using draftReference = await fixture.models.acquire({ resource: draft, initialText: '中文😀 needle needle' }, new AbortController().signal);
	using outsideReference = await fixture.models.acquire({ resource: outside, initialText: 'needle' }, new AbortController().signal);
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	const service = new SearchService({ async search() { assert.fail('extra resources must only read existing models'); } }, workspace, fixture.models, new BrowserFileSearchService(fixture.files));
	const textQuery = new QueryBuilder().text(pattern, [], { extraFileResources: [draft, outside], maxResults: 3 });
	const result = new SearchResultImpl([]);
	const complete = await service.textSearch(textQuery, CancellationToken.None, progress => {
		if ('resource' in progress) { result.addFileMatch(progress); }
	});
	assert.deepEqual({ resources: result.files.map(file => file.resource.toString()), count: result.count, roots: result.children.length, messages: complete.messages, limitHit: complete.limitHit }, {
		resources: [draft.toString(), outside.toString()], count: 3, roots: 0, messages: [], limitHit: false,
	});
	result.batchRemove([result.files[0]!.matches[0]!, result.files[1]!]);
	assert.equal(result.count, 1);
	result.addFileMatch(complete.results[0]!);
	assert.equal(result.count, 2);
	textQuery.includePattern = { '**/*.ts': true };
	assert.deepEqual((await service.textSearch(textQuery)).results.map(file => file.resource.toString()), [outside.toString()]);
	textQuery.includePattern = undefined;
	textQuery.excludePattern = { 'Untitled-*': true };
	assert.deepEqual((await service.textSearch(textQuery)).results.map(file => file.resource.toString()), [outside.toString()]);
	assert.deepEqual(fixture.store.saved, []);
});


test('Workbench file search ranks all roots before its global limit and keeps glob queries explicit', async () => {
	using fixture = new BulkEditTestServices([]);
	using workspace = new WorkspaceContextService({ id: 'workspace', folders });
	const calls: string[] = [];
	const provider: IFileSearchService = {
		async fuzzy(directory, query) {
			calls.push(directory.target.type === 'workspace' ? directory.target.dirId : 'session');
			assert.equal(query.query, 'main');
			assert.equal(query.maxResults, 3);
			const paths = directory.resource.scheme === 'file' ? [['main.ts', 10], ['src/main.ts', 5]] as const : [['main.ts', 40]] as const;
			return { matches: paths.map(([path, score]) => ({ path, score, resource: URI.joinPath(directory.resource, path) })), totalMatches: paths.length };
		},
		async glob(directory, query) {
			assert.deepEqual(query.includePatterns, ['**/*.ts']);
			assert.deepEqual(query.excludePatterns, []);
			return { matches: [{ path: 'main.ts', resource: URI.joinPath(directory.resource, 'main.ts') }], totalMatches: 1 };
		},
	};
	const service = new SearchService({ async search() { assert.fail('file query must not search contents'); } }, workspace, fixture.models, provider);
	const complete = await service.fileSearch(new QueryBuilder().file(folders.map(folder => folder.uri), { filePattern: ' main ', sortByScore: true, maxResults: 2 }));
	assert.deepEqual(complete.results.map(file => file.resource.toString()), [URI.joinPath(folders[1]!.uri, 'main.ts').toString(), resource.toString()]);
	assert.equal(complete.limitHit, true);
	assert.deepEqual(calls, ['first', 'second']);
	const glob = await service.fileSearch(new QueryBuilder().file(folders.map(folder => folder.uri), { filePattern: '**/*.ts', shouldGlobMatchFilePattern: true, maxResults: 2 }));
	assert.deepEqual(glob.results.map(file => file.resource.toString()), [resource.toString(), URI.joinPath(folders[1]!.uri, 'main.ts').toString()]);
	assert.equal(glob.limitHit, false);
});

test('Workbench file search deduplicates overlapping roots and cancellation rejects a late response', async () => {
	using fixture = new BulkEditTestServices([]);
	const nested = { ...folders[0]!, id: 'nested', index: 1, uri: URI.joinPath(folders[0]!.uri, 'src') };
	using workspace = new WorkspaceContextService({ id: 'workspace', folders: [folders[0]!, nested] });
	const response = new DeferredPromise<void>();
	const started = new DeferredPromise<AbortSignal>();
	let pending = false;
	let calls = 0;
	const provider: IFileSearchService = {
		async glob() { assert.fail('fuzzy query must not use glob'); },
		async fuzzy(directory, _query, signal) {
			calls++;
			if (pending) { started.complete(signal!); await response.p; }
			const path = directory.resource.path.endsWith('/src') ? 'main.ts' : 'src/main.ts';
			return { matches: [{ path, score: 10, resource: URI.joinPath(directory.resource, path) }], totalMatches: 1 };
		},
	};
	const service = new SearchService({ async search() { assert.fail(); } }, workspace, fixture.models, provider);
	const fileQuery = new QueryBuilder().file(workspace.getWorkspace().folders.map(folder => folder.uri), { filePattern: 'main', sortByScore: true, maxResults: 1 });
	const complete = await service.fileSearch(fileQuery);
	assert.equal(complete.results.length, 1);
	assert.equal(complete.limitHit, false);
	pending = true;
	calls = 0;
	using cancellation = new CancellationTokenSource();
	const search = service.fileSearch(fileQuery, cancellation.token);
	const rejected = assert.rejects(search, isCancellationError);
	const signal = await started.p;
	cancellation.cancel();
	assert.equal(signal.aborted, true);
	response.complete();
	await rejected;
	assert.equal(calls, 1);
});
