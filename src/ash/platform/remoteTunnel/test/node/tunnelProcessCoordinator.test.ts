import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, LogLevel, NullLoggerService } from '../../../log/common/log.js';
import { INACTIVE_TUNNEL_MODE } from '../../common/remoteTunnel.js';
import { TunnelProcessCoordinator } from '../../node/tunnelProcessCoordinator.js';

suite('Inbound helper process lifecycle', () => {
	test('serializes replacement and closes the old child before reporting the new connection', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const directory = await mkdtemp(join(tmpdir(), 'ash-host-process-'));
		const executable = join(directory, 'helper');
		const workspace = join(directory, 'workspace');
		await mkdir(workspace);
		await writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs');
const relay = process.argv[process.argv.indexOf('--relay') + 1];
const root = process.env.ASH_WORKSPACE_ROOT;
fs.appendFileSync(root + '/lifecycle', 'start:' + relay + '\\n');
if (relay !== 'pending') process.stdout.write('__ASH_TUNNEL_STATUS__' + JSON.stringify({ relayHost: relay, relayPort: 43123, web: { endpoint: 'http://127.0.0.1:5174/', ticket: 'a'.repeat(64), pid: process.pid } }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => { fs.appendFileSync(root + '/lifecycle', 'stop:' + relay + '\\n'); process.exit(0); });
`);
		await chmod(executable, 0o700);
		using services = new InstantiationService(new ServiceCollection([ILogService, new NullLoggerService()]));
		using owner = services.createInstance(TunnelProcessCoordinator, { executable, backendExecutable: '/packaged/backend', sshExecutable: 'ssh', assets: '/assets', environment: process.env });
		const mode = (relay: string) => ({ active: true, asService: false, session: { providerId: 'ssh', sessionId: relay, accountLabel: relay } } as const);
		try {
			const events: string[] = [];
			using listener = owner.onDidMachineStatus(event => events.push(event.status.type));
			await owner.setRemoteAccess(mode('first'), LogLevel.Info, workspace);
			assert.deepEqual(events, ['connected']);
			await owner.setRemoteAccess(mode('second'), LogLevel.Info, workspace);
			await owner.setRemoteAccess(INACTIVE_TUNNEL_MODE, LogLevel.Info);
			assert.equal(await readFile(join(workspace, 'lifecycle'), 'utf8'), 'start:first\nstop:first\nstart:second\nstop:second\n');
			assert.equal(owner.getStatus().connectionState, 'disconnected');
			const started = new Promise<void>(resolve => {
				const subscription = owner.onDidOutput(() => { subscription.dispose(); resolve(); });
			});
			const pending = owner.setRemoteAccess(mode('pending'), LogLevel.Info, workspace);
			await started;
			await owner.setRemoteAccess(INACTIVE_TUNNEL_MODE, LogLevel.Info);
			await pending;
			assert.deepEqual(events, ['connected', 'connected']);
			assert.equal(owner.getStatus().connectionState, 'disconnected');
		} finally {
			await owner.setRemoteAccess(INACTIVE_TUNNEL_MODE, LogLevel.Info);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
