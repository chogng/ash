/** Exercises Desktop's real bootstrap with local or published packages and an isolated SSH host. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { buildAppServerEnvironment } from '../../src/ash/platform/agentHost/common/appServerEnvironment.js';
import { checkAppServerInitializeCompatibility } from '../../src/ash/platform/agentHost/common/appServerProtocolCompatibility.js';
import { decodeAppServerResult } from '../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { AppServerDaemonLauncher } from '../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { createSshRemoteWorkspaceUri } from '../../src/ash/platform/remote/common/remote.js';
import { RemoteConnectionProfiles } from '../../src/ash/platform/remote/electron-main/remoteConnectionProfiles.js';
import { RemoteRuntimeBootstrapMainService } from '../../src/ash/platform/remote/electron-main/remoteRuntimeBootstrapMainService.js';
import { RemoteRuntimeProvisioner } from '../../src/ash/platform/remote/electron-main/remoteRuntimeProvisioner.js';

const { values } = parseArgs({
	options: Object.fromEntries(
		['package', 'binding', 'catalog-dir', 'ssh', 'host', 'root', 'report'].map(name => [
			name,
			{ type: 'string' as const },
		]),
	),
});
for (const name of ['package', 'ssh', 'host', 'root', 'report']) assert(values[name], `--${name} is required`);
assert(Boolean(values.binding) !== Boolean(values['catalog-dir']), 'select --binding or --catalog-dir');
const packageRoot = resolve(values.package!);
const root = resolve(values.root!);
const ssh = resolve(values.ssh!);
const host = values.host!;
await mkdir(root, { recursive: true });
const workspace = join(root, 'workspace');
await mkdir(workspace);
const metadata = JSON.parse(await readFile(join(packageRoot, 'ash-package.json'), 'utf8'));
const catalogRoot = values['catalog-dir'] === undefined ? undefined : resolve(values['catalog-dir']);
const release =
	values.binding === undefined ? { protocol: metadata.protocol } : JSON.parse(await readFile(values.binding, 'utf8'));
assert.deepEqual(release.protocol, metadata.protocol);
const environment = buildAppServerEnvironment(
	process.env,
	process.platform === 'darwin' ? 'macos' : 'linux',
	{
		ASH_HOME: join(root, 'local-profile'),
		ASH_APP_SERVER_PATH: join(packageRoot, 'bin/ash-app-server'),
		ASH_SSH_PATH: ssh,
	},
	'desktop',
);
const remoteExecutable = join(packageRoot, 'bin/ash-remote');
const profiles = new RemoteConnectionProfiles({ remoteExecutable, environment });
assert.equal(await profiles.get(host, workspace), undefined);
const progress: Array<{ phase: string; disposition?: string }> = [];
let installed: string | undefined;
try {
	for (const reconnect of [false, true]) {
		const count = progress.length;
		const carrier = new AppServerDaemonLauncher({
			executable: join(packageRoot, 'bin/ash-app-server-daemon'),
			args: ['connect-selected'],
			environment,
		});
		const provisioner = new RemoteRuntimeProvisioner({
			source:
				catalogRoot === undefined
					? {
							kind: 'network',
							catalogUrl: release.catalog.url,
							expectedSha256: release.catalog.sha256,
							cacheRoot: join(root, 'cache'),
						}
					: {
							kind: 'packaged',
							bundleRoot: catalogRoot,
							expectedSha256: createHash('sha256')
								.update(await readFile(join(catalogRoot, 'catalog.json')))
								.digest('hex'),
						},
			remoteExecutable,
			sshExecutable: ssh,
			environment,
			installRoot: join(root, 'remote-installation'),
		});
		const bootstrap = new RemoteRuntimeBootstrapMainService({
			workspace: createSshRemoteWorkspaceUri(host, workspace),
			sshExecutable: ssh,
			remoteExecutable: 'ash-release-acceptance-deliberately-missing',
			localEnvironment: environment,
			carrier,
			runtimeInstaller: provisioner,
			connectionProfiles: profiles,
			logProgress: event => progress.push(event),
		});
		try {
			await bootstrap.processLauncher.validate();
			if (reconnect) assert.equal(progress.length, count, 'reconnect must not provision or download');
			else {
				assert(progress.some(event => event.phase === 'complete' && event.disposition === 'installed'));
				if (catalogRoot === undefined)
					assert(
						progress.some(
							event => event.phase === 'downloadComplete' && event.disposition === 'downloaded',
						),
					);
			}
			const child = bootstrap.processLauncher.launch();
			const closed = new Promise<void>((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`carrier exited ${code}`))));
			});
			void closed.catch(() => {});
			let stderr = '';
			child.stderr.on('data', chunk => {
				stderr = (stderr + chunk).slice(-65536);
			});
			const replies = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
			const lines = createInterface({ input: child.stdout });
			lines.on('line', line => {
				const message = JSON.parse(line);
				const pending = replies.get(message.id);
				if (!pending) return;
				replies.delete(message.id);
				if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
				else pending.resolve(message.result);
			});
			let id = 0;
			async function rpc(method: string, params: object): Promise<any> {
				const key = ++id;
				let timer: ReturnType<typeof setTimeout>;
				try {
					return await new Promise((resolve, reject) => {
						timer = setTimeout(() => reject(new Error(`${method} timeout: ${stderr}`)), 40_000);
						replies.set(key, { resolve, reject });
						child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`);
					});
				} finally {
					clearTimeout(timer!);
					replies.delete(key);
				}
			}
			try {
				const initialized = checkAppServerInitializeCompatibility(
					decodeAppServerResult(
						'initialize',
						await rpc('initialize', {
							clientInfo: { name: 'desktop-release-acceptance', version: '1' },
							capabilities: {},
						}),
					),
					{ expectedServerName: 'ash-app-server' },
				);
				assert.equal(initialized.protocolVersion.major, release.protocol.major);
				assert.equal(initialized.schemaHash, release.protocol.schemaHash);
				await bootstrap.processLauncher.didInitialize();
				const selected = await profiles.get(host, workspace);
				assert(selected);
				if (reconnect) assert.equal(selected.activeRuntime, installed);
				else {
					installed = selected.activeRuntime;
					await rpc('fs/writeFile', { path: 'release-edit.txt', content: 'published-remote-edit-ok' });
				}
				assert.equal(
					(await rpc('fs/readFile', { path: 'release-edit.txt' })).content,
					'published-remote-edit-ok',
				);
			} finally {
				child.stdin.end();
				const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
				try {
					await closed;
				} finally {
					clearTimeout(timer);
					lines.close();
				}
			}
		} finally {
			bootstrap.dispose();
			carrier.dispose();
		}
	}
	assert(installed);
	const report = {
		status: 'passed',
		catalog: release.catalog,
		protocol: release.protocol,
		runtime: installed,
		firstConnectionAutomaticallyInstalled: true,
		firstConnectionAutomaticallyDownloaded: catalogRoot === undefined,
		reconnectReusedActiveRuntimeWithoutProvisioning: true,
		editingSurvivedReconnect: true,
		productionDesktopBootstrap: true,
		transport: 'OpenSSH',
		progress,
	};
	await writeFile(values.report!, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report));
} finally {
	await promisify(execFile)(join(packageRoot, 'bin/ash-app-server-daemon'), ['stop'], {
		env: environment,
		timeout: 30_000,
	});
}
