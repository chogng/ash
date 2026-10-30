import { createSshRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import { getWorkspaceRemoteAuthority, serializeWorkspaceIdentifier, parseWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, parse } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { WorkspaceContextMainService } from '../../../window/electron-main/window.js';
import { validateWorkspaceEdit } from '../../../workspace/common/workspaceIpc.js';
import { WorkspaceEditingMainService, WorkspacesManagementMainService } from '../../electron-main/workspacesManagementMainService.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../../node/workspaces.js';
import { parseWorkspace, serializeWorkspace } from '../../../workspace/common/workspace.js';

ensureNoDisposablesAreLeakedInTestSuite();

async function fixture(runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-workspace-edit-')));
	const first = join(root, 'first');
	const second = join(root, 'second');
	await Promise.all([mkdir(first), mkdir(second)]);
	const manager = new WorkspacesManagementMainService();
	const context = new WorkspaceContextMainService(getSingleFolderWorkspaceIdentifier(URI.file(first)));
	const requests: { id: string; path: string; }[][] = [];
	const errors: unknown[] = [];
	let rejection: Error | undefined;
	let validate: (() => Promise<void>) | undefined;
	const editing = new WorkspaceEditingMainService(context, manager, join(root, 'untitled'), {
		resolveGrant: async () => ({ type: 'config' }), persistDirectoryGrant: async () => { },
		validateFolders: async () => { await validate?.(); },
		setFolders: async folders => { if (rejection) throw rejection; requests.push(folders.map(({ id, path }) => ({ id, path }))); },
	}, error => errors.push(error), runExclusive);
	return {
		root, first, second, context, editing, manager, requests, errors,
		reject: (error: Error | undefined) => { rejection = error; },
		beforeValidate: (callback: () => Promise<void>) => { validate = callback; },
		async [Symbol.asyncDispose]() { editing.dispose(); context.dispose(); await rm(root, { recursive: true, force: true }); },
	};
}

test('adding and removing roots publishes one persisted workspace after backend acceptance', async () => {
	await using f = await fixture();
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(f.second).toString(), name: 'API' }] });
	const workspace = f.context.getResolvedWorkspace();
	assert.deepEqual(workspace.folders.map(folder => folder.name), ['first', 'API']);
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.requests[0]!.map(folder => folder.id), workspace.folders.map(folder => folder.id));
	const source = parseJsonc(await readFile(workspace.configuration!.fsPath, 'utf8')) as { folders: unknown[]; };
	assert.equal(source.folders.length, 2);
	const changes: number[] = [];
	using listener = f.context.onDidChangeWorkspace(event => changes.push(event.resolvedWorkspace.folders.length));
	await f.editing.edit({ operation: 'folders', index: 0, deleteCount: 2, folders: [] });
	assert.equal(f.context.getWorkspace().id, workspace.id);
	assert.deepEqual(changes, [0]);
	assert.deepEqual(f.requests.at(-1), []);
});

test('empty edits and duplicate roots preserve the single-folder workspace identity', async () => {
	await using f = await fixture();
	const previous = f.context.getResolvedWorkspace();
	const changes: unknown[] = [];
	using listener = f.context.onDidChangeWorkspace(event => changes.push(event));
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [] });
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(f.first).toString() }] });
	assert.equal(f.context.getResolvedWorkspace(), previous);
	assert.deepEqual(changes, []);
	assert.deepEqual(f.requests, []);
});

test('unchanged folder edits preserve workspace metadata bytes', async () => {
	await using f = await fixture();
	const config = join(f.root, 'team.code-workspace');
	const source = '{\n "folders": [\n  // Keep root metadata\n  {"path":"first"}\n ],\n "settings":{"editor.tabSize":3}\n}\n';
	await writeFile(config, source);
	const identifier = getWorkspaceIdentifier(URI.file(config));
	f.context.updateWorkspace(identifier, await f.manager.resolveWorkspace(identifier));
	await f.editing.edit({ operation: 'folders', index: 0, deleteCount: 1, folders: [{ uri: URI.file(f.first).toString() }] });
	assert.equal(await readFile(config, 'utf8'), source);
	assert.deepEqual(f.requests, []);
});

test('filesystem roots retain a nonempty folder label through editing, IPC and reopening', async () => {
	await using f = await fixture();
	const root = parse(f.root).root;
	const config = URI.file(join(f.root, 'root.code-workspace'));
	await writeFile(config.fsPath, JSON.stringify({ folders: [{ path: root }] }));
	const resolved = await f.manager.resolveWorkspace(getWorkspaceIdentifier(config));
	assert.equal(resolved.folders[0]?.name, root);
	assert.deepEqual(parseWorkspace(serializeWorkspace(resolved)), resolved);
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(root).toString() }] });
	const workspace = f.context.getResolvedWorkspace();
	// Added-root labels use URI spelling; filesystem resolution above retains native spelling.
	assert.equal(workspace.folders[1]?.name, URI.file(root).fsPath);
	assert.deepEqual(parseWorkspace(serializeWorkspace(workspace)), workspace);
	assert.deepEqual(await f.manager.resolveWorkspace(getWorkspaceIdentifier(workspace.configuration!)), workspace);
});

test('saving elsewhere rebases roots while retaining JSONC, settings and extension metadata', async () => {
	await using f = await fixture();
	const original = join(f.root, 'team.code-workspace');
	await writeFile(original, '{\n // Keep this comment\n "folders": [{"path":"first","name":"Client"}],\n "settings":{"editor.tabSize":3},"extensions":{"recommendations":["team.tool"]}\n}\n');
	f.context.updateWorkspace(getWorkspaceIdentifier(URI.file(original)), await f.manager.resolveWorkspace(getWorkspaceIdentifier(URI.file(original))));
	const target = join(f.root, 'saved', 'team.ash-workspace');
	await f.editing.edit({ operation: 'save', path: target });
	const saved = await readFile(target, 'utf8');
	assert.ok(saved.includes('// Keep this comment'));
	const parsed = parseJsonc(saved) as { folders: { path: string; name: string; }[]; settings: unknown; extensions: unknown; };
	assert.deepEqual(parsed.folders, [{ path: '../first', name: 'Client' }]);
	assert.deepEqual(parsed.settings, { 'editor.tabSize': 3 });
	assert.deepEqual(parsed.extensions, { recommendations: ['team.tool'] });
	assert.equal(f.requests.length, 0, 'saving metadata does not replace live backend services');
});

test('real filesystem aliases deduplicate Unicode roots and survive saving to a spaced path', async () => {
	await using f = await fixture();
	const folder = join(f.root, '服务 API #🦀');
	const alias = join(f.root, '入口');
	await mkdir(folder);
	await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
	const original = join(f.root, '团队.code-workspace');
	await writeFile(original, JSON.stringify({ folders: [{ path: '入口', name: 'API' }, { path: '服务 API #🦀', name: 'Duplicate' }, { uri: URI.file(f.second).toString() }] }));
	const resolved = await f.manager.resolveWorkspace(getWorkspaceIdentifier(URI.file(original)));
	assert.deepEqual(resolved.folders.map(root => [root.uri.fsPath, root.name]), [[URI.file(await realpath(folder)).fsPath, 'API'], [URI.file(f.second).fsPath, 'second']]);
	f.context.updateWorkspace(getWorkspaceIdentifier(URI.file(original)), resolved);
	const target = join(f.root, 'saved workspace', '团队.code-workspace');
	await f.editing.edit({ operation: 'save', path: target });
	const reopened = await f.manager.resolveWorkspace(getWorkspaceIdentifier(URI.file(target)));
	assert.deepEqual(reopened.folders, resolved.folders);
	assert.equal(f.requests.length, 0, 'saving aliases must retain the canonical execution identities');
});

test('a rejected directory update leaves both metadata and the window unchanged', async () => {
	await using f = await fixture();
	await f.editing.edit({ operation: 'save', path: join(f.root, 'team.ash-workspace') });
	const previous = f.context.getResolvedWorkspace();
	const source = await readFile(previous.configuration!.fsPath, 'utf8');
	f.reject(new Error('EnvironmentBusy'));
	await assert.rejects(f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(f.second).toString() }] }), /EnvironmentBusy/);
	assert.equal(f.context.getResolvedWorkspace(), previous);
	assert.equal(await readFile(previous.configuration!.fsPath, 'utf8'), source);
});

test('external atomic replacements synchronize folders and recover after invalid JSONC', async () => {
	await using f = await fixture();
	await f.editing.edit({ operation: 'save', path: join(f.root, 'team.ash-workspace') });
	const config = f.context.getResolvedWorkspace().configuration!.fsPath;
	const changed = new DeferredPromise<void>();
	using listener = f.context.onDidChangeWorkspace(event => {
		if (event.resolvedWorkspace.folders[0]?.name === 'Renamed') void changed.complete();
	});
	await writeFile(config, '{invalid');
	await new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error('Invalid edit was not observed')), 5000);
		const poll = setInterval(() => { if (f.errors.length) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10);
	});
	assert.equal(f.context.getResolvedWorkspace().folders[0]?.uri.fsPath, URI.file(f.first).fsPath);
	const replacement = join(dirname(config), 'replacement.tmp');
	await writeFile(replacement, JSON.stringify({ folders: [{ path: 'second', name: 'Renamed' }] }));
	await rename(replacement, config);
	await changed.p;
	assert.equal(f.context.getResolvedWorkspace().folders[0]?.uri.fsPath, URI.file(f.second).fsPath);
	assert.equal(f.requests.at(-1)?.[0]?.path, URI.file(f.second).fsPath);
});

test('workspace edit IPC validates operation bounds and closed request fields', () => {
	for (const request of [null, { operation: 'save', path: '' }, { operation: 'save', path: '/work/team.ash-workspace', extra: true }, { operation: 'folders', index: -1, deleteCount: 0, folders: [] }, { operation: 'folders', index: 0, deleteCount: 0, folders: [{ uri: '/work', permissions: ['all'] }] }]) {
		assert.throws(() => validateWorkspaceEdit(request));
	}
});

test('workspace metadata access is limited to the current file and preserves revision conflicts', async () => {
	await using f = await fixture();
	const path = join(f.root, 'team.ash-workspace');
	await f.editing.edit({ operation: 'save', path });
	const uri = URI.file(path).toString();
	const original = await f.editing.configuration({ operation: 'read', uri }) as { revision: string; content: string; };
	assert.ok(original.content.includes('folders'));
	const sibling = URI.file(join(f.root, 'private.txt')).toString();
	await writeFile(URI.parse(sibling).fsPath, 'private content');
	assert.deepEqual(await f.editing.configuration({ operation: 'read', uri: sibling }), { error: 'notCurrent' });
	await assert.rejects(f.editing.configuration({ operation: 'write', uri: sibling, content: 'overwritten', options: { create: false, overwrite: true } }), /Only the current workspace configuration/);
	assert.equal(await readFile(URI.parse(sibling).fsPath, 'utf8'), 'private content');
	const external = '{"folders":[],"settings":{"external":true}}';
	await writeFile(path, external);
	assert.deepEqual(await f.editing.configuration({ operation: 'write', uri, content: '{}', options: { create: false, overwrite: true, expectedRevision: original.revision } }), { error: 'revisionConflict' });
	assert.equal(await readFile(path, 'utf8'), external);
});

test('renderer startup can read workspace configuration while window replacement holds queued writes', async () => {
	let finishOpening!: () => void;
	const opening = new Promise<void>(resolve => { finishOpening = resolve; });
	await using f = await fixture(async operation => { await opening; return operation(); });
	const config = URI.file(join(f.root, 'team.ash-workspace'));
	const source = JSON.stringify({ folders: [{ path: 'first' }] });
	const updated = JSON.stringify({ folders: [{ path: 'first' }], settings: { 'editor.tabSize': 3 } });
	await writeFile(config.fsPath, source);
	const identifier = getWorkspaceIdentifier(config);
	f.context.updateWorkspace(identifier, await f.manager.resolveWorkspace(identifier));
	const write = f.editing.configuration({ operation: 'write', uri: config.toString(), content: updated, options: { create: false, overwrite: true } });
	const read = f.editing.configuration({ operation: 'read', uri: config.toString() });
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			read,
			new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Renderer startup configuration read waited for window readiness')), 5000); }),
		]) as { content: string; };
		assert.equal(result.content, source);
		assert.equal(await readFile(config.fsPath, 'utf8'), source, 'metadata writes still wait for the window transition');
	} finally {
		clearTimeout(deadline);
		finishOpening();
		await Promise.all([read, write]);
	}
	assert.equal(await readFile(config.fsPath, 'utf8'), updated);
});

test('metadata conflicts leave live backend directories untouched', async () => {
	await using f = await fixture();
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(f.second).toString() }] });
	const previous = f.context.getResolvedWorkspace();
	const external = JSON.stringify({ folders: [{ path: f.first }, { path: f.second }], settings: { external: true } });
	f.beforeValidate(async () => { await writeFile(previous.configuration!.fsPath, external); });
	const calls = f.requests.length;
	await assert.rejects(f.editing.edit({ operation: 'folders', index: 1, deleteCount: 1, folders: [] }), /revision/i);
	assert.equal(f.requests.length, calls, 'a failed metadata write must not retire a PTY or directory');
	assert.equal(f.context.getResolvedWorkspace(), previous);
	assert.equal(await readFile(previous.configuration!.fsPath, 'utf8'), external);
});

test('external removal is vetoed before changing the backend when dirty files remain', async () => {
	await using f = await fixture();
	await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: URI.file(f.second).toString() }] });
	const previous = f.context.getResolvedWorkspace();
	f.beforeValidate(async () => { throw new Error('dirty folder'); });
	const calls = f.requests.length;
	await writeFile(previous.configuration!.fsPath, JSON.stringify({ folders: [{ path: f.first }] }));
	const deadline = Date.now() + 5000;
	while (!f.errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.match(String(f.errors[0]), /dirty folder/);
	assert.equal(f.requests.length, calls);
	assert.equal(f.context.getResolvedWorkspace(), previous);
});


for (const [platform, paths] of [
	['POSIX', ['/remote-only/client', '/remote-only/server']],
	['Windows drives', ['C:/remote-only/client', 'D:/remote-only/server']],
	['Windows UNC', ['//server/share/client', '//server/share/server']],
] as const) {
	test(`${platform} Remote root edits preserve one authority and persist URI entries without reading remote paths in Main`, async () => {
		await using f = await fixture();
		const first = createSshRemoteWorkspaceUri('test-host', paths[0]);
		const second = createSshRemoteWorkspaceUri('test-host', paths[1]);
		f.context.updateWorkspace(getSingleFolderWorkspaceIdentifier(first));
		await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: second.toString(), name: 'Server' }] });
		const current = f.context.getResolvedWorkspace();
		assert.equal(getWorkspaceRemoteAuthority(current), 'ssh+test-host');
		assert.deepEqual(f.requests.at(-1)!.map(folder => folder.path), [...paths]);
		const stored = parseJsonc(await readFile(current.configuration!.fsPath, 'utf8')) as { folders: { uri: string; }[]; remoteAuthority: string; };
		assert.deepEqual(stored.folders.map(folder => folder.uri), [first.toString(), second.toString()]);
		assert.equal(stored.remoteAuthority, 'ssh+test-host');
		const target = join(f.root, 'saved.ash-workspace');
		await f.editing.edit({ operation: 'save', path: target });
		const reopened = await f.manager.resolveWorkspace(getWorkspaceIdentifier(URI.file(target)));
		assert.deepEqual(reopened.folders.map(folder => folder.uri.toString()), [first.toString(), second.toString()]);
		assert.equal(getWorkspaceRemoteAuthority(reopened), 'ssh+test-host');
		await f.editing.edit({ operation: 'folders', index: 0, deleteCount: 2, folders: [] });
		assert.equal(getWorkspaceRemoteAuthority(f.context.getResolvedWorkspace()), 'ssh+test-host');
		assert.equal(getWorkspaceRemoteAuthority(parseWorkspaceIdentifier(serializeWorkspaceIdentifier(f.context.getWorkspace()))), 'ssh+test-host');
	});

	test(`${platform} Remote root edits reject local and foreign authorities and roll back a backend rejection`, async () => {
		await using f = await fixture();
		const first = createSshRemoteWorkspaceUri('test-host', paths[0]);
		const second = createSshRemoteWorkspaceUri('test-host', paths[1]);
		f.context.updateWorkspace(getSingleFolderWorkspaceIdentifier(first));
		await f.editing.edit({ operation: 'folders', index: 1, deleteCount: 0, folders: [{ uri: second.toString() }] });
		const current = f.context.getResolvedWorkspace();
		const original = await readFile(current.configuration!.fsPath, 'utf8');
		for (const uri of [URI.file(f.first), createSshRemoteWorkspaceUri('other-host', paths[1])]) {
			await assert.rejects(f.editing.edit({ operation: 'folders', index: 2, deleteCount: 0, folders: [{ uri: uri.toString() }] }), /remote host/);
		}
		f.reject(new Error('Remote backend rejected folder update'));
		await assert.rejects(f.editing.edit({ operation: 'folders', index: 0, deleteCount: 1, folders: [] }), /Remote backend rejected/);
		assert.equal(f.context.getResolvedWorkspace(), current);
		assert.equal(await readFile(current.configuration!.fsPath, 'utf8'), original);
	});
}


test('Desktop metadata resolution rejects browser profile URIs before filesystem access', async () => {
	const manager = new WorkspacesManagementMainService({ resolvePath: async () => { throw new Error('Unexpected local path access'); }, readFile: async () => { throw new Error('Unexpected local file read'); } });
	await assert.rejects(manager.resolveWorkspace({ id: 'browser', configPath: URI.from({ scheme: 'ash-userdata', path: '/workspaces/temporary/workspace.ash-workspace' }) }), /local file/);
});
