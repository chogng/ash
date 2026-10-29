import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_SCHEMA_HASH } from '../../../../../../.build/protocol/typescript/index.js';
import { AppServerDaemonLauncher, createAppServerDaemonLauncher } from '../../electron-main/appServerDaemonLauncher.js';

test('packaged daemon connections use verified binaries and an explicit workspace environment', async () => {
	const resourcesPath = mkdtempSync(join(tmpdir(), 'ash-daemon-package-'));
	try {
		const daemonContents = 'packaged daemon';
		const backendContents = 'packaged backend';
		mkdirSync(join(resourcesPath, 'bin'));
		writeFileSync(join(resourcesPath, 'bin', 'ash-app-server-daemon'), daemonContents);
		writeFileSync(join(resourcesPath, 'bin', 'ash-app-server'), backendContents);
		const daemonDigest = digest(daemonContents);
		const backendDigest = digest(backendContents);
		writeFileSync(
			join(resourcesPath, 'ash-package.json'),
			JSON.stringify({
				buildId: `sha256:${'b'.repeat(64)}`,
				components: {
					appServerDaemon: { binarySha256: daemonDigest },
					appServer: { binarySha256: backendDigest },
				},
				entrypoint: 'bin/ash-app-server',
				layoutVersion: 2,
				protocol: { major: APP_SERVER_PROTOCOL_MAJOR, schemaHash: APP_SERVER_SCHEMA_HASH },
				version: '1.2.3',
			}),
		);
		const { launcher, generationFile } = createAppServerDaemonLauncher({
			packageLocation: {
				appPath: '/unused',
				expectedVersion: '1.2.3',
				isPackaged: true,
				platform: 'linux',
				resourcesPath,
			},
			sourceEnvironment: {
				AI_AGENT: 'enclosing-agent',
				PATH: '/bin',
				DISPLAY: ':0',
				ASH_DEV_APP_SERVER_RELOAD: '1',
				ASH_RG_PATH: '/package/rg',
				ASH_PRODUCT_SERVICES_PATH: '/product/services.json',
				API_SECRET: 'private',
				ASH_HOME: '/ignored',
				ASH_WORKSPACE_ROOT: '/ignored',
			},
			profileRoot: '/selected/profile',
			electronExecutable: '/electron',
			workspaceRoot: '/selected/workspace',
			role: 'workbench',
		});
		using ownedLauncher = launcher;
		assert.deepStrictEqual(
			{
				executable: launcher.executable,
				args: launcher.options.args,
				environment: launcher.environment,
				generationFile,
			},
			{
				executable: join(resourcesPath, 'bin', 'ash-app-server-daemon'),
				args: ['connect'],
				environment: {
					PATH: '/bin',
					DISPLAY: ':0',
					API_SECRET: 'private',
					ASH_DEV_APP_SERVER_RELOAD: '1',
					ASH_ELECTRON_RUN_AS_NODE_PATH: '/electron',
					ASH_APP_SERVER_PATH: join(resourcesPath, 'bin', 'ash-app-server'),
					ASH_HOME: '/selected/profile',
					ASH_RG_PATH: '/package/rg',
					ASH_PRODUCT_SERVICES_PATH: '/product/services.json',
					ASH_APP_SERVER_SHA256: backendDigest,
					ASH_WORKSPACE_ROOT: '/selected/workspace',
					ASH_DIR_GRANT_SOURCE: 'userConfig',
				},
				generationFile: undefined,
			},
		);
		await launcher.validate();
		writeFileSync(launcher.executable, 'changed daemon');
		await assert.rejects(launcher.validate(), /integrity validation/);
		assert.throws(
			() =>
				createAppServerDaemonLauncher({
					packageLocation: {
						appPath: '/unused',
						expectedVersion: '9.9.9',
						isPackaged: true,
						platform: 'linux',
						resourcesPath,
					},
					sourceEnvironment: {},
					profileRoot: '/profile',
					electronExecutable: '/electron',
					role: 'workbench',
				}),
			/Invalid Ash package metadata/,
		);
	} finally {
		rmSync(resourcesPath, { recursive: true, force: true });
	}
});

test('Agents daemon connections identify their role without a workspace grant', () => {
	const resourcesPath = mkdtempSync(join(tmpdir(), 'ash-agents-package-'));
	try {
		writeFileSync(
			join(resourcesPath, 'ash-package.json'),
			JSON.stringify({
				buildId: `sha256:${'b'.repeat(64)}`,
				components: {
					appServerDaemon: { binarySha256: 'a'.repeat(64) },
					appServer: { binarySha256: 'c'.repeat(64) },
				},
				entrypoint: 'bin/ash-app-server.exe',
				layoutVersion: 2,
				protocol: { major: APP_SERVER_PROTOCOL_MAJOR, schemaHash: APP_SERVER_SCHEMA_HASH },
				version: '1.2.3',
			}),
		);
		const { launcher } = createAppServerDaemonLauncher({
			packageLocation: { appPath: '/unused', isPackaged: true, platform: 'win32', resourcesPath },
			sourceEnvironment: {
				AI_AGENT: 'enclosing-agent',
				ai_agent: 'other-agent',
				Path: 'C:\\Windows',
				DISPLAY: ':0',
				ASH_WORKSPACE_ROOT: '/ignored',
			},
			profileRoot: '/profile',
			electronExecutable: '/electron',
			role: 'agents',
		});
		using ownedLauncher = launcher;
		assert.deepStrictEqual(
			{ executable: launcher.executable, environment: launcher.environment },
			{
				executable: join(resourcesPath, 'bin', 'ash-app-server-daemon.exe'),
				environment: {
					PATH: 'C:\\Windows',
					DISPLAY: ':0',
					ASH_WORKSPACE_ROOT: '/ignored',
					ASH_ELECTRON_RUN_AS_NODE_PATH: '/electron',
					ASH_APP_SERVER_PATH: join(resourcesPath, 'bin', 'ash-app-server.exe'),
					ASH_HOME: '/profile',
					ASH_APP_SERVER_SHA256: 'c'.repeat(64),
					ASH_APP_SERVER_CONNECTION_ROLE: 'agents',
				},
			},
		);
	} finally {
		rmSync(resourcesPath, { recursive: true, force: true });
	}
});

test('a daemon launcher starts a connection carrier with its selected environment', () => {
	let launched: unknown;
	using launcher = new AppServerDaemonLauncher({
		executable: '/package/ash-app-server-daemon',
		args: ['connect-selected'],
		environment: { ASH_HOME: '/profile', ASH_APP_SERVER_PATH: '/backend/old' },
		spawnProcess: (executable, args, options) => {
			launched = { executable, args, options };
			return {} as ReturnType<AppServerDaemonLauncher['launch']>;
		},
	});
	launcher.replaceEnvironment({ ASH_HOME: '/profile', ASH_APP_SERVER_PATH: '/backend/new' });
	launcher.launch();
	assert.deepStrictEqual(launched, {
		executable: '/package/ash-app-server-daemon',
		args: ['connect-selected'],
		options: { environment: { ASH_HOME: '/profile', ASH_APP_SERVER_PATH: '/backend/new' } },
	});
});

function digest(contents: string): string {
	return createHash('sha256').update(contents).digest('hex');
}

test('startup tracing assigns distinct carrier identities without mutating the launcher environment', () => {
	const environments: Readonly<Record<string, string>>[] = [];
	using launcher = new AppServerDaemonLauncher({
		executable: '/package/ash-app-server-daemon',
		args: ['connect-selected'],
		environment: {
			ASH_DESKTOP_STARTUP_TRACE: '1',
			ASH_DESKTOP_STARTUP_TRACE_ID: 'stale',
			ASH_DESKTOP_STARTUP_TRACE_CARRIER_PID: '123',
		},
		spawnProcess: (_executable, _args, options) => {
			environments.push(options.environment);
			return {} as ReturnType<AppServerDaemonLauncher['launch']>;
		},
	});
	launcher.launch();
	launcher.launch();
	for (const environment of environments) {
		assert.match(environment.ASH_DESKTOP_STARTUP_TRACE_ID, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
		assert.equal(environment.ASH_DESKTOP_STARTUP_TRACE_CARRIER_PID, undefined);
	}
	assert.notEqual(environments[0].ASH_DESKTOP_STARTUP_TRACE_ID, environments[1].ASH_DESKTOP_STARTUP_TRACE_ID);
	assert.equal(launcher.environment.ASH_DESKTOP_STARTUP_TRACE_ID, 'stale');
	launcher.replaceEnvironment({
		ASH_DESKTOP_STARTUP_TRACE_ID: 'stale',
		ASH_DESKTOP_STARTUP_TRACE_CARRIER_PID: '123',
	});
	launcher.launch();
	assert.deepEqual(environments[2], {});
});
