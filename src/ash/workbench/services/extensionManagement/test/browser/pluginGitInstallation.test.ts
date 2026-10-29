import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind, type IFileService } from '../../../../../platform/files/common/files.js';
import type { ILocalGitService } from '../../../../../platform/git/common/localGitService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IPluginManagementApi } from '../../../../../platform/extensionManagement/common/pluginManagementApi.js';
import { AppServerPluginManagementService } from '../../browser/appServerPluginManagementService.js';
import { ExtensionUiTarget } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';

function fixture() {
	const copies: string[] = [];
	const removed: string[] = [];
	const cancellations: string[] = [];
	let checkout: URI;
	let installation: unknown;
	let cloned: readonly unknown[] | undefined;
	const files = {
		createDirectory: async () => undefined,
		readDirectory: async (resource: URI) => {
			const names = resource.path.endsWith('/.ash-plugin') ? ['plugin.json'] : ['.git', '.ash-plugin', 'README.md'];
			return names.map(name => ({
				name,
				resource: URI.joinPath(resource, name),
				kind: name.startsWith('.') ? FileKind.Directory : FileKind.File,
			}));
		},
		copy: async (source: URI) => {
			copies.push(source.path);
		},
		delete: async (resource: URI) => {
			removed.push(resource.path);
		},
	} as unknown as IFileService;
	const git: ILocalGitService = {
		_serviceBrand: undefined,
		readRepositoryContexts: async () => [],
		clone: async (...args) => {
			cloned = args;
			checkout = URI.file(args[2]);
		},
		cancel: async id => {
			cancellations.push(id);
		},
	};
	const unused = async (): Promise<never> => {
		throw new Error('Unexpected activation or package mutation');
	};
	const api: IPluginManagementApi = {
		list: async () => ({ revision: 7, packages: [], activationGeneration: 1 }),
		installLocal: async params => {
			installation = params;
			assert.ok(copies.some(path => path.endsWith('/.ash-plugin/plugin.json')));
			assert.ok(copies.every(path => !path.includes('/.git/')));
			return {
				id: 'example/plugin',
				version: '1.0.0',
				digest: 'digest',
				command: { revision: 8, activationGeneration: 1, disposition: 'updated' },
			};
		},
		enable: unused,
		disable: unused,
		grant: unused,
		revokeGrant: unused,
		uninstall: unused,
	};
	const service = new AppServerPluginManagementService(api, { subscribe: () => ({ dispose() {} }) }, git, files, new NullLoggerService());
	return {
		service,
		api,
		git,
		files,
		copies,
		removed,
		cancellations,
		get installation() {
			return installation;
		},
		get cloned() {
			return cloned;
		},
		get checkout() {
			return checkout;
		},
	};
}

test('Local plugin lists preserve declared and missing manifest UI targets', async () => {
	const f = fixture();
	using service = f.service;
	const legacy = {
		id: 'example/legacy',
		version: '1.0.0',
		digest: 'digest',
		displayName: 'Legacy',
		permissions: [],
		hasEditorExtensions: true,
		enabled: false,
		granted: false,
		effective: false,
		revoked: false,
	};
	f.api.list = async () => ({
		revision: 7,
		activationGeneration: 1,
		packages: [legacy, { ...legacy, id: 'example/agents', uiTargets: ['agents'] }, { ...legacy, id: 'example/shared', uiTargets: ['ide', 'agents'] }],
	});
	const catalog = await service.list();
	assert.deepEqual(catalog.packages[0], legacy);
	assert.deepEqual(catalog.packages[1]?.uiTargets, [ExtensionUiTarget.Agents]);
	assert.deepEqual(catalog.packages[2]?.uiTargets, [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
});

test('Git plugin installation excludes metadata and installs into the captured directory without enabling it', async () => {
	const f = fixture();
	using service = f.service;
	const folder = { id: 'captured-folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 };
	assert.deepEqual(await service.installFromGit(folder, 'https://example.test/plugin.git', 'release', '.', new AbortController().signal), {
		id: 'example/plugin',
		version: '1.0.0',
		digest: 'digest',
	});
	assert.equal(f.cloned?.[1], 'https://example.test/plugin.git');
	assert.equal(f.cloned?.[3], 'release');
	assert.equal((f.installation as { dirId: string }).dirId, 'captured-folder');
	assert.equal((f.installation as { expectedRevision: number }).expectedRevision, 7);
	assert.equal(f.copies.length, 2);
	assert.equal(f.removed.length, 2);
	assert.ok(f.removed.includes(f.checkout.path));
});

test('Git plugin cancellation reaches the host and never starts package installation', async () => {
	const f = fixture();
	using service = f.service;
	const controller = new AbortController();
	let finish: (() => void) | undefined;
	f.git.clone = async () => {
		await new Promise<void>(resolve => {
			finish = resolve;
		});
	};
	const pending = service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'https://example.test/plugin.git', undefined, '.', controller.signal);
	controller.abort();
	finish!();
	await assert.rejects(pending, { name: 'CancellationError' });
	assert.equal(f.cancellations.length, 1);
	assert.equal(f.installation, undefined);
	assert.equal(f.copies.length, 0);
});

test('Git plugin package paths reject traversal and metadata before cloning', async () => {
	const f = fixture();
	using service = f.service;
	for (const path of ['../outside', '/absolute', '.git', 'package/.git', 'a\\b']) {
		await assert.rejects(service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'url', undefined, path, new AbortController().signal));
	}
	assert.equal(f.cloned, undefined);
});

test('Closing the App installation service cancels its running Git operation', async () => {
	const f = fixture();
	let finish: (() => void) | undefined;
	f.git.clone = async () => {
		await new Promise<void>(resolve => {
			finish = resolve;
		});
	};
	const pending = f.service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'url', undefined, '.', new AbortController().signal);
	f.service.dispose();
	finish!();
	await assert.rejects(pending, { name: 'CancellationError' });
	assert.equal(f.cancellations.length, 1);
	assert.equal(f.installation, undefined);
});

test('Git plugin staging rejects symbolic links before package installation', async () => {
	const f = fixture();
	using service = f.service;
	f.files.readDirectory = async resource => [{ name: 'outside', resource: URI.joinPath(resource, 'outside'), kind: FileKind.SymbolicLink }];
	await assert.rejects(service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'url', undefined, '.', new AbortController().signal));
	assert.equal(f.installation, undefined);
	assert.equal(f.copies.length, 0);
	assert.equal(f.removed.length, 1);
});

test('Git plugin installation resolves a package subdirectory inside the captured checkout', async () => {
	const f = fixture();
	using service = f.service;
	const inspected: string[] = [];
	f.files.stat = async resource => {
		inspected.push(resource.path);
		return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
	};
	await service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'url', undefined, 'packages/example', new AbortController().signal);
	assert.deepEqual(inspected, [URI.joinPath(f.checkout, 'packages').path, URI.joinPath(f.checkout, 'packages/example').path]);
	assert.ok(f.copies.every(path => path.startsWith(URI.joinPath(f.checkout, 'packages/example').path + '/')));
});

test('A symlink package directory cannot redirect Git installation to another workspace path', async () => {
	const f = fixture();
	using service = f.service;
	f.files.stat = async resource => ({
		resource,
		kind: FileKind.SymbolicLink,
		sizeBytes: 0,
		readonly: false,
		modifiedAtMillis: undefined,
	});
	await assert.rejects(service.installFromGit({ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }, 'url', undefined, 'other', new AbortController().signal));
	assert.equal(f.installation, undefined);
	assert.equal(f.copies.length, 0);
});
