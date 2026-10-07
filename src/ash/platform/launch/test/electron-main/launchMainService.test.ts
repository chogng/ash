import assert from 'node:assert/strict';
import { test } from 'mocha';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLaunchArguments } from '../../../environment/node/argvHelper.js';
import { WorkspaceOpenTargetKind } from '../../../environment/common/argv.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IWindowsMainService, type IOpenConfiguration } from '../../../windows/electron-main/windows.js';
import { LaunchMainService, parseWindowLaunch } from '../../electron-main/launchMainService.js';

test('launch parsing separates files, project options, window policy and literal filenames', () => {
	assert.deepEqual(parseLaunchArguments(['--folder', 'project', '--reuse-window', '--goto', 'one.ts:2:7', 'two.ts', '--', '-literal']), {
		paths: ['one.ts:2:7', 'two.ts', '-literal'], urls: [], workspace: { kind: WorkspaceOpenTargetKind.Folder, path: 'project' }, newWindow: false, reuseWindow: true, goto: true, wait: false, waitMarkerFilePath: undefined,
	});
	assert.throws(() => parseLaunchArguments(['-n', '-r']), /cannot be combined/);
	assert.throws(() => parseLaunchArguments(['--waitMarkerFilePath=x']), /requires --wait/);
	assert.throws(() => parseLaunchArguments(['--open-url=https://example.com']), /Unsupported launch URL/);
	const callback = 'ash://publisher.extension/callback?state=a%26b&windowId=7';
	assert.deepEqual(parseLaunchArguments(['--open-url', '--', callback]).urls, [callback]);
	assert.deepEqual(parseLaunchArguments([`--open-url=${callback}`]).paths, []);
	const uri = pathToFileURL(join(tmpdir(), 'space name.ts'));
	assert.deepEqual(parseLaunchArguments(['--open-url', '--', uri.href]).paths, [join(tmpdir(), 'space name.ts')]);
	assert.deepEqual(parseLaunchArguments([`--open-url=ash://file${uri.pathname}:2:7`]).paths, [join(tmpdir(), 'space name.ts') + ':2:7']);
	const routedFile = `ash://file${uri.pathname}:2:7?windowId=7`;
	assert.deepEqual(parseLaunchArguments([`--open-url=${routedFile}`]).urls, [routedFile]);
});

test('launch creation requires the window service and resolves folders and file positions through it', async () => {
	using missingServices = new InstantiationService();
	assert.throws(() => missingServices.createInstance(LaunchMainService), /windowsMainService/);
	const root = await mkdtemp(join(tmpdir(), 'ash-launch-'));
	try {
		await mkdir(join(root, 'project'));
		await writeFile(join(root, 'one.ts'), 'first\nsecond');
		let opened: IOpenConfiguration | undefined;
		using services = new InstantiationService();
		services.registerInstance(IWindowsMainService, {
			open: async configuration => {
				opened = configuration;
				return { whenClosed: Promise.resolve(), whenFilesClosed: Promise.resolve() };
			}
		});
		using launch = services.createInstance(LaunchMainService);
		await launch.start({ args: parseLaunchArguments(['project', '-g', 'one.ts:2:3']), cwd: root });
		assert.deepEqual(opened, {
			workspace: { kind: WorkspaceOpenTargetKind.Folder, path: join(root, 'project') }, cwd: root, files: [{ uri: pathToFileURL(join(root, 'one.ts')).href, line: 2, column: 3 }], forceNewWindow: false, forceReuseWindow: false, waitForFiles: false,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('waiting launches release their marker after file completion, failure or application disposal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-launch-'));
	try {
		let finish!: () => void;
		using services = new InstantiationService();
		services.registerInstance(IWindowsMainService, { open: async () => ({ whenClosed: new Promise<void>(() => { }), whenFilesClosed: new Promise<void>(resolve => { finish = resolve; }) }) });
		using launch = services.createInstance(LaunchMainService);
		const marker = join(root, 'marker');
		await writeFile(marker, '');
		const request = { args: parseLaunchArguments(['--wait', `--waitMarkerFilePath=${marker}`, 'one.ts']), cwd: root };
		await launch.start(request);
		await access(marker);
		finish();
		await new Promise<void>(resolve => setImmediate(resolve));
		await assert.rejects(access(marker), { code: 'ENOENT' });
		await writeFile(marker, '');
		await launch.start(request);
		launch.dispose();
		await assert.rejects(access(marker), { code: 'ENOENT' });
		using failingServices = new InstantiationService();
		failingServices.registerInstance(IWindowsMainService, { open: async () => { throw new Error('Open failed'); } });
		using failing = failingServices.createInstance(LaunchMainService);
		await writeFile(marker, '');
		await assert.rejects(failing.start(request), /Open failed/);
		await assert.rejects(access(marker), { code: 'ENOENT' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Agents launches accept a project target and reject file, window and wait requests before startup', () => {
	const message = 'Invalid Agents launch';
	const launch = parseWindowLaunch(['--agents-window', '--folder', 'C:\\project'], 'C:\\', message);
	assert.equal(launch.agentsWindow, true);
	assert.equal(launch.args.workspace?.path, 'C:\\project');
	for (const option of ['--wait', '--new-window', '--reuse-window', '--goto', 'file.txt']) {
		assert.throws(() => parseWindowLaunch(['--agents-window', option], 'C:\\', message), { message });
	}
	assert.equal(parseWindowLaunch(['--', '--agents-window'], 'C:\\', message).agentsWindow, false);
});
