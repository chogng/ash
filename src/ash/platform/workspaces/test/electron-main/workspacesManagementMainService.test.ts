import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { WorkspaceContextMainService } from '../../../window/electron-main/window.js';
import { validateWorkspaceEdit } from '../../../workspace/common/workspaceIpc.js';
import { WorkspaceEditingMainService, WorkspacesManagementMainService } from '../../electron-main/workspacesManagementMainService.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../../node/workspaces.js';

ensureNoDisposablesAreLeakedInTestSuite();

async function fixture() {
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
	}, error => errors.push(error));
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
	assert.deepEqual(resolved.folders.map(root => [root.uri.fsPath, root.name]), [[await realpath(folder), 'API'], [f.second, 'second']]);
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
	const changed = new Promise<void>(resolve => {
		const listener = f.context.onDidChangeWorkspace(event => {
			if (event.resolvedWorkspace.folders[0]?.name === 'Renamed') { listener.dispose(); resolve(); }
		});
	});
	await writeFile(config, '{invalid');
	await new Promise<void>((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error('Invalid edit was not observed')), 5000);
		const poll = setInterval(() => { if (f.errors.length) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 10);
	});
	assert.equal(f.context.getResolvedWorkspace().folders[0]?.uri.fsPath, f.first);
	const replacement = join(dirname(config), 'replacement.tmp');
	await writeFile(replacement, JSON.stringify({ folders: [{ path: 'second', name: 'Renamed' }] }));
	await rename(replacement, config);
	await changed;
	assert.equal(f.context.getResolvedWorkspace().folders[0]?.uri.fsPath, f.second);
	assert.equal(f.requests.at(-1)?.[0]?.path, f.second);
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
	await assert.rejects(f.editing.configuration({ operation: 'read', uri: URI.file(join(f.root, 'private.txt')).toString() }), /Only the current workspace configuration/);
	const external = '{"folders":[],"settings":{"external":true}}';
	await writeFile(path, external);
	assert.deepEqual(await f.editing.configuration({ operation: 'write', uri, content: '{}', options: { create: false, overwrite: true, expectedRevision: original.revision } }), { error: 'revisionConflict' });
	assert.equal(await readFile(path, 'utf8'), external);
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
