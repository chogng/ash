import assert from "node:assert/strict";
import { test } from "mocha";
import { buildAppServerEnvironment, isAllowedAppServerEnvironmentKey } from "../../../../platform/app-server/common/appServerEnvironment.js";

test("App Server environment keeps safe POSIX session variables and excludes credentials", () => {
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
		ASH_APP_SERVER_PATH: "/opt/Ash/ash-app-server-daemon",
		ASH_ELECTRON_RUN_AS_NODE_PATH: "/opt/Ash/ash",
		ASH_HOME: "/state",
		ASH_WORKSPACE_ROOT: "/workspace",
		ASH_DIR_GRANT_SOURCE: "userConfig",
		ASH_APP_SERVER_CONNECTION_ROLE: "agents",
		ASH_SSH_PATH: "/usr/bin/ssh",
	});
	assert.equal(isAllowedAppServerEnvironmentKey("OPENAI_API_KEY"), false);
	assert.equal(isAllowedAppServerEnvironmentKey("ZCODE_DATA_BASE_DIR"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("ZCODE_CREDENTIAL_SECRET"), false);
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
	assert.deepEqual(buildAppServerEnvironment(source, "linux", {}, "desktop"), {
		HOME: "/home/ash",
		XDG_RUNTIME_DIR: "/run/user/1000",
		DISPLAY: ":1",
		WAYLAND_DISPLAY: "wayland-0",
		XAUTHORITY: "/home/ash/.Xauthority",
	});
	assert.deepEqual(buildAppServerEnvironment(source, "linux", {}, "web"), {
		HOME: "/home/ash",
		XDG_RUNTIME_DIR: "/run/user/1000",
	});
	assert.equal(buildAppServerEnvironment(source, "macos", {}, "desktop").DISPLAY, undefined);
	assert.equal(buildAppServerEnvironment(source, "windows", {}, "desktop").DISPLAY, undefined);
	assert.equal(isAllowedAppServerEnvironmentKey("DISPLAY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("WAYLAND_DISPLAY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("XAUTHORITY"), true);
	assert.equal(isAllowedAppServerEnvironmentKey("DBUS_SESSION_BUS_ADDRESS"), false);
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
	assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
});

test("App Server product environment accepts only owned non-NUL variables", () => {
	assert.throws(() => buildAppServerEnvironment({}, "macos", { OPENAI_API_KEY: "secret" }, "desktop"), /Invalid App Server product environment variable/);
	assert.throws(() => buildAppServerEnvironment({}, "macos", { ASH_HOME: "bad\0path" }, "desktop"), /Invalid App Server product environment variable/);
});
