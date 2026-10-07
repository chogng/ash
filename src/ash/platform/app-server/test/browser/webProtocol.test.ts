import assert from 'node:assert/strict';
import { test } from 'mocha';
import { decodeWebListenInfo, decodeWebSessionInfo } from '../../common/generated/WebProtocolDecoder.js';

test('Web launch decoder rejects remote endpoints and authority injected into metadata', () => {
	const info = { endpoint: 'http://127.0.0.1:5174/', ticket: 'a'.repeat(64), pid: 42 };
	assert.deepEqual(decodeWebListenInfo(info), info);
	for (const endpoint of ['https://example.com/', 'http://127.0.0.1:5174/?token=secret', 'http://user:password@127.0.0.1:5174/', 'file:///workspace']) {
		assert.throws(() => decodeWebListenInfo({ ...info, endpoint }));
	}
	assert.throws(() => decodeWebListenInfo({ ...info, ticket: 'short' }));
	const session = { token: 'b'.repeat(64), workspaceId: 'workspace', workspaceRoot: '/workspace' };
	assert.deepEqual(decodeWebSessionInfo(session), session);
	assert.throws(() => decodeWebSessionInfo({ ...session, dirPermissionsHost: true }));
});
