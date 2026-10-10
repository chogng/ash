import assert from "node:assert/strict";
import { test } from "mocha";
import { buildAppServerEnvironment, isAllowedAppServerEnvironmentKey } from "../../common/appServerEnvironment.js";

test("App Server environment inherits developer POSIX credentials and session variables", () => {
	const environment = buildAppServerEnvironment({
		HOME: "/home/ash",
		CARGO_HOME: "/tools/cargo",
		RUSTUP_HOME: "/tools/rustup",
		ZCODE_DATA_BASE_DIR: "/external-accounts",
		LANG: "en_US.UTF-8",
		LC_ALL: "C.UTF-8",
		PATH: "/usr/bin",
		SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
		XDG_CONFIG_HOME: "/home/ash/.config",
		OPENAI_API_KEY: "secret",
		ZCODE_CREDENTIAL_SECRET: "secret",
	}, "macos", {
		ASH_APP_SERVER_PATH: "/opt/Ash/ash-app-server-daemon",
		ASH_ELECTRON_RUN_AS_NODE_PATH: "/opt/Ash/ash",
		ASH_HOME: "/state",
		ASH_WORKSPACE_ROOT: "/workspace",
		ASH_DIR_GRANT_SOURCE: "userConfig",
		ASH_APP_SERVER_CONNECTION_ROLE: "agents",
		ASH_SSH_PATH: "/usr/bin/ssh",
	}, "desktop");

	assert.deepEqual(environment, {
		HOME: "/home/ash",
		CARGO_HOME: "/tools/cargo",
		RUSTUP_HOME: "/tools/rustup",
		ZCODE_DATA_BASE_DIR: "/external-accounts",
		LANG: "en_US.UTF-8",
		PATH: "/usr/bin",
		SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
		XDG_CONFIG_HOME: "/home/ash/.config",
		LC_ALL: "C.UTF-8",
		OPENAI_API_KEY: "secret",
		ZCODE_CREDENTIAL_SECRET: "secret",
		ASH_APP_SERVER_PATH: "/opt/Ash/ash-app-server-daemon",
		ASH_ELECTRON_RUN_AS_NODE_PATH: "/opt/Ash/ash",
		ASH_HOME: "/state",
		ASH_WORKSPACE_ROOT: "/workspace",
		ASH_DIR_GRANT_SOURCE: "userConfig",
		ASH_APP_SERVER_CONNECTION_ROLE: "agents",
		ASH_SSH_PATH: "/usr/bin/ssh",
	});
	assert.equal(isAllowedAppServerEnvironmentKey("OPENAI_API_KEY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ZCODE_DATA_BASE_DIR"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ZCODE_CREDENTIAL_SECRET"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_APP_SERVER_PATH"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_ELECTRON_RUN_AS_NODE_PATH"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_DIR_GRANT_SOURCE"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_APP_SERVER_CONNECTION_ROLE"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ASH_SSH_PATH"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ELECTRON_RUN_AS_NODE"), false);
});

test("App Server environment preserves the Linux clipboard display session", () => {
	const source = {
		HOME: "/home/ash",
		DISPLAY: ":1",
		WAYLAND_DISPLAY: "wayland-0",
		XAUTHORITY: "/home/ash/.Xauthority",
		XDG_RUNTIME_DIR: "/run/user/1000",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
	};
	for (const platform of ['linux', 'macos', 'windows'] as const) {
		for (const mode of ['desktop', 'web'] as const) {
			assert.deepEqual(buildAppServerEnvironment(source, platform, {}, mode), source);
		}
	}
	assert.equal(isAllowedAppServerEnvironmentKey("DISPLAY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("WAYLAND_DISPLAY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("XAUTHORITY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("DBUS_SESSION_BUS_ADDRESS"), true);
});

test("App Server environment canonicalizes Windows keys case-insensitively", () => {
	const environment = buildAppServerEnvironment({
		Path: "C:\\Windows\\System32",
		SystemRoot: "C:\\Windows",
		UserProfile: "C:\\Users\\ash",
		AWS_SECRET_ACCESS_KEY: "secret",
	}, "windows", {
		ASH_HOME: "C:\\state",
	}, "desktop");

	assert.equal(environment.PATH, "C:\\Windows\\System32");
	assert.equal(environment.SYSTEMROOT, "C:\\Windows");
	assert.equal(environment.USERPROFILE, "C:\\Users\\ash");
	assert.equal(environment.AWS_SECRET_ACCESS_KEY, "secret");
});

test("App Server product environment accepts only owned non-NUL variables", () => {
	assert.throws(() => buildAppServerEnvironment({}, "macos", { OPENAI_API_KEY: "secret" }, "desktop"), /Invalid App Server product environment variable/);
	assert.throws(() => buildAppServerEnvironment({}, "macos", { ASH_HOME: "bad\0path" }, "desktop"), /Invalid App Server product environment variable/);
});

test("App Server environment excludes host authentication and launcher controls without filtering ordinary tokens", () => {
	const source = {
		CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'host', node_repl_auth_token: 'host', CODEX_GUARDIAN_DECISIONS_API_KEY: 'host',
		OPENAI_FEDERATION_RULE_ID: 'host', OPENAI_IDENTITY_TOKEN_FILE: 'host', OPENAI_WORKLOAD_IDENTITY_CONTEXT: 'host',
		ELECTRON_RUN_AS_NODE: '1', GITHUB_TOKEN: 'developer', HTTPS_PROXY: 'http://localhost:8080',
		'BAD=NAME': 'invalid', 'EMPTY_VALUE': '', NULL_VALUE: 'invalid\0value', UNDEFINED_VALUE: undefined,
	};
	assert.deepEqual(buildAppServerEnvironment(source, 'macos', {}, 'desktop'), { GITHUB_TOKEN: 'developer', HTTPS_PROXY: 'http://localhost:8080', EMPTY_VALUE: '' });
	for (const key of Object.keys(source).filter(key => key !== 'GITHUB_TOKEN' && key !== 'HTTPS_PROXY' && !key.endsWith('VALUE'))) {
		assert.equal(isAllowedAppServerEnvironmentKey(key), false, key);
	}
});
