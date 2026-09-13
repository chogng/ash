import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "mocha";
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_SCHEMA_HASH } from "../../../../../../generated/app-server/index.js";
import { appServerDaemonExecutablePath, packagedAppServerDaemonSha256, packagedAppServerSha256, remoteExecutablePath } from "../../../../platform/app-server/electron-main/appServerPackage.js";

test("development and production resolve the same canonical package entrypoint", () => {
	const workspace = mkdtempSync(join(tmpdir(), "ash-workspace-"));
	const appPath = join(workspace, "ash-ts");
	const build = "a".repeat(64);
	const developmentRoot = join(workspace, ".build", "ash-package", "dev", "store-v1", developmentTarget(), "host-provided-node", "dev-small");
	mkdirSync(join(developmentRoot, "manifests"), { recursive: true });
	writeFileSync(join(developmentRoot, "manifests", "00000000000000000001.json"), JSON.stringify({ formatVersion: 1, sequence: 1, directory: `packages/0.1.0/${build}` }));
	try {
		assert.equal(
			appServerDaemonExecutablePath({
				appPath,
				isPackaged: false,
				platform: "linux",
				resourcesPath: "/installed/resources",
			}),
			join(developmentRoot, "packages", "0.1.0", build, "bin", "ash-app-server-daemon"),
		);
		assert.equal(
			remoteExecutablePath({
				appPath,
				isPackaged: false,
				platform: "linux",
				resourcesPath: "/installed/resources",
			}),
			join(developmentRoot, "packages", "0.1.0", build, "bin", "ash-remote"),
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
	assert.equal(
		remoteExecutablePath({
			appPath: "/workspace/ash-ts",
			isPackaged: true,
			platform: "win32",
			resourcesPath: resolve("/installed/resources"),
		}),
		join(resolve("/installed/resources"), "bin", "ash-remote.exe"),
	);
	assert.equal(
		appServerDaemonExecutablePath({
			appPath: "/workspace/ash-ts",
			isPackaged: true,
			platform: "win32",
			resourcesPath: resolve("/installed/resources"),
		}),
		join(resolve("/installed/resources"), "bin", "ash-app-server-daemon.exe"),
	);
});

function developmentTarget(): string {
	const targets: Readonly<Record<string, string>> = {
		'darwin-arm64': 'aarch64-apple-darwin',
		'darwin-x64': 'x86_64-apple-darwin',
		'linux-arm64': 'aarch64-unknown-linux-gnu',
		'linux-x64': 'x86_64-unknown-linux-gnu',
		'win32-arm64': 'aarch64-pc-windows-msvc',
		'win32-x64': 'x86_64-pc-windows-msvc',
	};
	return targets[`${process.platform}-${process.arch}`];
}

test("packaged server host digest is bound to the canonical package entrypoint", () => {
	const resourcesPath = mkdtempSync(join(tmpdir(), "ash-package-"));
	try {
		writeFileSync(join(resourcesPath, "ash-package.json"), JSON.stringify({
			buildId: `sha256:${"b".repeat(64)}`,
			components: { appServerDaemon: { binarySha256: "a".repeat(64) }, appServer: { binarySha256: "c".repeat(64) } },
			entrypoint: "bin/ash-app-server.exe",
			layoutVersion: 2,
			protocol: {
				major: APP_SERVER_PROTOCOL_MAJOR,
				revision: APP_SERVER_PROTOCOL_REVISION,
				schemaHash: APP_SERVER_SCHEMA_HASH,
			},
			version: "1.2.3",
		}));
		assert.equal(packagedAppServerSha256({ appPath: "/workspace/ash-ts", isPackaged: true, platform: "win32", resourcesPath }), "c".repeat(64));
		assert.equal(packagedAppServerDaemonSha256({
			appPath: "/unused",
			expectedVersion: "1.2.3",
			isPackaged: true,
			platform: "win32",
			resourcesPath,
		}), "a".repeat(64));
	} finally {
		rmSync(resourcesPath, { recursive: true, force: true });
	}
});
