import { decodeAppServerServerResponse } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { createAppServerAppServerApi } from '../../browser/appServerApi.js';
import { URI } from '../../../../base/common/uri.js';
import { createTestInitializeResult } from '../common/testAppServerProtocol.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { CancellationError, isCancellationError } from "../../../../base/common/errors.js";
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from "../../../../base/common/types.js";
import { AppServerRemoteError } from "../../common/appServerError.js";
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH, type InitializeResult, type ServerNotification } from "../../../../../../.build/protocol/typescript/index.js";
import { connectWebRendererApi } from "../../browser/webRendererApi.js";
import { WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from "../../common/appServerTransport.js";
import { AppServerProtocolClient } from "../../browser/appServerProtocolClient.js";
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { GitHubError, GitHubErrorCode, GitHubIssueState, GitHubMergeMethod } from '../../../github/common/githubService.js';
import type { BrowserCreateParams } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerSkillOperations } from '../../browser/appServerApi.js';
import { createHash } from 'node:crypto';

const pinnedSkill = { id: { source: 'user:skill-source:test', name: 'review' }, version: { type: 'pinnedDigest' as const, digest: `sha256:${'a'.repeat(64)}` } };

test('Skill body reading opens exact authorized bytes lazily and releases the connection handle', async () => {
	const transport = new SkillResourceTransport(Buffer.from('# Review\n审阅 changes\n'));
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const body = await createAppServerSkillOperations(client).readInstructions(pinnedSkill, new AbortController().signal, 'skill-session');
	assert.equal(body, '# Review\n审阅 changes\n');
	assert.deepEqual(transport.requests.filter(request => request.method === 'skill/resource/open' || request.method === 'resource/read' || request.method === 'resource/release').map(request => [request.method, request.params]), [
		['skill/resource/open', { sessionId: 'skill-session', skillId: pinnedSkill.id, skillContentDigest: pinnedSkill.version.digest, path: 'SKILL.md' }],
		['resource/read', { resourceId: 'resource_0000000000000001', offset: 0, maxBytes: Buffer.byteLength(body) }],
		['resource/release', { resourceId: 'resource_0000000000000001' }],
	]);
});

test('Cancellation while opening a Skill releases its late handle without requesting chunks', async () => {
	const transport = new SkillResourceTransport(Buffer.from('instructions'));
	const controller = new AbortController();
	transport.onOpen = () => controller.abort();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	await assert.rejects(createAppServerSkillOperations(client).readInstructions(pinnedSkill, controller.signal), isCancellationError);
	assert.deepEqual(transport.requests.filter(request => String(request.method).startsWith('resource/')).map(request => request.method), ['resource/release']);
});

test('Skill snapshots reject invalid UTF-8 after releasing the resource', async () => {
	const transport = new SkillResourceTransport(Buffer.from([0xff]));
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	await assert.rejects(createAppServerSkillOperations(client).readInstructions(pinnedSkill, new AbortController().signal), TypeError);
	assert.equal(transport.requests.at(-1)?.method, 'resource/release');
});

test('Skill snapshots reject oversized instructions before reading chunks and release the handle', async () => {
	const transport = new SkillResourceTransport(Buffer.alloc(262_145));
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	await assert.rejects(createAppServerSkillOperations(client).readInstructions(pinnedSkill, new AbortController().signal), /size/u);
	assert.deepEqual(transport.requests.filter(request => String(request.method).startsWith('resource/')).map(request => request.method), ['resource/release']);
});

test('A replaced connection never receives a Skill resource read or release from the retired connection', async () => {
	const transport = new SkillResourceTransport(Buffer.from('instructions'));
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	let reconnecting: ReturnType<AppServerProtocolClient['connect']> | undefined;
	transport.onRead = () => { client.disconnect(); reconnecting = client.connect(); };
	await assert.rejects(createAppServerSkillOperations(client).readInstructions(pinnedSkill, new AbortController().signal), /replaced/u);
	await reconnecting;
	assert.equal(client.state, 'ready');
	assert.equal(transport.requests.filter(request => request.method === 'resource/release').length, 0);
});

test('Skill catalog and enablement share Session scope and invalidate across config changes and reconnects', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const skills = createAppServerSkillOperations(client);
	let changes = 0;
	const subscription = skills.onDidChangeSkills(() => changes++);
	await client.connect();
	assert.equal(changes, 1);
	const listing = skills.list('cached', 'skill-session');
	assert.deepEqual(transport.requests.at(-1)?.params, { reload: 'cached', sessionId: 'skill-session' });
	assert.equal(transport.requests.at(-1)?.method, 'skills/list');
	transport.respondAt(-1, { generation: 4, skills: [], diagnostics: [] });
	assert.deepEqual(await listing, { generation: 4, skills: [] });
	const skillId = { source: 'directory:skill-source:test', name: 'review' };
	const mutation = skills.setEnabled(skillId, false, 7, 'skill-session');
	const params = transport.requests.at(-1)?.params;
	assert.ok(isRecord(params));
	assert.equal(transport.requests.at(-1)?.method, 'skill/enablement/set');
	assert.deepEqual(params, { commandId: params.commandId, expectedRevision: 7, skillId, enablement: 'disabled', sessionId: 'skill-session' });
	transport.respondAt(-1, { revision: 8, generation: 8, disposition: 'updated' });
	await mutation;
	transport.emitNotification({ method: 'config/changed', params: { revision: 8, generation: 8 } });
	transport.emitNotification({ method: 'skills/changed', params: { generation: 5 } });
	assert.equal(changes, 3);
	client.disconnect();
	await client.connect();
	assert.equal(changes, 4);
	subscription.dispose();
	transport.emitNotification({ method: 'skills/changed', params: { generation: 6 } });
	assert.equal(changes, 4);
});

test('Skill adapter exposes immutable domain metadata for enabled, disabled and incompatible Skills', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const skills = createAppServerSkillOperations(client);
	await client.connect();
	const listing = skills.list('cached', 'skill-session');
	const id = { source: 'user:skill-source:test', name: 'review' };
	const contentDigest = `sha256:${'a'.repeat(64)}`;
	const entry = { id, description: 'Review changes', sourceKind: 'user', contentDigest, enablement: 'enabled', compatibility: { type: 'compatible' } };
	transport.respondAt(-1, {
		generation: 4,
		skills: [entry, { ...entry, id: { ...id, name: 'disabled' }, enablement: 'disabled' }, { ...entry, id: { ...id, name: 'unknown' }, compatibility: { type: 'unknown', note: 'Requires a newer runtime' } }],
		diagnostics: [],
	});
	const catalog = await listing;
	const descriptor = { id, description: entry.description, contentDigest, enabled: true, compatible: true };
	assert.deepEqual(catalog, {
		generation: 4,
		skills: [descriptor, { ...descriptor, id: { ...id, name: 'disabled' }, enabled: false }, { ...descriptor, id: { ...id, name: 'unknown' }, compatible: false }],
	});
	assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.skills));
	assert.ok(catalog.skills.every(skill => Object.isFrozen(skill) && Object.isFrozen(skill.id)));
});

test('Skill adapter rejects oversized metadata and keeps the connection usable for a subsequent catalog', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const skills = createAppServerSkillOperations(client);
	await client.connect();
	const listing = skills.list('cached');
	transport.respondAt(-1, {
		generation: 4,
		skills: [{ id: { source: 'user:skill-source:test', name: 'review' }, description: 'a'.repeat(1025), sourceKind: 'user', contentDigest: `sha256:${'a'.repeat(64)}`, enablement: 'enabled', compatibility: { type: 'compatible' } }],
		diagnostics: [],
	});
	await assert.rejects(listing, { name: 'TypeError', message: 'Skill description is invalid' });
	assert.equal(client.state, 'ready');
	const refreshed = skills.list('refresh');
	transport.respondAt(-1, { generation: 5, skills: [], diagnostics: [] });
	assert.deepEqual(await refreshed, { generation: 5, skills: [] });
});

test('Malformed Skill wire responses fail the connection before a frontend catalog is published', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const skills = createAppServerSkillOperations(client);
	await client.connect();
	const listing = skills.list('cached');
	transport.respondAt(-1, {
		generation: 4,
		skills: [{ id: { source: 'user:skill-source:test', name: 'review' }, description: 'Review changes', sourceKind: 'user', contentDigest: `sha256:${'a'.repeat(64)}`, enablement: 'invalid', compatibility: { type: 'compatible' } }],
		diagnostics: [],
	});
	await assert.rejects(listing);
	assert.equal(client.state, 'crashed');
});

const githubRepository = { host: 'github.com', owner: 'team', name: 'repo' };
const githubIssue = { number: 7, title: 'Issue', url: 'https://github.com/team/repo/issues/7', updatedAt: '2026-10-04', state: 'open', labels: ['bug'], assignees: ['owner'] };

test('instruction catalog uses the shared connection and exposes metadata without loading bodies', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	assert.equal(connected.api.instructions.isAvailable, true);
	const catalog = connected.api.instructions.list('instruction-session');
	assert.deepEqual({ method: transport.requests.at(-1)?.method, params: transport.requests.at(-1)?.params }, { method: 'instructions/list', params: { sessionId: 'instruction-session' } });
	transport.respondAt(-1, { instructions: [{ path: '/workspace/.ash/instructions/review.md', name: 'Review', description: null, scope: 'directory', load: 'onDemand', patterns: [] }], diagnostics: [] });
	assert.deepEqual(await catalog, [{ path: '/workspace/.ash/instructions/review.md', name: 'Review', description: undefined, scope: 'directory' }]);
});

test('Terminal host adapts raw bytes and command exit codes at the protocol boundary', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const terminal = connected.api.terminal;
	const profile = { profileId: 'shell', title: 'Shell', isDefault: true };
	const profiles = terminal.listProfiles();
	transport.respondAt(-1, { profiles: [profile] });
	assert.deepEqual(await profiles, [profile]);
	const creation = terminal.create({ dirId: 'workspace-folder', rows: 24, cols: 80, profile: { type: 'default' } });
	const createRequest = transport.requests.at(-1)!;
	assert.deepEqual({ method: createRequest.method, params: createRequest.params }, {
		method: 'terminal/create',
		params: { dirId: 'workspace-folder', rows: 24, cols: 80, profile: { type: 'default' }, lifecycle: { type: 'connectionOwned' } },
	});
	transport.respondAt(-1, { ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId: 'terminal-1', profile, reconnect: null });
	assert.deepEqual(await creation, { ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId: 'terminal-1', profile, connectionPersistence: 'connectionOwned' });
	const binary = terminal.write({ dirId: 'workspace-folder', terminalId: 'terminal-1', data: new Uint8Array([0, 0x80, 0xff]) });
	assert.deepEqual(transport.requests.at(-1)?.params, { dirId: 'workspace-folder', terminalId: 'terminal-1', dataBase64: 'AID/' });
	assert.equal(transport.requests.at(-1)?.method, 'terminal/writeBinary');
	transport.respondAt(-1, null);
	await binary;
	const read = terminal.read({ dirId: 'workspace-folder', terminalId: 'terminal-1', afterSequence: 0, afterCommandSequence: 0, maxChunks: 128 });
	const bytes = Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0x1b]);
	transport.respondAt(-1, {
		terminalId: 'terminal-1', chunks: [{ sequence: 1, dataBase64: bytes.toString('base64') }],
		nextSequence: 1, outputGap: true,
		commandEvents: [
			{ sequence: 1, commandId: 'command-1', status: 'running', exitCode: null, afterOutputSequence: 0 },
			{ sequence: 2, commandId: 'command-1', status: 'failed', exitCode: 17, afterOutputSequence: 1 },
		],
		nextCommandSequence: 2, commandEventGap: true, exited: true, exitCode: 17,
	});
	assert.deepEqual(await read, {
		terminalId: 'terminal-1', chunks: [{ sequence: 1, data: new Uint8Array(bytes) }],
		nextSequence: 1, outputGap: true,
		commandEvents: [
			{ sequence: 1, commandId: 'command-1', status: 'running', exitCode: undefined, afterOutputSequence: 0 },
			{ sequence: 2, commandId: 'command-1', status: 'failed', exitCode: 17, afterOutputSequence: 1 },
		],
		nextCommandSequence: 2, commandEventGap: true, exited: true, exitCode: 17,
	});
	const close = terminal.close({ dirId: 'workspace-folder', terminalId: 'terminal-1' });
	transport.respondAt(-1, null);
	await close;
});

test('GitHub domain service is assembled on the shared connection and maps issue details', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const pending = connected.api.github.readIssue(githubRepository, 7);
	const request = transport.requests.at(-1)!;
	assert.equal(request.method, 'github/issue/read');
	assert.deepEqual({ ...(request.params as object), operationId: 'generated' }, { repository: githubRepository, number: 7, operationId: 'generated' });
	const comment = { id: 9, body: 'Discussion', url: 'https://github.com/team/repo/issues/7#issuecomment-9', updatedAt: '2026-10-04' };
	transport.respondAt(-1, { issue: githubIssue, body: 'Body', comments: [comment] });
	assert.deepEqual(await pending, { ...githubIssue, body: 'Body', comments: [comment] });
});

test('GitHub retains error categories independently of product issue reporting', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	for (const [kind, code] of [
		['AccountAuthenticationRequired', GitHubErrorCode.AuthenticationRequired],
		['GitHubPermissionDenied', GitHubErrorCode.PermissionDenied],
		['GitHubRateLimited', GitHubErrorCode.RateLimited],
		['GitHubNotFound', GitHubErrorCode.NotFound],
		['GitHubConflict', GitHubErrorCode.Conflict],
		['GitHubTimedOut', GitHubErrorCode.TimedOut],
		['GitHubSubmissionUncertain', GitHubErrorCode.SubmissionUncertain],
		['GitHubUnavailable', GitHubErrorCode.Unavailable],
		['InvalidParams', GitHubErrorCode.InvalidInput],
		['GitHubOperationFailed', GitHubErrorCode.OperationFailed],
	] as const) {
		const pending = connected.api.github.readIssue(githubRepository, 7);
		const rejected = assert.rejects(pending, (error: unknown) => error instanceof GitHubError && error.code === code);
		transport.rejectAt(-1, { code: -32070, message: kind, data: { kind } });
		await rejected;
	}
});

test('GitHub cancels its original operation and releases cancellation listeners', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.github.listIssues(githubRepository, GitHubIssueState.Open, '', 1, cancellation.token);
	const originalIndex = transport.requests.length - 1;
	const original = transport.requests[originalIndex]!;
	const rejected = assert.rejects(pending, isCancellationError);
	cancellation.cancel();
	assert.equal(transport.requests.at(-1)!.method, 'github/cancel');
	assert.deepEqual(transport.requests.at(-1)!.params, { operationId: (original.params as { operationId: string; }).operationId });
	transport.respondAt(-1, { status: 'requested' });
	transport.rejectAt(originalIndex, { code: -32800, message: 'RequestCancelled', data: { kind: 'RequestCancelled' } });
	await rejected;
	const count = transport.requests.length;
	await assert.rejects(connected.api.github.readIssue(githubRepository, 7, cancellation.token), isCancellationError);
	assert.equal(transport.requests.length, count);
	using completed = new CancellationTokenSource();
	const read = connected.api.github.listLabels(githubRepository, completed.token);
	transport.respondAt(-1, { labels: [] });
	await read;
	const afterCompletion = transport.requests.length;
	completed.cancel();
	assert.equal(transport.requests.length, afterCompletion);
});

test('GitHub keeps a confirmed write when cancellation races with its response', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.github.createIssue(githubRepository, { title: 'Issue', body: 'Body', labels: ['bug'], assignees: ['owner'] }, cancellation.token);
	const originalIndex = transport.requests.length - 1;
	cancellation.cancel();
	transport.respondAt(-1, { status: 'completed' });
	transport.respondAt(originalIndex, { issue: githubIssue, body: 'Body' });
	assert.deepEqual(await pending, { ...githubIssue, body: 'Body' });
});

test('GitHub reports a lost write response as uncertain and never resubmits it', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const pending = connected.api.github.createComment(githubRepository, 7, 'Discussion');
	const rejected = assert.rejects(pending, (error: unknown) => error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain);
	transport.close('connection lost');
	await rejected;
	assert.equal(transport.requests.filter(request => request.method === 'github/comment/create').length, 1);
});

test('GitHub merge carries the reviewed head and file limits remain visible', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const commit = 'a'.repeat(40);
	const merge = connected.api.github.mergePullRequest(githubRepository, 7, { commit, method: GitHubMergeMethod.Squash });
	const params = transport.requests.at(-1)!.params as { commit: string; method: string; };
	assert.deepEqual({ commit: params.commit, method: params.method }, { commit, method: 'squash' });
	transport.respondAt(-1, { commit: 'b'.repeat(40), merged: true, message: 'Merged' });
	assert.equal((await merge).merged, true);
	const files = connected.api.github.listPullRequestFiles(githubRepository, 7, 30);
	transport.respondAt(-1, { files: [], nextPage: null, limitReached: true });
	assert.deepEqual(await files, { items: [], nextPage: null, limitReached: true });
	const label = { name: 'bug', color: 'ff0000' };
	const update = connected.api.github.updateLabelColor(githubRepository, label);
	transport.respondAt(-1, label);
	assert.deepEqual(await update, label);
});

test('GitHub rejects an unavailable contract before dispatching a mutation', async () => {
	const transport = new FakeTransport(value => ({ ...value, capabilities: { ...value.capabilities, github: false, contracts: { ...value.capabilities.contracts, github: { version: 2 } } } }));
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const count = transport.requests.length;
	await assert.rejects(connected.api.github.deleteComment(githubRepository, 9), (error: unknown) => error instanceof GitHubError && error.code === GitHubErrorCode.Unavailable);
	assert.equal(transport.requests.length, count);
});

test('Git ignore cancellation reaches the server and consumes the original terminal response', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.git.checkIgnore({ repositoryId: 'root', paths: ['cache'] }, cancellation.token);
	const originalIndex = transport.requests.length - 1;
	const original = transport.requests[originalIndex]!;
	const rejected = assert.rejects(pending, isCancellationError);
	cancellation.cancel();
	const cancelIndex = transport.requests.length - 1;
	assert.equal(transport.requests[cancelIndex]!.method, 'git/checkIgnore/cancel');
	assert.deepEqual(transport.requests[cancelIndex]!.params, { operationId: (original.params as { operationId: string; }).operationId });
	transport.respondAt(cancelIndex, { status: 'requested' });
	transport.rejectAt(originalIndex, { code: -32800, message: 'RequestCancelled', data: { kind: 'RequestCancelled' } });
	await rejected;
	const count = transport.requests.length;
	await assert.rejects(connected.api.git.checkIgnore({ paths: ['cache'] }, cancellation.token), isCancellationError);
	assert.equal(transport.requests.length, count);
});

test('Git ignore preserves the server result when completion wins the cancellation race', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	using cancellation = new CancellationTokenSource();
	const pending = connected.api.git.checkIgnore({ paths: ['cache'] }, cancellation.token);
	const queryIndex = transport.requests.length - 1;
	cancellation.cancel();
	transport.respondAt(-1, { status: 'completed' });
	transport.respondAt(queryIndex, { ignoredPaths: ['cache'] });
	assert.deepEqual(await pending, { ignoredPaths: ['cache'] });
});

const connectorHostServices = {
	externalOpener: { openExternal: async () => true },
	clipboardService: {
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
		readText: async () => '',
		writeText: async () => undefined,
		readResources: async () => ({ resources: [], operation: 'copy' as const }),
		writeResources: async () => undefined,
		hasResources: async () => false,
	},
};

test('Web reconnect initializes again without replaying an uncertain write', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	try {
		assert.equal(connected.api.appServer.connectionGeneration, 1);
		const pending = connected.api.fs.writeFile({ dirId: 'web-dev:test', path: 'main.ts', content: 'changed' });
		const rejected = assert.rejects(pending, /backend restarted/);
		transport.close('backend restarted');
		await rejected;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Web did not reconnect')), 3_000);
			const subscription = connected.api.appServer.onConnectionState(state => {
				if (state === 'ready') { clearTimeout(timeout); subscription.dispose(); resolve(); }
			});
		});
		assert.equal(transport.requests.filter(request => request.method === 'initialize').length, 2);
		assert.equal(connected.api.appServer.connectionGeneration, 2);
		assert.equal(transport.requests.filter(request => request.method === 'fs/writeFile').length, 1);
		assert.deepEqual(await connected.api.session.list(), { sessions: [] });
	} finally { connected.dispose(); }
});

test('Web disposal cancels scheduled reconnect and revoked authorization is terminal', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	transport.close('connection lost');
	connected.dispose();
	await new Promise(resolve => setTimeout(resolve, 600));
	assert.equal(transport.sentEvents.filter(event => event === WEB_APP_SERVER_CONNECT_EVENT).length, 1);
	const revokedTransport = new FakeTransport();
	const revoked = await connectWebRendererApi(revokedTransport, connectorHostServices);
	try {
		revokedTransport.emit(WEB_APP_SERVER_CLOSED_EVENT, { intentional: true, message: 'Authorization revoked' });
		await new Promise(resolve => setTimeout(resolve, 600));
		assert.equal(await revoked.api.appServer.getConnectionState(), 'stopped');
		assert.equal(revokedTransport.sentEvents.filter(event => event === WEB_APP_SERVER_CONNECT_EVENT).length, 1);
	} finally { revoked.dispose(); }
});

test('Hooks use the shared protocol, retain disabled declarations, and refresh on configuration changes', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const pending = connected.api.hooks.read('session-hooks');
	assert.deepEqual(transport.requests.at(-1)?.params, { sessionId: 'session-hooks' });
	assert.equal(transport.requests.at(-1)?.method, 'hook/list');
	transport.respondAt(-1, {
		sources: [{
			namespace: 'user', configPath: '/profile/config.toml', hooks: [
				{ id: 'user:hook:check', event: 'preToolUse', enablement: 'disabled', matcher: { toolNames: ['shell-command'] }, action: { type: 'process', program: '/program with spaces', args: ['two words', '"quote"'] } },
			]
		}]
	});
	assert.deepEqual(await pending, [{
		namespace: 'user', configPath: '/profile/config.toml', hooks: [
			{ id: 'user:hook:check', event: 'preToolUse', enabled: false, toolNames: ['shell-command'], program: '/program with spaces', args: ['two words', '"quote"'] },
		]
	}]);
	const userRead = connected.api.hooks.read();
	assert.deepEqual(transport.requests.at(-1)?.params, {});
	transport.respondAt(-1, { sources: [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [] }] });
	assert.equal((await userRead)[0]?.hooks.length, 0);
	let changes = 0;
	const subscription = connected.api.hooks.onDidChange(() => changes++);
	transport.emitNotification({ method: 'config/changed', params: { revision: 2, generation: 2 } });
	assert.equal(changes, 1);
	subscription.dispose();
	transport.emitNotification({ method: 'config/changed', params: { revision: 3, generation: 3 } });
	assert.equal(changes, 1);
	assert.equal(connected.api.hooks.userConfigurationEditor, undefined);
});

test('review environment adapter preserves scope, provenance, cancellation, and revision conflicts', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const environment = connected.api.approvalEnvironment;
	assert.ok(environment);
	const scope = { type: 'thread' as const, threadId: 'own-thread' };
	const entry = { id: 'entry-1', kind: 'fact' as const, title: 'Build', content: 'pnpm build', source: { id: 'source-1', kind: 'projectFile' as const, label: 'package.json', revision: 'sha256-version' }, accepted: false, current: true };
	const defaults = { recentCommands: false, shellHistory: false, otherRepositories: false, summarizeWithModel: false, history: { sessions: 50, commandsPerSession: 200, days: null } };
	const read = environment.read(scope);
	assert.deepEqual(transport.requests.at(-1)?.params, { scope });
	transport.respondAt(-1, { root: '/own-worktree', scanOptions: defaults, profile: { revision: 3, entries: [entry], observations: [] } });
	assert.deepEqual(await read, { root: '/own-worktree', scanOptions: defaults, revision: 3, entries: [entry] });
	const options = { ...defaults, summarizeWithModel: true };
	const model = { provider: 'openai', model: 'task-model' };
	const scan = environment.scan(scope, 'scan-id', options, model);
	assert.equal(transport.requests.at(-1)?.method, 'approval/environment/scan');
	assert.deepEqual(transport.requests.at(-1)?.params, { scope, operationId: 'scan-id', options, model });
	const historical = { ...entry, source: { ...entry.source, kind: 'recentCommand' as const, command: { occurrences: 7, sessionCount: 3, samples: [{ sessionId: 'another-session', threadId: 'another-thread', turnId: 'another-turn', sequence: 7, recordedAtUnixMs: 1000 }] } } };
	const history = { sessionsAvailable: 60, sessionsScanned: 50, commandsAvailable: 2000, commandsScanned: 1000, factsAvailable: 80, factsIncluded: 40 };
	transport.respondAt(-1, { root: '/own-worktree', history, draft: { id: 'scan-id', baseRevision: 3, entries: [historical] } });
	assert.deepEqual(await scan, { root: '/own-worktree', history, id: 'scan-id', baseRevision: 3, entries: [historical] });
	const cancel = environment.cancel('scan-id');
	assert.deepEqual(transport.requests.at(-1)?.params, { operationId: 'scan-id' });
	transport.respondAt(-1, null);
	await cancel;
	const input = { id: entry.id, kind: entry.kind, title: entry.title, content: entry.content, sourceId: entry.source.id };
	const save = environment.save(scope, 'save-id', 3, [input], 'scan-id');
	assert.deepEqual(transport.requests.at(-1)?.params, { scope, commandId: 'save-id', expectedRevision: 3, entries: [input], draftId: 'scan-id' });
	transport.rejectAt(-1, { code: -32091, message: 'ApprovalEnvironmentConflict', data: { kind: 'ApprovalEnvironmentConflict' } });
	await assert.rejects(save, /Rescan before saving/);
	const disabledTransport = new FakeTransport(value => ({ ...value, capabilities: { ...value.capabilities, approvalEnvironment: false } }));
	const disabled = await connectWebRendererApi(disabledTransport, connectorHostServices);
	using disabledCleanup = toDisposable(() => disabled.dispose());
	assert.equal(disabled.api.approvalEnvironment, undefined);
});

test('server path platform belongs to the initialized connection and clears on disconnect', async () => {
	let targetOS: 'windows' | 'mac' = 'windows';
	const transport = new FakeTransport(value => ({ ...value, serverInfo: { ...value.serverInfo, operatingSystem: targetOS, userHome: targetOS === 'windows' ? 'C:\\Users\\test' : '/Users/test' } }));
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const api = createAppServerAppServerApi(client);
	const readyPlatforms: (OperatingSystem | undefined)[] = [];
	using listener = client.onStateChange(state => { if (state === 'ready') readyPlatforms.push(api.operatingSystem); });
	assert.equal(api.operatingSystem, undefined);
	await client.connect();
	assert.equal(api.operatingSystem, OperatingSystem.Windows);
	assert.equal(api.userHome, 'C:\\Users\\test');
	client.disconnect();
	assert.equal(api.operatingSystem, undefined);
	assert.equal(api.userHome, undefined);
	targetOS = 'mac';
	await client.connect();
	assert.deepEqual(readyPlatforms, [OperatingSystem.Windows, OperatingSystem.Macintosh]);
	assert.equal(api.userHome, '/Users/test');
	client.dispose();
	assert.equal(api.operatingSystem, undefined);
	assert.equal(api.userHome, undefined);
});

test('server user home rejects relative paths at initialization', async () => {
	for (const userHome of ['', 'relative/home', '/home/test\0other']) {
		const transport = new FakeTransport(value => ({ ...value, serverInfo: { ...value.serverInfo, userHome } }));
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		await assert.rejects(client.connect(), /user home must be an absolute directory/);
		assert.equal(client.userHome, undefined);
	}
});

class FakeTransport implements AppServerTransport {
	constructor(private readonly initialize: (value: InitializeResult) => unknown = value => value, private readonly initializeDelayMs = 0) { }
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly requests: Array<Record<string, unknown>> = [];
	readonly sentEvents: string[] = [];

	on(event: string, listener: (payload: unknown) => void): void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
	}

	off(event: string, listener: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	send(event: string, payload?: unknown): void {
		this.sentEvents.push(event);
		if (event === WEB_APP_SERVER_CONNECT_EVENT) {
			this.emit(WEB_APP_SERVER_CONNECTED_EVENT, {
				protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION,
				workspaceId: "web-dev:test",
				workspaceRoot: "C:\\workspace",
			});
			return;
		}
		if (event !== WEB_APP_SERVER_FRAME_EVENT || !isRecord(payload) || typeof payload.frame !== "string") return;
		const request = JSON.parse(payload.frame) as Record<string, unknown>;
		this.requests.push(request);
		if (request.method === "initialize") {
			const result = this.initialize(createTestInitializeResult());
			if (this.initializeDelayMs > 0) {
				setTimeout(() => this.respond(request, result), this.initializeDelayMs);
			} else {
				this.respond(request, result);
			}
		} else if (request.method === "env/dirs/set") {
			this.respond(request, { dirs: [] });
		} else if (request.method === "session/list") {
			this.respond(request, { sessions: [] });
		} else if (request.method === "syntax/open" || request.method === "syntax/update") {
			this.respond(request, null);
		} else if (request.method === "syntax/analyze") {
			this.respond(request, { revision: 4, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] });
		} else if (request.method === "syntax/selectionRanges") {
			this.respond(request, { revision: 4, ranges: [] });
		} else if (request.method === "syntax/close") {
			this.respond(request, null);
		}
	}

	emitNotification(notification: ServerNotification): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", ...notification }) });
	}

	close(message: string): void {
		this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message });
	}

	respondAt(index: number, result: unknown): void {
		const request = this.requests.at(index);
		if (!request) throw new Error(`No request at index ${index}`);
		this.respond(request, result);
	}

	rejectAt(index: number, error: unknown): void {
		const request = this.requests.at(index);
		if (!request) throw new Error(`No request at index ${index}`);
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", id: request.id, error }) });
	}

	private respond(request: Record<string, unknown>, result: unknown): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
	}

	public emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

class SkillResourceTransport extends FakeTransport {
	public onOpen: (() => void) | undefined;
	public onRead: (() => void) | undefined;
	constructor(private readonly bytes: Buffer) { super(); }
	public override send(event: string, payload?: unknown): void {
		super.send(event, payload);
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const request = this.requests.at(-1)!;
		if (request.method === 'skill/resource/open') {
			this.onOpen?.();
			this.respondAt(-1, { path: 'SKILL.md', kind: 'instructions', resource: { resourceId: 'resource_0000000000000001', mimeType: 'text/markdown', size: this.bytes.length, sha256: `sha256:${createHash('sha256').update(this.bytes).digest('hex')}` } });
		} else if (request.method === 'resource/read') {
			this.onRead?.();
			const params = request.params as { offset: number; maxBytes: number; };
			const chunk = this.bytes.subarray(params.offset, params.offset + params.maxBytes);
			this.respondAt(-1, { resourceId: 'resource_0000000000000001', offset: params.offset, dataBase64: chunk.toString('base64'), decodedLength: chunk.length, eof: params.offset + chunk.length === this.bytes.length });
		} else if (request.method === 'resource/release') this.respondAt(-1, null);
	}
}

test('initialization can outlast bridge connection without timing out', async () => {
	const transport = new FakeTransport(value => value, 20);
	const client = new AppServerProtocolClient(transport, { connectTimeoutMs: 5, initializeTimeoutMs: 5_000 });
	try {
		await client.connect();
		assert.equal(client.state, 'ready');
	} finally { client.dispose(); }
});

for (const stage of ['bridge', 'initialize'] as const) {
	for (const close of ['disconnect', 'dispose', 'transport'] as const) {
		test(`closing after ${stage} responds prevents the pending connection from becoming ready (${close})`, async () => {
			const transport = new FakeTransport();
			const client = new AppServerProtocolClient(transport, { initializeTimeoutMs: 20 });
			using cleanup = toDisposable(() => client.dispose());
			const connecting = client.connect();
			const rejected = assert.rejects(connecting, isCancellationError);
			if (stage === 'initialize') await Promise.resolve();
			if (close === 'transport') transport.close('Backend stopped');
			else client[close]();
			const requestCount = transport.requests.length;
			await rejected;
			assert.deepEqual({
				state: client.state,
				newRequests: transport.requests.length - requestCount,
			}, { state: close === 'transport' ? 'crashed' : 'stopped', newRequests: 0 });
		});
	}
}

test('replacing a connection before its bridge continuation does not initialize the old connection', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const old = client.connect();
	const rejected = assert.rejects(old, isCancellationError);
	client.disconnect();
	const replacement = client.connect();
	await rejected;
	await replacement;
	assert.deepEqual({
		state: client.state,
		generation: client.generation,
		initializations: transport.requests.filter(request => request.method === 'initialize').length,
	}, { state: 'ready', generation: 2, initializations: 1 });
});

test('an old initialization rejection cannot close its replacement connection', async () => {
	const transport = new FakeTransport(value => value, 5);
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	const old = client.connect();
	const rejected = assert.rejects(old, /connection replaced/);
	await Promise.resolve();
	client.disconnect();
	const replacement = client.connect();
	await rejected;
	await replacement;
	assert.deepEqual({
		state: client.state,
		generation: client.generation,
		disconnects: transport.sentEvents.filter(event => event === WEB_APP_SERVER_DISCONNECT_EVENT).length,
	}, { state: 'ready', generation: 2, disconnects: 1 });
});

for (const state of ['starting', 'initializing', 'ready'] as const) {
	test(`a connection observer can dispose during ${state} without sending subsequent traffic`, async () => {
		const transport = new FakeTransport();
		const client = new AppServerProtocolClient(transport, { connectTimeoutMs: 20 });
		using cleanup = toDisposable(() => client.dispose());
		using observer = client.onStateChange(value => { if (value === state) client.dispose(); });
		await assert.rejects(client.connect(), state === 'starting' ? /client disposed/ : isCancellationError);
		assert.deepEqual({
			state: client.state,
			connects: transport.sentEvents.filter(event => event === WEB_APP_SERVER_CONNECT_EVENT).length,
			requests: transport.requests.length,
		}, { state: 'stopped', connects: state === 'starting' ? 0 : 1, requests: state === 'ready' ? 1 : 0 });
	});
}

test('a synchronous bridge send failure settles its waiter and permits a new connection', async () => {
	let failConnect = true;
	const transport = new class extends FakeTransport {
		override send(event: string, payload?: unknown): void {
			if (event === WEB_APP_SERVER_CONNECT_EVENT && failConnect) { throw new Error('Bridge unavailable'); }
			super.send(event, payload);
		}
	}();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await assert.rejects(client.connect(), /Bridge unavailable/);
	assert.equal(client.state, 'crashed');
	failConnect = false;
	await client.connect();
	assert.deepEqual({ state: client.state, generation: client.generation }, { state: 'ready', generation: 2 });
});

test('a matching schema initializes and decodes additive result fields', async () => {
	const transport = new FakeTransport(value => ({
		...value,
		futureCapability: true,
	}));
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		const response = client.request(APP_SERVER_METHODS['automation/list'], {});
		transport.respondAt(-1, { automations: [], futureResultField: 1 });
		assert.deepEqual(await response, { automations: [], futureResultField: 1 });
		assert.equal(client.state, 'ready');
	} finally { client.dispose(); }
});

test('incompatible versions and missing required capabilities never make a connection ready', async () => {
	for (const initialize of [
		(value: InitializeResult) => ({ ...value, protocolVersion: { ...value.protocolVersion, major: value.protocolVersion.major + 1 } }),
		(value: InitializeResult) => ({ ...value, capabilities: { ...value.capabilities, sessions: false } }),
		(value: InitializeResult) => ({ ...value, schemaHash: `sha256:${'0'.repeat(64)}` }),
	]) {
		const client = new AppServerProtocolClient(new FakeTransport(initialize));
		try {
			await assert.rejects(client.connect(), /protocol major mismatch|protocol schema mismatch|capability sessions/);
			assert.equal(client.state, 'crashed');
			await assert.rejects(client.request(APP_SERVER_METHODS['session/list'], {}), /not ready/);
		} finally { client.dispose(); }
	}
});

test('a successful handshake does not authorize undeclared notifications', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	try {
		await client.connect();
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'future/changed', params: {} }) });
		assert.equal(client.state, 'crashed');
	} finally { client.dispose(); }
});

test("connects, initializes, maps renderer requests, and disposes the Web connection", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	assert.deepEqual(connected.metadata, { workspaceId: "web-dev:test", workspaceRoot: "C:\\workspace" });
	assert.equal(await connected.api.appServer.getConnectionState(), "ready");
	assert.deepEqual(await connected.api.appServer.getSlashCommands(), []);
	assert.deepEqual(await connected.api.session.list(), { sessions: [] });
	assert.deepEqual(hot.requests.map((request) => request.method), ["initialize", "session/list"]);
	assert.equal((hot.requests[0]?.params as { capabilities: { dirPermissionsHost?: unknown; }; }).capabilities.dirPermissionsHost, undefined);
	connected.dispose();
	assert.equal(hot.sentEvents.at(-1), WEB_APP_SERVER_DISCONNECT_EVENT);
});

test("delivers App Server notifications and reports bridge closure", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const notifications: ServerNotification[] = [];
	const states: string[] = [];
	connected.api.events.subscribe((notification) => notifications.push(notification));
	connected.api.appServer.onConnectionState((state) => states.push(state));
	const notification: ServerNotification = { method: "fs/changed", params: { type: "pathsChanged", paths: ["README.md"] } };
	hot.emitNotification(notification);
	hot.close("test bridge closed");
	assert.deepEqual(notifications, [notification]);
	assert.deepEqual(states, ["crashed"]);
	assert.equal(await connected.api.appServer.getConnectionState(), "crashed");
	connected.dispose();
});

test("routes bounded syntax analysis through the connected renderer host", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);

	await connected.api.syntax.open({ documentId: "model-1", language: "rust", revision: 4, text: "fn main() {}\n" });
	assert.equal(hot.requests.at(-1)?.method, "syntax/open");
	await connected.api.syntax.update({ documentId: "model-1", previousRevision: 4, revision: 5, edits: [{ startOffset: 3, endOffset: 7, text: "entry" }] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/update");
	const result = await connected.api.syntax.analyze({
		documentId: "model-1",
		revision: 4,
	});

	assert.deepEqual(result, { revision: 4, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/analyze");

	assert.deepEqual(await connected.api.syntax.selectionRanges({ documentId: "model-1", revision: 4, ranges: [{ start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } }] }), { revision: 4, ranges: [] });
	assert.equal(hot.requests.at(-1)?.method, "syntax/selectionRanges");
	await connected.api.syntax.close({ documentId: "model-1" });
	assert.equal(hot.requests.at(-1)?.method, "syntax/close");
	connected.dispose();
});

test("uses a stable operation ID to cancel a language request", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	const hoverRequest = hot.requests.at(-1);
	assert.equal(hoverRequest?.method, "language/hover");
	const hoverParams = hoverRequest?.params;
	assert.ok(isRecord(hoverParams));
	assert.equal(typeof hoverParams.operationId, "string");
	assert.ok(isRecord(hoverParams.request));
	assert.ok(isRecord(hoverParams.request.document));
	assert.equal(hoverParams.request.document.path, "src/main.rs");

	cancellation.abort();
	const cancelRequest = hot.requests.at(-1);
	assert.equal(cancelRequest?.method, "language/cancel");
	assert.deepEqual(cancelRequest?.params, { operationId: hoverParams.operationId });
	hot.respondAt(-1, { status: "requested" });

	await assert.rejects(pending, isCancellationError);
	connected.dispose();
});

test("keeps the language result when completion wins the cancel race", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	cancellation.abort();
	hot.respondAt(-2, { revision: 1, contents: "main", range: null });
	hot.respondAt(-1, { status: "completed" });

	assert.deepEqual(await pending, { revision: 1, contents: "main", range: null });
	connected.dispose();
});

test("keeps the language failure when completion wins the cancel race", async () => {
	const hot = new FakeTransport();
	const connected = await connectWebRendererApi(hot, connectorHostServices);
	const cancellation = new AbortController();
	const pending = connected.api.language.hover({
		document: { path: "src/main.rs", languageId: "rust", revision: 1, text: "fn main() {}" },
		position: { lineIndex: 0, columnIndex: 3 },
	}, { signal: cancellation.signal });

	cancellation.abort();
	hot.rejectAt(-2, { code: -32072, message: "LanguageRequestFailed", data: { kind: "LanguageRequestFailed" } });
	hot.respondAt(-1, { status: "completed" });

	await assert.rejects(pending, (error: unknown) => error instanceof AppServerRemoteError && error.errorName === "LanguageRequestFailed");
	connected.dispose();
});

test('renderer dispatches host requests and rejects late results after disconnect', async () => {
	const hot = new FakeTransport();
	const client = new AppServerProtocolClient(hot);
	using cleanup = toDisposable(() => client.dispose());
	let signal: AbortSignal | undefined;
	let finish!: (value: { targetId: string; }) => void;
	const handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		signal = context.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	await client.connect();
	const params: BrowserCreateParams = { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' };
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'host-1', method: 'browser/create', params }) });
	await Promise.resolve();
	assert.equal(signal?.aborted, false);
	client.disconnect();
	assert.equal(signal?.aborted, true);
	finish({ targetId: 'retired-target' });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(hot.requests.some(request => request.id === 'host-1'), false);
	await client.connect();
	assert.equal(client.generation, 2);
	handler.dispose();
	client.dispose();
});

for (const cancelled of [false, true]) {
	test(`host handler ${cancelled ? 'cancellation' : 'failure'} produces a complete error and leaves the connection usable`, async () => {
		const transport = new FakeTransport();
		const client = new AppServerProtocolClient(transport);
		using cleanup = toDisposable(() => client.dispose());
		using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], () => {
			throw cancelled ? new CancellationError('host operation cancelled') : new Error('host operation failed');
		});
		await client.connect();
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'host-error', method: 'browser/create', params: { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' } }) });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(decodeAppServerServerResponse('browser/create', transport.requests.at(-1)), {
			jsonrpc: '2.0', id: 'host-error', error: { code: cancelled ? -32800 : -32000, message: cancelled ? 'host operation cancelled' : 'host operation failed', data: null },
		});
		assert.equal(client.state, 'ready');
		const next = client.request(APP_SERVER_METHODS['automation/list'], {});
		transport.respondAt(-1, { automations: [] });
		assert.deepEqual(await next, { automations: [] });
	});
}

test('invalid response rejects its pending request and unknown host methods receive method-not-found', async () => {
	const hot = new FakeTransport();
	const client = new AppServerProtocolClient(hot);
	await client.connect();
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'unknown-1', method: 'host/unknown', params: {} }) });
	assert.deepEqual(hot.requests.at(-1)?.error, { code: -32601, message: 'Method not found', data: null });
	assert.equal(client.state, 'ready');
	const pending = client.request(APP_SERVER_METHODS['automation/list'], {});
	hot.respondAt(-1, { automations: 'invalid' });
	await assert.rejects(pending);
	assert.equal(client.state, 'crashed');
	client.dispose();
});

test('extension client callbacks round-trip immutable JSON and release their request handler', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const registration = connected.api.extensionHost.registerClientHandler(async (operation, _signal, source) => {
		assert.deepEqual(source, { extensionId: 'test.editor', activationGeneration: 7, incarnation: 3 });
		assert.equal(operation.operation, 'executeCommand');
		if (operation.operation !== 'executeCommand') throw new Error('Unexpected extension operation');
		assert.equal(JSON.stringify(operation.arguments), '[{"paths":["src/main.ts"]}]');
		assert.equal(Object.isFrozen(operation.arguments[0]), true);
		return { result: 'command', value: Object.freeze({ paths: Object.freeze(['src/main.ts']) }) };
	});
	try {
		const params = { extensionId: 'test.editor', activationGeneration: 7, incarnation: 3, operation: { operation: 'executeCommand', command: 'test.paths', arguments: [{ paths: ['src/main.ts'] }] } };
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'extension-1', method: 'extensionClient/request', params }) });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(transport.requests.at(-1), { jsonrpc: '2.0', id: 'extension-1', result: { result: 'command', hasValue: true, value: { paths: ['src/main.ts'] } } });
		registration.dispose();
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'extension-2', method: 'extensionClient/request', params }) });
		assert.deepEqual(transport.requests.at(-1)?.error, { code: -32601, message: 'Method not found', data: null });
	} finally { registration.dispose(); }
});

test('Call service is assembled from the negotiated contract and ignores stale or foreign updates', async () => {
	const transport = new FakeTransport(value => ({ ...value, capabilities: { ...value.capabilities, contracts: { ...value.capabilities.contracts, calls: { version: 1 } } } }));
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	try {
		const calls = connected.api.calls;
		assert.ok(calls);
		const starting = calls.start({ type: 'local' });
		const params = transport.requests.at(-1)?.params as { resourceId: string; };
		const status = {
			resourceId: params.resourceId, sequence: 1, connection: 'connected' as const,
			call: { id: 'call', revision: 1, mediaEpoch: 1, mediaRoom: 'room', mediaState: { state: 'ready' as const }, members: [{ id: 'owner', role: 'owner' as const }] },
			memberId: 'owner', participants: [], muted: true, deafened: false, microphoneAllowed: true, screenSharing: false, error: null,
		};
		transport.respondAt(-1, status);
		await starting;
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 3, muted: false } });
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 2 } });
		transport.emitNotification({ method: 'call/changed', params: { ...status, sequence: 4, resourceId: 'another-window' } });
		assert.equal(calls.state?.muted, false);
		const leaving = calls.leave();
		transport.respondAt(-1, { ...status, sequence: 4, connection: 'ended', muted: true });
		await leaving;
		assert.equal(calls.state?.connection, 'ended');
	} finally { connected.dispose(); }
});


test('extension disk requests are rejected before reaching a renderer service', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	let calls = 0;
	const registration = connected.api.extensionHost.registerClientHandler(async () => {
		calls += 1;
		return { result: 'done' };
	});
	try {
		transport.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'extension-disk', method: 'extensionClient/request', params: { extensionId: 'test.editor', activationGeneration: 7, incarnation: 3, operation: { operation: 'readWorkspaceFile', path: 'data.txt' } } }) });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(calls, 0);
		assert.deepEqual(transport.requests.at(-1)?.error, { code: -32000, message: 'Workspace file requests must be handled by App Server', data: null });
	} finally { registration.dispose(); }
});

test('file glob uses the shared backend and maps root-relative paths to renderer resources', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const folder = { resource: URI.file('/workspace'), target: { type: 'workspace' as const, dirId: 'folder' } };
	const query = { includePatterns: ['src/**/*.ts'], excludePatterns: ['**/*.test.ts'], maxResults: 100 };
	const pending = connected.api.fileSearch.glob(folder, query);
	const request = transport.requests.at(-1)!;
	assert.equal(request.method, 'file/search/glob');
	assert.ok(isRecord(request.params));
	assert.equal(typeof request.params.operationId, 'string');
	assert.deepEqual(request.params, { operationId: request.params.operationId, target: folder.target, ...query });
	transport.respondAt(-1, { paths: ['src/中文.ts'], totalMatches: 105 });
	const result = await pending;
	assert.equal(result.matches[0]?.resource.path, '/workspace/src/中文.ts');
	assert.equal(result.matches[0]?.path, 'src/中文.ts');
	assert.equal(result.totalMatches, 105);
});

test('file glob cancellation waits for the original terminal reply and rejects late results', async () => {
	const transport = new FakeTransport();
	const connected = await connectWebRendererApi(transport, connectorHostServices);
	using cleanup = toDisposable(() => connected.dispose());
	const folder = { resource: URI.file('/workspace'), target: { type: 'workspace' as const, dirId: 'folder' } };
	const query = { includePatterns: [], excludePatterns: [], maxResults: 100 };
	const controller = new AbortController();
	const pending = connected.api.fileSearch.glob(folder, query, controller.signal);
	const operation = transport.requests.at(-1)!;
	controller.abort();
	const cancel = transport.requests.at(-1)!;
	assert.equal(cancel.method, 'file/search/glob/cancel');
	assert.ok(isRecord(operation.params));
	assert.deepEqual(cancel.params, { operationId: operation.params.operationId });
	let settled = false;
	const rejected = assert.rejects(pending, isCancellationError).then(() => { settled = true; });
	transport.respondAt(-1, null);
	await Promise.resolve();
	assert.equal(settled, false);
	transport.respondAt(-2, { paths: ['stale.txt'], totalMatches: 1 });
	await rejected;
	const count = transport.requests.length;
	await assert.rejects(connected.api.fileSearch.glob(folder, query, controller.signal), isCancellationError);
	assert.equal(transport.requests.length, count);
});

test('host cancellation retires only its request and ignores late completion', async () => {
	const hot = new FakeTransport();
	const client = new AppServerProtocolClient(hot);
	using cleanup = toDisposable(() => client.dispose());
	let signal: AbortSignal | undefined;
	let finish!: (value: { targetId: string; }) => void;
	using handler = client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['browser/create'], (_params, context) => {
		signal = context.signal;
		return new Promise(resolve => { finish = resolve; });
	});
	await client.connect();
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: 'cancel-host', method: 'browser/create', params: { threadId: '00000000-0000-4000-8000-000000000001', url: 'https://example.test' } }) });
	await Promise.resolve();
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'cancel-host' } }) });
	assert.equal(signal?.aborted, true);
	assert.equal(client.state, 'ready');
	assert.deepEqual(hot.requests.find(request => request.id === 'cancel-host')?.error, { code: -32800, message: 'Host request cancelled', data: null });
	finish({ targetId: 'cancelled-target' });
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(hot.requests.filter(request => request.id === 'cancel-host').length, 1);
	hot.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'unknown-host' } }) });
	assert.equal(client.state, 'ready');
});


test('the generated protocol client decodes external catalog scopes and revocation without an account', async () => {
	const transport = new FakeTransport();
	const client = new AppServerProtocolClient(transport);
	using cleanup = toDisposable(() => client.dispose());
	await client.connect();
	const observed: ServerNotification[] = [];
	using listener = client.onNotification(notification => { observed.push(notification); });
	const expected: ServerNotification[] = ['scope-a', null].map(identity => ({ method: 'provider/models/updated', params: { connection: 'kimi-cli', catalogScope: { connection: 'kimi-cli', identity }, result: { type: 'empty' } } }));
	for (const notification of expected) { transport.emitNotification(notification); }
	assert.deepEqual(observed, expected);
});
