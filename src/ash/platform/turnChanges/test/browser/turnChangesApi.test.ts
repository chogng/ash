import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { ServerNotification, TurnChangesReadResult } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerTurnChangesApi } from '../../browser/turnChangesApi.js';
import type { TurnChangesUpdate } from '../../common/turnChangesApi.js';

ensureNoDisposablesAreLeakedInTestSuite();

function details(): TurnChangesReadResult {
	return {
		summary: {
			changeSetId: 'change', sessionId: 'session', threadId: 'thread', turnId: 'turn', repositoryId: 'repository',
			statistics: { files: 1, additions: 1, deletions: 0 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle',
			committedPaths: [], dependencies: [], externalDependencyPaths: [], warnings: ['original'], conflictPaths: [], revision: 1,
		},
		files: [{ path: 'file.ts', kind: 'modified', binary: false, additions: 1, deletions: 0 }],
	};
}

test('Ledger reads and notifications detach mutable transport values before consumers retain them', async () => {
	using notifications = new Emitter<ServerNotification>();
	const wire = details();
	const api = createAppServerTurnChangesApi({
		onNotification: notifications.event,
		request: async (definition: { method: string; }) => definition.method === 'turnChanges/list' ? { changeSets: [wire.summary] } : wire,
	} as unknown as AppServerProtocolClient);
	const list = await api.list({ sessionId: 'session', threadId: 'thread' });
	const read = await api.read({ sessionId: 'session', threadId: 'thread', changeSetId: 'change' });
	const observed: TurnChangesUpdate[] = [];
	using listener = api.onDidChange(event => observed.push(event));
	notifications.fire({ method: 'turnChanges/changed', params: { sessionId: 'session', threadId: 'thread', changeSets: [wire.summary] } });
	wire.summary.statistics.additions = 99;
	wire.summary.warnings.push('late transport mutation');
	wire.files[0].path = 'retired.ts';
	for (const summary of [list.changeSets[0], read.summary, observed[0].changeSets[0]]) {
		assert.deepEqual(summary.statistics, { files: 1, additions: 1, deletions: 0 });
		assert.deepEqual(summary.warnings, ['original']);
	}
	assert.equal(read.files[0].path, 'file.ts');
	listener.dispose();
	notifications.fire({ method: 'turnChanges/changed', params: { sessionId: 'session', threadId: 'thread', changeSets: [] } });
	assert.equal(observed.length, 1);
});

test('Commit preparation captures its selection and detaches retained previews', async () => {
	const wire = { commitId: 'commit', targetBranch: 'main', message: 'Captured commit', files: details().files, warnings: ['original'] };
	const selection = { changeSetId: 'change', expectedRevision: 1, paths: ['file.ts'] };
	let captured: { selections: { paths: string[]; }[]; } | undefined;
	const api = createAppServerTurnChangesApi({
		request: async (_definition: unknown, params: typeof captured) => { captured = params; return wire; },
	} as unknown as AppServerProtocolClient);
	const pending = api.prepareCommit({ sessionId: 'session', threadId: 'thread', commandId: 'prepare', selections: [selection], message: 'Captured commit' });
	selection.paths.push('later.ts');
	const preview = await pending;
	wire.files[0].path = 'retired.ts';
	wire.warnings.push('late transport mutation');
	assert.deepEqual(captured?.selections[0].paths, ['file.ts']);
	assert.equal(preview.files[0].path, 'file.ts');
	assert.deepEqual(preview.warnings, ['original']);
});
