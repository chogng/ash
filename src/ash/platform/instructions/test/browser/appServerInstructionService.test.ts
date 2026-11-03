import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { createAppServerInstructionService, createDisconnectedInstructionService } from '../../browser/appServerInstructionService.js';

function connectionFixture() {
	const calls: { method: string; params: unknown; }[] = [];
	const item = { source: '.github/copilot-instructions.md', target: 'ASH.md', content: 'Follow the reviewed rules.', status: 'ready', message: null };
	let generation = 1;
	let pending: Promise<unknown> | undefined;
	const connection = {
		get generation() { return generation; },
		request: async (method: { method: string; }, params: unknown) => {
			calls.push({ method: method.method, params });
			if (pending) return pending;
			if (method.method === 'instructions/list') return { instructions: [{ path: '/project/.ash/instructions/style.md', name: 'style', scope: 'directory', description: null }] };
			if (method.method === 'session/read') return { session: { executionTarget: { type: 'local', root: '/primary-project' } } };
			if (method.method === 'session/dirs/list') return { revision: 7, dirs: [{ path: '/project', permissions: ['readFiles', 'browseFiles'] }, { path: '/hidden', permissions: ['readFiles'] }] };
			if (method.method === 'instructions/importPreview') return { targetDirectory: '/project', digest: 'reviewed-digest', items: [item], diagnostics: [] };
			return { items: [{ ...item, status: 'imported' }] };
		},
	} as unknown as AppServerProtocolClient;
	return { connection, calls, reconnect: () => generation++, wait: (promise: Promise<unknown>) => { pending = promise; } };
}

test('Instruction imports use the captured Session, exact selected source paths and reviewed digest', async () => {
	const fixture = connectionFixture();
	const instructions = createAppServerInstructionService(fixture.connection, 'review-host');
	const imports = instructions.captureImports!('backend-session');
	const directories = await imports.directories();
	assert.deepEqual(directories.map(directory => [directory.resource.toString(), directory.needsAccess]), [['ash-remote://ssh+review-host/project', true], ['ash-remote://ssh+review-host/hidden', true], ['ash-remote://ssh+review-host/primary-project', true]]);
	const selection = { directory: '/project', source: 'copilot' as const, sources: ['.github/copilot-instructions.md'] };
	const preview = await imports.preview(selection);
	assert.equal(preview.targetDirectory.toString(), 'ash-remote://ssh+review-host/project');
	assert.equal(preview.items[0].message, undefined);
	assert.equal((await imports.apply(selection, preview.digest))[0].status, 'imported');
	assert.deepEqual(fixture.calls.map(call => call.params), [
		{ sessionId: 'backend-session' },
		{ sessionId: 'backend-session' },
		{ scope: 'directory', source: 'copilot', directory: { sessionId: 'backend-session', path: '/project' }, sources: ['.github/copilot-instructions.md'] },
		{ scope: 'directory', source: 'copilot', directory: { sessionId: 'backend-session', path: '/project' }, sources: ['.github/copilot-instructions.md'], digest: 'reviewed-digest' },
	]);
	const [instruction] = await instructions.list('backend-session');
	assert.equal(instruction.resource?.toString(), 'ash-remote://ssh+review-host/project/.ash/instructions/style.md');
});

test('A captured import cannot publish after reconnect and discards old-host preview replies', async () => {
	const fixture = connectionFixture();
	const imports = createAppServerInstructionService(fixture.connection).captureImports!('first');
	const selection = { directory: '/project', source: 'claude' as const, sources: [] };
	const pending = new DeferredPromise<unknown>();
	fixture.wait(pending.p);
	const preview = imports.preview(selection);
	fixture.reconnect();
	await pending.complete({ targetDirectory: '/project', digest: 'old', items: [], diagnostics: [] });
	await assert.rejects(preview, isCancellationError);
	await assert.rejects(imports.apply(selection, 'old'), isCancellationError);
	assert.equal(fixture.calls.length, 1);
});

test('Disconnected hosts do not offer Instruction import', () => {
	assert.equal(createDisconnectedInstructionService(() => { throw new Error('disconnected'); }).captureImports, undefined);
});


test('Explicit import access unions only read, browse and write with the current Session grant', async () => {
	const fixture = connectionFixture();
	await createAppServerInstructionService(fixture.connection).captureImports!('captured').grantAccess('/project');
	assert.deepEqual(fixture.calls, [
		{ method: 'session/dirs/list', params: { sessionId: 'captured' } },
		{ method: 'session/directoryGrants/set', params: { sessionId: 'captured', path: '/project', expectedRevision: 7, permissions: ['readFiles', 'browseFiles', 'writeFiles'] } },
	]);
});


test('An explicitly approved new import directory receives only the requested three Session capabilities', async () => {
	const fixture = connectionFixture();
	await createAppServerInstructionService(fixture.connection).captureImports!('captured').grantAccess('/new-root');
	assert.deepEqual(fixture.calls.at(-1), { method: 'session/dirs/add', params: { sessionId: 'captured', path: '/new-root', permissions: ['readFiles', 'browseFiles', 'writeFiles'] } });
});

test('user Instructions preserve explicit scope on preview and publication', async () => {
	const fixture = connectionFixture();
	const imports = createAppServerInstructionService(fixture.connection).captureImports!('session');
	const selection = { scope: 'user' as const, directory: '/external-home', source: 'claude' as const, sources: ['.claude/CLAUDE.md'] };
	const preview = await imports.preview(selection);
	await imports.apply(selection, preview.digest);
	assert.deepEqual(fixture.calls, [
		{ method: 'instructions/importPreview', params: { scope: 'user', source: 'claude', directory: { sessionId: 'session', path: '/external-home' }, sources: ['.claude/CLAUDE.md'] } },
		{ method: 'instructions/import', params: { scope: 'user', source: 'claude', directory: { sessionId: 'session', path: '/external-home' }, sources: ['.claude/CLAUDE.md'], digest: 'reviewed-digest' } },
	]);
});
