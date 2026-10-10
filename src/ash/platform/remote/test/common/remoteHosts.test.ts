import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { getRemoteAuthority } from '../../common/remoteHosts.js';

test('remote resource authority is independent of its resolver and transport', () => {
	assert.equal(getRemoteAuthority(URI.parse('ash-remote://team+build/workspace')), 'team+build');
	assert.equal(getRemoteAuthority(URI.parse('ash-remote://ssh+build/workspace')), 'ssh+build');
	assert.equal(getRemoteAuthority(URI.file('/workspace')), undefined);
});
