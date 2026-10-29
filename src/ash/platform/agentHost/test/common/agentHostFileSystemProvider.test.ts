import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { consumeStream } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createDisconnectedFileApi } from '../../../files/browser/fileApi.js';
import type { IFileApi, IFileSystemDirectory } from '../../../files/common/fileApi.js';
import { FileService } from '../../../files/common/fileService.js';
import { createDisconnectedResourceApi } from '../../browser/appServerApi.js';
import { AgentHostFileSystemProvider, type IRemoteFilesystemConnection } from '../../common/agentHostFileSystemProvider.js';
import type { IResourceApi } from '../../common/appServerApi.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';

const unavailable = (): never => {
	throw new Error('Unexpected backend operation');
};
const root = URI.from({ scheme: Schemas.ashRemote, authority: 'ssh+host', path: '/srv' });

function connection(resource: URI, label: string, api: Partial<IFileApi> = {}, resources: Partial<IResourceApi> = {}): IRemoteFilesystemConnection {
	return {
		api: {
			...createDisconnectedFileApi(unavailable),
			getMetadata: async () => ({ fileType: 'file', sizeBytes: 1, readonly: false, modifiedAtMillis: null }),
			readFile: async () => ({ content: label, revision: label }),
			...api,
		},
		resourceApi: { ...createDisconnectedResourceApi(unavailable), ...resources },
		directories: () => [{ uri: resource, target: { type: 'environment', dirId: label } }],
	};
}

suite('Agent Host filesystem authority routes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selects the longest registered root on one authority while preserving sibling roots', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		const nested = URI.joinPath(root, 'nested');
		const sibling = root.with({ path: '/other' });
		using parent = provider.registerAuthority(root.authority, connection(root, 'parent'));
		using child = provider.registerAuthority(root.authority, connection(nested, 'nested'));
		using other = provider.registerAuthority(root.authority, connection(sibling, 'sibling'));
		assert.deepEqual(await Promise.all([root, nested, sibling].map(resource => files.readFile(URI.joinPath(resource, 'main.ts'), 'utf8').then(value => value.content))), [
			'parent',
			'nested',
			'sibling',
		]);
		child.dispose();
		await assert.rejects(files.readFile(URI.joinPath(nested, 'main.ts'), 'utf8'));
		assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'parent');
	});

	test('rejects a conflicting root without replacing the active connection', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		using original = provider.registerAuthority(root.authority, connection(root, 'original'));
		assert.throws(() => provider.registerAuthority(root.authority, connection(root, 'conflict')), /already owns/);
		assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'original');
		original.dispose();
		using replacement = provider.registerAuthority(root.authority, connection(root, 'replacement'));
		assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'replacement');
	});

	test('authority casing preserves route identity, localized conflicts, and retirement', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		using registration = provider.registerAuthority(root.authority, connection(root, 'remote'));
		const upper = root.with({ authority: 'ssh+HOST' });
		assert.equal((await files.readFile(URI.joinPath(upper, 'main.ts'), 'utf8')).content, 'remote');
		const translations = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'));
		setNlsMessages('zh-CN', translations);
		try {
			assert.throws(() => provider.registerAuthority(upper.authority, connection(upper, 'conflict')), {
				message: '已有文件系统连接拥有此资源根目录。',
			});
		} finally {
			resetNlsResolver();
		}
		assert.equal((await files.readFile(URI.joinPath(upper, 'main.ts'), 'utf8')).content, 'remote');
		registration.dispose();
		await assert.rejects(files.readFile(URI.joinPath(upper, 'main.ts'), 'utf8'));
	});

	test('unregistering rejects a pending text read before its response and never redirects it to a replacement', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		const started = new DeferredPromise<void>();
		const response = new DeferredPromise<Awaited<ReturnType<IFileApi['readFile']>>>();
		using original = provider.registerAuthority(
			root.authority,
			connection(root, 'old', {
				readFile: () => {
					void started.complete();
					return response.p;
				},
			}),
		);
		const pending = files.readFile(URI.joinPath(root, 'main.ts'), 'utf8');
		const rejected = assert.rejects(pending, isCancellationError);
		await started.p;
		original.dispose();
		try {
			await rejected;
			assert.equal(response.isSettled, false);
			using replacement = provider.registerAuthority(root.authority, connection(root, 'new'));
			await response.complete({ content: 'late old result', revision: 'old' });
			assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'new');
		} finally {
			if (!response.isSettled) {
				await response.complete({ content: 'cleanup', revision: 'old' });
			}
		}
	});

	test('a retired nested root cannot fall back to a primary parent or a later deeper workspace projection', async () => {
		const base = connection(root, 'primary');
		let projected: readonly IFileSystemDirectory[] = base.directories();
		const primaryReads: unknown[] = [];
		using provider = new AgentHostFileSystemProvider({
			...base,
			api: {
				...base.api,
				readFile: async params => {
					primaryReads.push(params);
					return { content: 'wrong host', revision: 'primary' };
				},
			},
			directories: () => projected,
		});
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		const nested = URI.joinPath(root, 'nested');
		using registration = provider.registerAuthority(root.authority, connection(nested, 'nested'));
		registration.dispose();
		await assert.rejects(files.readFile(URI.joinPath(nested, 'main.ts'), 'utf8'));
		const deeper = URI.joinPath(nested, 'deeper');
		projected = [{ uri: deeper, target: { type: 'environment', dirId: 'projected' } }];
		await assert.rejects(files.readFile(URI.joinPath(deeper, 'main.ts'), 'utf8'));
		assert.deepEqual(primaryReads, []);
	});

	test('a connection generation change cancels pending text reads before their stale responses arrive', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		using changed = new Emitter<void>();
		const started = new DeferredPromise<void>();
		const response = new DeferredPromise<Awaited<ReturnType<IFileApi['readFile']>>>();
		const host = connection(root, 'remote');
		let generation = 1;
		let calls = 0;
		using registration = provider.registerAuthority(root.authority, {
			...host,
			api: {
				...host.api,
				get connectionGeneration() {
					return generation;
				},
				onDidChangeConnection: changed.event,
				readFile: async () => {
					if (++calls === 1) {
						void started.complete();
						return response.p;
					}
					return { content: `generation ${generation}`, revision: String(generation) };
				},
			},
		});
		const pending = files.readFile(URI.joinPath(root, 'main.ts'), 'utf8');
		const rejected = assert.rejects(pending, isCancellationError);
		await started.p;
		generation++;
		changed.fire();
		try {
			await rejected;
			assert.equal(response.isSettled, false);
			await response.complete({ content: 'stale generation', revision: '1' });
			assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'generation 2');
		} finally {
			if (!response.isSettled) {
				await response.complete({ content: 'cleanup', revision: '1' });
			}
		}
	});

	test('unmounting before a resolved file target resumes prevents a late backend write', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		const mutations: unknown[] = [];
		using registration = provider.registerAuthority(
			root.authority,
			connection(root, 'remote', {
				writeFile: async params => {
					mutations.push(params);
					return {
						metadata: { fileType: 'file', sizeBytes: 1, readonly: false, modifiedAtMillis: null },
						revision: 'unexpected',
					};
				},
			}),
		);
		const pending = provider.writeTextFile(URI.joinPath(root, 'main.ts'), 'new content', 'utf8', {
			create: true,
			overwrite: true,
		});
		registration.dispose();
		await assert.rejects(pending, isCancellationError);
		assert.deepEqual(mutations, []);
	});

	for (const primary of [false, true]) {
		test(`a ${primary ? 'primary' : 'mounted'} copy scope cannot cross an existing or newly mounted nested route`, async () => {
			let parentCalls = 0;
			let nestedCalls = 0;
			const parent = connection(root, 'parent', {
				getMetadata: async () => {
					parentCalls++;
					return { fileType: 'file', sizeBytes: 1, readonly: false, modifiedAtMillis: null };
				},
			});
			using provider = new AgentHostFileSystemProvider(primary ? parent : connection(URI.file('/workspace'), 'primary'));
			using parentMount = primary ? undefined : provider.registerAuthority(root.authority, parent);
			using scope = provider.acquireCopyScope(root);
			const nested = URI.joinPath(root, 'nested');
			const nestedConnection = (uri: URI) =>
				connection(uri, 'nested', {
					getMetadata: async () => {
						nestedCalls++;
						return { fileType: 'file', sizeBytes: 1, readonly: false, modifiedAtMillis: null };
					},
				});
			using existing = provider.registerAuthority(root.authority, nestedConnection(nested));
			await assert.rejects(scope.stat(URI.joinPath(nested, 'file.ts')), isCancellationError);
			const late = URI.joinPath(root, 'late');
			using lateScope = provider.acquireCopyScope(late);
			const pending = lateScope.stat(URI.joinPath(late, 'file.ts'));
			using lateMount = provider.registerAuthority(root.authority, nestedConnection(late));
			await assert.rejects(pending, isCancellationError);
			assert.deepEqual({ parentCalls, nestedCalls }, { parentCalls: 0, nestedCalls: 0 });
		});
	}

	test('a staged sibling cannot publish or recursively clean through a newly mounted descendant', async () => {
		const mutations: unknown[] = [];
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using parent = provider.registerAuthority(
			root.authority,
			connection(root, 'parent', {
				rename: async params => {
					mutations.push(params);
				},
				delete: async params => {
					mutations.push(params);
				},
			}),
		);
		const target = URI.joinPath(root, 'copied');
		const temporary = URI.joinPath(root, '.ash-copy-private');
		using scope = provider.acquireCopyScope(target);
		using nested = provider.registerAuthority(root.authority, connection(URI.joinPath(temporary, 'nested'), 'nested'));
		await assert.rejects(scope.rename(temporary, target, 'error'), isCancellationError);
		await assert.rejects(scope.delete(temporary, 'ignore', 'recursive'), isCancellationError);
		assert.deepEqual(mutations, []);
	});

	test('source retirement blocks a late target dispatch while its original cleanup scope remains usable', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		const sourceRoot = root.with({ authority: 'ssh+source' });
		using sourceMount = provider.registerAuthority(sourceRoot.authority, connection(sourceRoot, 'source'));
		const target = connection(root, 'target');
		let directories = target.directories();
		const started = new DeferredPromise<void>();
		const resolved = new DeferredPromise<IFileSystemDirectory>();
		let writes = 0;
		let cleanups = 0;
		using targetMount = provider.registerAuthority(root.authority, {
			...target,
			directories: () => directories,
			api: {
				...target.api,
				resolvePath: () => {
					void started.complete();
					return resolved.p;
				},
				writeBinaryFile: async () => {
					writes++;
					throw new Error('Cancelled copy must not publish');
				},
				delete: async () => {
					cleanups++;
				},
			},
		});
		using sourceScope = provider.acquireCopyScope(sourceRoot);
		using targetScope = provider.acquireCopyScope(root);
		using cancellation = new CancellationTokenSource(sourceScope.token);
		directories = [{ uri: root.with({ path: '/other' }), target: { type: 'environment', dirId: 'other' } }];
		const resource = URI.joinPath(root, 'copied.bin');
		const writing = targetScope.writeFile(resource, new Uint8Array([42]), { create: true, overwrite: false }, cancellation.token);
		const rejected = assert.rejects(writing, isCancellationError);
		await started.p;
		sourceMount.dispose();
		try {
			await rejected;
			assert.equal(targetScope.token.isCancellationRequested, false);
			// Join the same target-resolution task to observe its dispatch phase without timing sleeps.
			const observation = targetScope.stat(resource);
			await resolved.complete({ uri: root, target: { type: 'environment', dirId: 'target' } });
			await observation;
			assert.equal(writes, 0);
			await targetScope.delete(resource, 'ignore', 'recursive');
			assert.equal(cleanups, 1);
		} finally {
			if (!resolved.isSettled) {
				await resolved.complete({ uri: root, target: { type: 'environment', dirId: 'target' } });
			}
		}
	});

	test('native cross-connection copy and rename fail before either backend receives a mutation', async () => {
		const mutations: string[] = [];
		const api = (label: string): Partial<IFileApi> => ({
			copy: async () => {
				mutations.push(`${label}:copy`);
			},
			rename: async () => {
				mutations.push(`${label}:rename`);
			},
		});
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary', api('primary')));
		using files = new FileService();
		using localMount = files.registerProvider(Schemas.file, provider);
		using remoteMount = files.registerProvider(Schemas.ashRemote, provider);
		const sibling = root.with({ path: '/other' });
		using first = provider.registerAuthority(root.authority, connection(root, 'first', api('first')));
		using second = provider.registerAuthority(root.authority, connection(sibling, 'second', api('second')));
		const source = URI.joinPath(root, 'main.ts');
		for (const target of [URI.joinPath(sibling, 'main.ts'), URI.file('/workspace/main.ts')]) {
			await assert.rejects(provider.copy(source, target), /not supported/);
			await assert.rejects(files.rename(source, target, 'error'), /not supported/);
		}
		assert.deepEqual(mutations, []);
	});

	test('path identity belongs to its mounted connection and cannot survive replacement', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		const resource = URI.joinPath(root, 'File.TS');
		using original = provider.registerAuthority(
			root.authority,
			connection(root, 'old', {
				readPathCaseSensitivity: async () => ({ scopes: [{ path: '.', sensitivity: 'insensitive' }] }),
			}),
		);
		using identity = files.retainPathIdentity(resource);
		await files.resolvePathIdentity(resource);
		assert.equal(files.getPathIdentity(resource)!.comparisonResource.toString(), URI.joinPath(root, 'file.ts').toString());
		original.dispose();
		assert.equal(files.getPathIdentity(resource)!.comparisonResource.toString(), resource.toString());
		using replacement = provider.registerAuthority(
			root.authority,
			connection(root, 'new', {
				readPathCaseSensitivity: async () => ({ scopes: [{ path: '.', sensitivity: 'sensitive' }] }),
			}),
		);
		await files.resolvePathIdentity(resource);
		assert.equal(files.getPathIdentity(resource)!.comparisonResource.toString(), resource.toString());
	});

	test('a late stream snapshot is released through its original connection after the root is remounted', async () => {
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'primary'));
		using files = new FileService();
		using mounted = files.registerProvider(Schemas.ashRemote, provider);
		const started = new DeferredPromise<void>();
		const snapshot = new DeferredPromise<Awaited<ReturnType<IFileApi['readBinaryFile']>>>();
		const releasedSnapshot = new DeferredPromise<void>();
		const released: string[] = [];
		using original = provider.registerAuthority(
			root.authority,
			connection(
				root,
				'old',
				{
					readBinaryFile: () => {
						void started.complete();
						return snapshot.p;
					},
				},
				{
					release: async request => {
						released.push(`old:${request.resourceId}`);
						await releasedSnapshot.complete();
					},
				},
			),
		);
		const content = await files.readFileStream(URI.joinPath(root, 'paper.pdf'));
		const consumed = consumeStream(content.value);
		const rejected = assert.rejects(consumed, isCancellationError);
		await started.p;
		original.dispose();
		using replacement = provider.registerAuthority(
			root.authority,
			connection(
				root,
				'new',
				{},
				{
					release: async request => {
						released.push(`new:${request.resourceId}`);
					},
				},
			),
		);
		try {
			await rejected;
			assert.equal(snapshot.isSettled, false);
			await snapshot.complete({
				resource: { resourceId: 'late', mimeType: 'application/pdf', size: 1, sha256: 'digest' },
				revision: 'old',
			});
			await releasedSnapshot.p;
			assert.deepEqual(released, ['old:late']);
			assert.equal((await files.readFile(URI.joinPath(root, 'main.ts'), 'utf8')).content, 'new');
		} finally {
			if (!snapshot.isSettled) {
				await snapshot.complete({
					resource: { resourceId: 'cleanup', mimeType: 'application/pdf', size: 0, sha256: 'digest' },
					revision: 'old',
				});
			}
			content.value.destroy();
		}
	});
});
