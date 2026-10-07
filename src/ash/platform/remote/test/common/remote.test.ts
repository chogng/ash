import { strict as assert } from "node:assert";
import { test } from "mocha";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { getRemoteWorkspacePath } from "../../../../platform/remote/common/remote.js";

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
