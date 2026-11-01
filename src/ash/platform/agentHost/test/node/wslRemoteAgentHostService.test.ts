import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'mocha';
import { WSLRemoteAgentHostService } from '../../node/wslRemoteAgentHostService.js';

test('WSL discovery preserves distro names across UTF-16 and localized multiword status, and filters WSL 1', async () => {
	const commands: readonly string[][] = [];
	const service = new WSLRemoteAgentHostService('win32', {
		list: async args => {
			(commands as string[][]).push([...args]);
			return Buffer.from(args[1] === '--quiet' ? 'Ubuntu Dev\r\nUbuntu\r\n旧发行版\r\n' : '  NAME            STATE          VERSION\r\n* Ubuntu Dev      Em execução    2\r\n  Ubuntu          已停止          1\r\n  旧发行版        已停止          1\r\n', 'utf16le');
		},
		launch: () => { throw new Error('Discovery must not launch a runtime'); },
	});
	assert.deepEqual(await service.listDistros(), ['Ubuntu Dev']);
	assert.deepEqual(commands, [['--list', '--quiet'], ['--list', '--verbose']]);
});

test('WSL launch validates the installed distribution and supplies literal process arguments', async () => {
	let args: readonly string[] | undefined;
	const service = new WSLRemoteAgentHostService('win32', {
		list: async params => Buffer.from(params[1] === '--quiet' ? 'Ubuntu Dev\n' : '* Ubuntu Dev Running 2\n'),
		launch: input => { args = input; return {} as ChildProcessWithoutNullStreams; },
	});
	const target = { type: 'wsl' as const, distro: 'Ubuntu Dev', name: 'Ubuntu', workspace: '/home/me/a $(touch x)' };
	const launcher = service.createProcessLauncher(target);
	await launcher.validate();
	launcher.launch();
	assert.deepEqual(args, ['--distribution', 'Ubuntu Dev', '--exec', 'env', 'ASH_WORKSPACE_ROOT=/home/me/a $(touch x)', 'ash-remote-server', 'connect']);
	await assert.rejects(service.createProcessLauncher({ ...target, distro: 'Removed distro' }).validate(), /unavailable/);
});

test('non-Windows hosts expose no WSL targets and cannot launch a selected distro', async () => {
	const service = new WSLRemoteAgentHostService('darwin', { list: async () => { throw new Error('Must not invoke WSL'); }, launch: () => { throw new Error('Must not launch'); } });
	assert.deepEqual(await service.listDistros(), []);
	await assert.rejects(service.createProcessLauncher({ type: 'wsl', name: 'Ubuntu', distro: 'Ubuntu', workspace: '/repo' }).validate(), /unavailable/);
});
