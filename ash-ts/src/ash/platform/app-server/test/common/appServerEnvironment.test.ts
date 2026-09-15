import assert from "node:assert/strict";
import { test } from "mocha";
import { buildAppServerEnvironment, isAllowedAppServerEnvironmentKey } from "../../../../platform/app-server/common/appServerEnvironment.js";

test("App Server environment keeps safe POSIX session variables and excludes credentials", () => {
	const environment = buildAppServerEnvironment({
		HOME: "/home/ash",
		LANG: "en_US.UTF-8",
		LC_ALL: "C.UTF-8",
		PATH: "/usr/bin",
		XDG_CONFIG_HOME: "/home/ash/.config",
		OPENAI_API_KEY: "secret",
	}, "posix", {
		ASH_APP_SERVER_PATH: "/opt/Ash/ash-app-server-daemon",
		ASH_ELECTRON_RUN_AS_NODE_PATH: "/opt/Ash/ash",
		ASH_HOME: "/state",
		ASH_WORKSPACE_ROOT: "/workspace",
		ASH_DIR_GRANT_SOURCE: "userConfig",
	});

	assert.deepEqual(environment, {
		HOME: "/home/ash",
		LANG: "en_US.UTF-8",
		PATH: "/usr/bin",
		XDG_CONFIG_HOME: "/home/ash/.config",
		LC_ALL: "C.UTF-8",
		ASH_APP_SERVER_PATH: "/opt/Ash/ash-app-server-daemon",
		ASH_ELECTRON_RUN_AS_NODE_PATH: "/opt/Ash/ash",
		ASH_HOME: "/state",
		ASH_WORKSPACE_ROOT: "/workspace",
		ASH_DIR_GRANT_SOURCE: "userConfig",
	});
	assert.equal(isAllowedAppServerEnvironmentKey("OPENAI_API_KEY"), false);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_APP_SERVER_PATH"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_ELECTRON_RUN_AS_NODE_PATH"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_DIR_GRANT_SOURCE"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ELECTRON_RUN_AS_NODE"), false);
});

test("App Server environment canonicalizes Windows keys case-insensitively", () => {
	const environment = buildAppServerEnvironment({
		Path: "C:\\Windows\\System32",
		SystemRoot: "C:\\Windows",
		UserProfile: "C:\\Users\\ash",
		AWS_SECRET_ACCESS_KEY: "secret",
	}, "windows", {
		ASH_HOME: "C:\\state",
	});

	assert.equal(environment.PATH, "C:\\Windows\\System32");
	assert.equal(environment.SYSTEMROOT, "C:\\Windows");
	assert.equal(environment.USERPROFILE, "C:\\Users\\ash");
	assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
});

test("App Server product environment accepts only owned non-NUL variables", () => {
	assert.throws(() => buildAppServerEnvironment({}, "posix", { OPENAI_API_KEY: "secret" }), /Invalid App Server product environment variable/);
	assert.throws(() => buildAppServerEnvironment({}, "posix", { ASH_HOME: "bad\0path" }), /Invalid App Server product environment variable/);
});
