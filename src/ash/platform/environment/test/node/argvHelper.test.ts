import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseMainProcessArgv, windowsCommandLine } from '../../node/argvHelper.js';

test('memory credential storage is an explicit process flag and does not become a file request', async () => {
	const { parseLaunchArguments } = await import('../../node/argvHelper.js');
	const request = parseLaunchArguments(['--use-inmemory-secretstorage', '/project']);
	assert.equal(request.useInMemorySecretStorage, true);
	assert.deepEqual(request.paths, ['/project']);
	assert.equal(parseLaunchArguments([]).useInMemorySecretStorage, undefined);
	assert.throws(() => parseLaunchArguments(['--use-inmemory-secretstorage=false']), /does not accept a value/);
	assert.equal(parseLaunchArguments(['--', '--use-inmemory-secretstorage']).useInMemorySecretStorage, undefined);
});

test('packaged second-instance arguments retain the Workspace target without process-only switches', () => {
	assert.deepEqual(
		parseMainProcessArgv({
			arguments: [
				'/Applications/Ash.app/Contents/MacOS/Ash',
				'--user-data-dir',
				'/tmp/ash',
				'--remote-ssh',
				'build',
				'--folder',
				'/srv/project',
			],
			packaging: 'packaged',
			appPath: '/Applications/Ash.app/Contents/Resources/app.asar',
		}),
		['--remote-ssh', 'build', '--folder', '/srv/project'],
	);
});

test('development second-instance arguments remove Electron and the app entry', () => {
	assert.deepEqual(
		parseMainProcessArgv({
			arguments: [
				'/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
				'/repo',
				'/repo',
				'--folder',
				'/repo/project',
			],
			packaging: 'development',
			appPath: '/repo',
		}),
		['--folder', '/repo/project'],
	);
});

test('development process switches before a custom entry do not turn the entry into a requested file', () => {
	assert.deepEqual(
		parseMainProcessArgv({
			arguments: [
				'/electron',
				'--inspect=0',
				'--remote-debugging-port=0',
				'/tests/late-start.mjs',
				'--user-data-dir=/tmp/ash',
				'--goto',
				'/project/main.ts:2:4',
			],
			packaging: 'development',
			appPath: '/repo',
		}),
		['--inspect=0', '--remote-debugging-port=0', '--goto', '/project/main.ts:2:4'],
	);
});

test('Windows relaunch commands preserve spaces, embedded quotes and trailing path separators', () => {
	assert.equal(
		windowsCommandLine([
			'C:\\Program Files\\Ash\\Ash.exe',
			'--user-data-dir=C:\\Ash profile\\',
			'a"b',
			'--new-window',
		]),
		'"C:\\Program Files\\Ash\\Ash.exe" "--user-data-dir=C:\\Ash profile\\\\" "a\\"b" "--new-window"',
	);
});

for (const packaging of ['development', 'packaged'] as const) {
	test(`${packaging} launches keep macOS recovery preferences separate from requested files`, () => {
		assert.deepEqual(
			parseMainProcessArgv({
				arguments: [
					'/electron',
					...(packaging === 'development' ? ['/repo'] : []),
					'-ApplePersistenceIgnoreState',
					'YES',
					'--folder=/project',
					'/project/main.ts',
				],
				packaging,
				appPath: '/repo',
			}),
			['--folder=/project', '/project/main.ts'],
		);
	});
}

test('launch log flags consume their values without becoming file requests', async () => {
	const { parseLaunchArguments } = await import('../../node/argvHelper.js');
	const result = parseLaunchArguments(['--log', 'debug', '--log=Publisher.Extension=trace', '--verbose', '/project']);
	assert.deepEqual(result.log, ['debug', 'Publisher.Extension=trace']);
	assert.equal(result.verbose, true);
	assert.deepEqual(result.paths, ['/project']);
	assert.throws(() => parseLaunchArguments(['--log']), /requires a value/);
});

test('development startup preserves a log value before the application entry', () => {
	assert.deepEqual(
		parseMainProcessArgv({
			arguments: ['/electron', '--log', 'debug', '/repo', '/project'],
			packaging: 'development',
			appPath: '/repo',
		}),
		['--log', 'debug', '/project'],
	);
});
