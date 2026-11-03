import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { registerRunResource, withProcessRun } from '../../processes.ts';

if (process.platform !== 'win32') throw new Error('The native Ash Desktop developer host requires Windows.');
const [workspaceArgument, ...extra] = process.argv.slice(2);
if (!workspaceArgument || extra.length) throw new Error('Usage: pnpm dev:desktop:native <workspace-directory>');
const workspace = resolve(workspaceArgument);
if (!(await stat(workspace)).isDirectory()) throw new Error('The workspace must be a directory.');

const root = resolve(import.meta.dirname, '../../..');
const target = join(root, '.build/native-desktop-build');
const manifest = join(root, 'app/Cargo.toml');

await withProcessRun(root, async (run, environment) => {
	const commands: ReadonlyArray<readonly [string, readonly string[], NodeJS.ProcessEnv]> = [
		[process.execPath, ['build/python.ts', '-B', 'build/prepare.py', '--javascript-runtime', 'packaged-node'], environment],
		[process.execPath, ['build/desktop/build.ts', 'web'], { ...environment, ASH_WEB_APP_SERVER: '1' }],
		['cargo', ['build', '--locked', '--manifest-path', manifest, '--target-dir', target], environment],
	];
	for (const [command, args, env] of commands) {
		const result = await run.command(command, args, env);
		if (result.code !== 0) {
			process.exitCode = result.code;
			return;
		}
	}

	const { authenticatedWebUrl, startWeb } = await import('../web.ts');
	const { developmentAshPackagePath } = await import('../runtimeStore.ts');
	const profile = join(environment.TEMP!, 'native-ash-profile');
	const productServicesPath = join(profile, 'product-services.json');
	await mkdir(join(profile, 'AppData', 'Local'), { recursive: true });
	await writeFile(productServicesPath, '{"schemaVersion":3}\n');
	const backendEnvironment = {
		...environment,
		HOME: profile,
		USERPROFILE: profile,
		CODEX_HOME: undefined,
		ASH_WEB_APP_SERVER_PROFILE: profile,
		ASH_WORKSPACE_ROOT: workspace,
		ASH_USE_INMEMORY_SECRETSTORAGE: '1',
		ASH_PRODUCT_SERVICES_PATH: productServicesPath,
	};
	const packageRoot = developmentAshPackagePath(root, 'packaged-node');
	const daemon = join(packageRoot, 'bin', 'ash-app-server-daemon.exe');
	const resource = await registerRunResource({ executable: daemon, profile }, environment.ASH_SMOKE_RUN_DIRECTORY);
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	try {
		// Fresh Windows profiles may need to copy the managed backend package before listening.
		web = await startWeb({ port: 0, assets: join(root, '.build/desktop/web/ash'), environment: backendEnvironment, preparedBackend: true, startupTimeoutMs: 120_000 });
		// Windows holds running executables open. Launch a run-owned copy so another preview can rebuild.
		const executable = join(environment.TEMP!, 'ash-native-desktop.exe');
		await copyFile(join(target, 'debug', 'ash-native-desktop.exe'), executable);
		const host = spawn(executable, [], {
			cwd: root,
			env: { ...environment, ASH_NATIVE_DESKTOP_PROFILE: join(environment.TEMP!, 'native-webview2') },
			stdio: ['pipe', 'inherit', 'inherit'],
			windowsHide: true,
		});
		const closed = once(host, 'exit');
		host.stdin.on('error', () => { /* Host exit reports a failed launch. */ });
		await run.own(host);
		host.stdin.end(authenticatedWebUrl(web.info) + '\n');
		const [code] = await closed;
		process.exitCode = code ?? 1;
	} finally {
		try {
			await web?.close();
		} finally {
			try {
				await promisify(execFile)(daemon, ['stop'], {
					env: { ...backendEnvironment, ASH_HOME: profile },
					windowsHide: true,
					timeout: 30_000,
				});
			} finally {
				await resource.dispose();
			}
		}
	}
});
