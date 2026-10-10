import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { getRemoteWorkspacePath } from "../../../../platform/remote/common/remote.js";
import { URI } from '../../../../base/common/uri.js';

test("Remote Workspace URIs preserve legal POSIX backslashes", () => {
	const resource = createSshRemoteWorkspaceUri("BUILD-LINUX", "/srv/project\\archive");

	assert.equal(resource.toString(), "ash-remote://ssh+build-linux/srv/project%5Carchive");
	assert.equal(getRemoteWorkspacePath(resource), "/srv/project\\archive");
});

test("Remote Workspace URIs reject non-canonical POSIX paths instead of rewriting them", () => {
	assert.throws(() => createSshRemoteWorkspaceUri("build-linux", "/srv/project/"), /canonical/);
	assert.throws(() => createSshRemoteWorkspaceUri("build-linux", "/srv//project"), /canonical/);
	assert.throws(() => createSshRemoteWorkspaceUri("build-linux", "/srv/../project"), /canonical/);
});

test('extension-resolved folders retain canonical paths without requiring an SSH authority', () => {
	assert.equal(getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/project%20%E4%B8%AD')), '/srv/project 中');
	for (const path of ['/srv//project', '/srv/project/']) {
		assert.throws(() => getRemoteWorkspacePath(URI.from({ scheme: 'ash-remote', authority: 'team+build', path })), /canonical/);
	}
	// URI parsing normalizes literal dot segments; escaped separators remain part of the decoded path.
	assert.throws(() => getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/..%2Fproject')), /canonical/);
	assert.throws(() => getRemoteWorkspacePath(URI.parse('ash-remote://team+build/srv/project?ticket=secret')), /query or fragment/);
	assert.throws(() => getRemoteWorkspacePath(URI.parse('ash-remote://ssh+-oBad/srv/project')), /valid OpenSSH/);
});
