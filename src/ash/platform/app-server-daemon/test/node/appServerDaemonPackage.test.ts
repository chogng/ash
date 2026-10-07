import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "mocha";
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH } from '../../../../../../crates/app-server-protocol/schema/typescript/index.js';
import { appServerDaemonExecutablePath, packagedAppServerDaemonSha256, packagedAppServerSha256 } from '../../node/appServerDaemonPackage.js';
import { remoteExecutablePath } from '../../../remote/node/remotePackage.js';
import { createAppServerDaemonLauncher } from '../../electron-main/appServerDaemonLauncher.js';

test("development and production resolve the same canonical package entrypoint", () => {
	const workspace = mkdtempSync(join(tmpdir(), "ash-workspace-"));
	const appPath = join(workspace, ".");
	const build = "a".repeat(64);
	const developmentRoot = join(workspace, ".build", "runtime", "dev", "store-v1", developmentTarget(), "host-provided-node", "dev-small");
	mkdirSync(join(developmentRoot, "manifests"), { recursive: true });
	writeFileSync(join(developmentRoot, "manifests", "00000000000000000001.json"), JSON.stringify({ formatVersion: 1, sequence: 1, directory: `packages/0.1.0/${build}` }));
	try {
		const connection = createAppServerDaemonLauncher({
			packageLocation: { appPath, isPackaged: false, platform: 'linux', resourcesPath: '/installed/resources' },
			sourceEnvironment: {}, profileRoot: '/profile', electronExecutable: '/electron', role: 'workbench',
		});
		assert.deepStrictEqual({ executable: connection.launcher.executable, args: connection.launcher.options.args, backend: connection.launcher.environment.ASH_APP_SERVER_PATH, generationFile: connection.generationFile }, {
			executable: join(developmentRoot, 'packages', '0.1.0', build, 'bin', 'ash-app-server-daemon'),
			args: ['connect-selected'],
			backend: join(developmentRoot, 'packages', '0.1.0', build, 'bin', 'ash-app-server'),
			generationFile: undefined,
		});
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
			appPath: "/workspace",
			isPackaged: true,
			platform: "win32",
			resourcesPath: resolve("/installed/resources"),
		}),
		join(resolve("/installed/resources"), "bin", "ash-remote.exe"),
	);
	assert.equal(
		appServerDaemonExecutablePath({
			appPath: "/workspace",
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
		const metadata = {
			buildId: `sha256:${"b".repeat(64)}`,
			components: { appServerDaemon: { binarySha256: "a".repeat(64) }, appServer: { binarySha256: "c".repeat(64) } },
			entrypoint: "bin/ash-app-server.exe",
			layoutVersion: 2,
			protocol: {
				major: APP_SERVER_PROTOCOL_MAJOR,
				schemaHash: APP_SERVER_SCHEMA_HASH,
			},
			version: "1.2.3",
		};
		writeFileSync(join(resourcesPath, "ash-package.json"), JSON.stringify(metadata));
		assert.equal(packagedAppServerSha256({ appPath: "/workspace", isPackaged: true, platform: "win32", resourcesPath }), "c".repeat(64));
		assert.equal(packagedAppServerDaemonSha256({
			appPath: "/unused",
			expectedVersion: "1.2.3",
			isPackaged: true,
			platform: "win32",
			resourcesPath,
		}), "a".repeat(64));
		const incompatible = { ...metadata, protocol: { ...metadata.protocol, schemaHash: `sha256:${'0'.repeat(64)}` } };
		writeFileSync(join(resourcesPath, "ash-package.json"), JSON.stringify(incompatible));
		assert.throws(() => packagedAppServerSha256({ appPath: "/unused", isPackaged: true, platform: "win32", resourcesPath }), /Invalid Ash package metadata/);
	} finally {
		rmSync(resourcesPath, { recursive: true, force: true });
	}
});
