import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHostFileSystemProvider, type IRemoteFilesystemConnection } from '../../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { createDisconnectedResourceApi } from '../../../../../platform/agentHost/browser/appServerApi.js';
import { createDisconnectedFileApi } from '../../../../../platform/files/browser/fileApi.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { AgentHostFileSystemService } from '../../common/agentHostFileSystemService.js';

const unavailable = (): never => {
	throw new Error('Unexpected backend operation');
};

function connection(root: URI, content: string): IRemoteFilesystemConnection {
	return {
		api: {
			...createDisconnectedFileApi(unavailable),
			readFile: async () => ({ content, revision: 'r1' }),
		},
		resourceApi: createDisconnectedResourceApi(unavailable),
		directories: () => [{ uri: root, target: { type: 'environment', dirId: 'root' } }],
	};
}

suite('AgentHostFileSystemService workspace registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('routes both schemes through the existing host provider and releases only its registrations', async () => {
		using files = new FileService();
		using services = new InstantiationService();
		services.registerInstance(IFileService, files);
		const requests: unknown[] = [];
		const localRoot = URI.file('/workspace');
		const remoteRoot = URI.from({ scheme: Schemas.ashRemote, authority: 'ssh+test', path: '/workspace' });
		using provider = new AgentHostFileSystemProvider({
			api: {
				...createDisconnectedFileApi(unavailable),
				readFile: async params => {
					requests.push(params);
					return { content: params.dirId!, revision: 'r1' };
				},
			},
			resourceApi: createDisconnectedResourceApi(unavailable),
			directories: () => [
				{ uri: localRoot, target: { type: 'environment', dirId: 'local-root' } },
				{ uri: remoteRoot, target: { type: 'environment', dirId: 'remote-root' } },
			],
		});
		using registration = services.createInstance(AgentHostFileSystemService, provider, undefined);
		assert.equal((await files.readFile(localRoot.with({ path: '/workspace/main.ts' }), 'utf8')).content, 'local-root');
		assert.equal((await files.readFile(remoteRoot.with({ path: '/workspace/main.ts' }), 'utf8')).content, 'remote-root');
		assert.deepEqual(requests, [
			{ dirId: 'local-root', path: 'main.ts', encoding: 'utf8' },
			{ dirId: 'remote-root', path: 'main.ts', encoding: 'utf8' },
		]);
		registration.dispose();
		assert.equal(files.hasProvider(localRoot), false);
		assert.equal(files.hasProvider(remoteRoot), false);
		assert.equal((await provider.readTextFile(localRoot, 'utf8')).content, 'local-root');
	});

	test('keeps a supplied browser or native file provider separate from remote storage', async () => {
		using files = new FileService();
		using services = new InstantiationService();
		services.registerInstance(IFileService, files);
		using local = new InMemoryFileSystemProvider();
		const localRoot = URI.file('/');
		const remoteRoot = URI.from({ scheme: Schemas.ashRemote, authority: 'ssh+test', path: '/' });
		using host = new AgentHostFileSystemProvider(connection(remoteRoot, 'remote'));
		await local.createDirectory(localRoot);
		using registration = services.createInstance(AgentHostFileSystemService, host, local);
		await files.writeFile({ resource: localRoot.with({ path: '/main.ts' }), content: 'local' });
		assert.equal((await files.readFile(localRoot.with({ path: '/main.ts' }))).content, 'local');
		assert.equal((await files.readFile(remoteRoot.with({ path: '/main.ts' }), 'utf8')).content, 'remote');
		registration.dispose();
		assert.equal(local.isDisposed, false);
		assert.equal(host.isDisposed, false);
	});

	for (const occupied of [Schemas.file, Schemas.ashRemote]) {
		test(`preserves the existing ${occupied} provider and rolls back a failed mount`, async () => {
			using files = new FileService();
			using services = new InstantiationService();
			services.registerInstance(IFileService, files);
			using existing = new InMemoryFileSystemProvider();
			using incoming = new AgentHostFileSystemProvider(connection(URI.file('/'), 'incoming'));
			const root = URI.from({ scheme: occupied, path: '/' });
			await existing.createDirectory(root);
			await existing.writeFile(root.with({ path: '/original.txt' }), new TextEncoder().encode('original'), {
				create: true,
				overwrite: false,
			});
			using previous = files.registerProvider(occupied, existing);
			assert.throws(() => services.createInstance(AgentHostFileSystemService, incoming, undefined), new RegExp(`already registered: ${occupied}`));
			assert.equal((await files.readFile(root.with({ path: '/original.txt' }))).content, 'original');
			assert.equal(files.hasProvider(URI.from({ scheme: occupied === Schemas.file ? Schemas.ashRemote : Schemas.file, path: '/' })), false);
			assert.equal(incoming.isDisposed, false);
		});
	}

	test('requires the production file service registration', () => {
		using services = new InstantiationService();
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/'), 'base'));
		assert.throws(() => services.createInstance(AgentHostFileSystemService, provider, undefined), /fileService/);
	});

	test('registers independent host scopes and releases only the disconnected scope', async () => {
		using files = new FileService();
		using services = new InstantiationService();
		services.registerInstance(IFileService, files);
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'base'));
		using service = services.createInstance(AgentHostFileSystemService, provider, undefined);
		const firstRoot = URI.from({ scheme: Schemas.ashRemote, authority: 'ssh+first', path: '/workspace' });
		const secondRoot = firstRoot.with({ authority: 'ssh+second' });
		using first = service.registerAuthority(firstRoot.authority, connection(firstRoot, 'first'));
		using second = service.registerAuthority(secondRoot.authority, connection(secondRoot, 'second'));
		assert.equal((await files.readFile(URI.joinPath(firstRoot, 'main.ts'), 'utf8')).content, 'first');
		assert.equal((await files.readFile(URI.joinPath(secondRoot, 'main.ts'), 'utf8')).content, 'second');
		first.dispose();
		await assert.rejects(files.readFile(URI.joinPath(firstRoot, 'main.ts'), 'utf8'));
		assert.equal((await files.readFile(URI.joinPath(secondRoot, 'main.ts'), 'utf8')).content, 'second');
		using replacement = service.registerAuthority(firstRoot.authority, connection(firstRoot, 'replacement'));
		first.dispose();
		assert.equal((await files.readFile(URI.joinPath(firstRoot, 'main.ts'), 'utf8')).content, 'replacement');
	});

	test('window service disposal unregisters every mounted authority without disposing the borrowed platform provider', async () => {
		using files = new FileService();
		using services = new InstantiationService();
		services.registerInstance(IFileService, files);
		using provider = new AgentHostFileSystemProvider(connection(URI.file('/workspace'), 'base'));
		using service = services.createInstance(AgentHostFileSystemService, provider, undefined);
		const root = URI.from({ scheme: Schemas.ashRemote, authority: 'ssh+host', path: '/workspace' });
		using scope = service.registerAuthority(root.authority, connection(root, 'remote'));
		assert.equal((await provider.readTextFile(root, 'utf8')).content, 'remote');
		service.dispose();
		await assert.rejects(provider.readTextFile(root, 'utf8'));
		assert.equal(provider.isDisposed, false);
		assert.equal(files.hasProvider(root), false);
		assert.throws(() => service.registerAuthority(root.authority, connection(root, 'late')), /disposed/);
	});
});
