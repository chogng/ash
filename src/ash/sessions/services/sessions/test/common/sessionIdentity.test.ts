import assert from 'node:assert/strict';
import { test } from 'mocha';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionArtifactType, type ISessionArtifact } from '../../../../../platform/agentHost/common/sessionArtifacts.js';
import type { ISession } from '../../common/session.js';
import { backendSession, projectSession, threadIdentity } from '../../common/sessionIdentity.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('session artifact projection qualifies chat identities and leaves artifact and resource identities opaque', () => {
	const file: ISessionArtifact = {
		id: 'opaque-artifact-id', chat: 'chat', type: SessionArtifactType.File,
		label: 'Plan', isArtifact: true, uri: 'file:///workspace/Plan.md', origin: { chat: 'source', turnId: 'turn' },
	};
	const reference: ISessionArtifact = {
		id: 'reference', type: SessionArtifactType.Website, label: 'Reference', isArtifact: false, link: 'https://example.com/Path',
	};
	const artifacts = observableValue<readonly ISessionArtifact[]>('artifacts', [file, reference]);
	const session: ISession = {
		sessionId: 'session', kind: 'code', title: 'Session', status: 'active', nextApprovalMode: 'manual', artifacts,
		chats: [{ threadId: 'chat', origin: { type: 'root' }, status: 'active' }],
	};
	assert.equal(projectSession(session, 'primary', 'Primary', 'primary'), session);
	const remote = projectSession(session, 'remote', 'Remote', 'primary');
	const expected = { ...file, chat: threadIdentity('remote', 'chat', 'primary'), origin: { ...file.origin!, chat: threadIdentity('remote', 'source', 'primary') } };
	assert.deepEqual(remote.artifacts!.get(), [expected, reference]);
	assert.deepEqual(backendSession(remote, 'primary').artifacts!.get(), [file, reference]);
	const notifications: unknown[] = [];
	using listener = remote.artifacts!.onDidChange(value => notifications.push(value));
	artifacts.set([reference]);
	assert.deepEqual(notifications, [[reference]]);
	assert.deepEqual(remote.artifacts!.get(), [reference]);
	assert.deepEqual(session.artifacts!.get(), [reference]);
});
