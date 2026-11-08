import { expect, test } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchPackagedDesktop } from '../../../automation/packagedDesktop.js';
import { exercisePackagedWorkbench } from '../../../automation/packagedWorkbench.js';
import { Workbench } from '../../../automation/workbench.js';

test('Desktop package disables the Main inspector, omits standalone Node and retains its Electron binding after quit and a TUI restart', { tag: ['@win32', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(120_000);
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a delivered Desktop bundle.');
	const bundlePath = resolve(bundle!);
	const resources = process.platform === 'darwin' ? join(bundlePath, 'Contents', 'Resources') : join(bundlePath, 'resources');
	const metadata = JSON.parse(await readFile(join(resources, 'ash-package.json'), 'utf8'));
	expect(metadata.javascriptRuntime.kind).toBe('hostProvidedNode');
	expect(metadata.components.node).toBeUndefined();
	for (const path of ['ash-resources/node', 'ash-resources/licenses/node']) {
		expect(await access(join(resources, path)).then(() => true, () => false)).toBe(false);
	}
	// Keep the profile/run socket below Windows AF_UNIX's address-length limit.
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
	const profile = join(userDataDirectory, 'profile');
	const workspaceDirectory = join(userDataDirectory, 'workspace');
	await mkdir(workspaceDirectory);
	await mkdir(profile, { recursive: true });
	await writeFile(join(profile, 'settings.json'), '{"update.policy":"never"}');
	const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	environment.ASH_HOME = profile;
	delete environment.ASH_DESKTOP_UI_ONLY;
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;
	const daemon = join(resources, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
	const carrierEnvironment: Record<string, string> = { ...environment, ASH_APP_SERVER_PATH: join(resources, metadata.entrypoint) };
	for (const name of ['ASH_ELECTRON_RUN_AS_NODE_PATH', 'ASH_ELECTRON_RUN_AS_NODE_SHA256', 'ASH_ELECTRON_RUNTIME_BINDING', 'ASH_ELECTRON_RUNTIME_AVAILABLE']) delete carrierEnvironment[name];
	const lifecycle = async (operation: string) => JSON.parse((await promisify(execFile)(daemon, [operation], { env: carrierEnvironment, timeout: 20_000, windowsHide: true })).stdout);
	// This scenario owns daemon cleanup so quitting Electron does not tear down the shared backend.
	let desktop: Awaited<ReturnType<typeof launchPackagedDesktop>> | undefined;
	try {
		desktop = await launchPackagedDesktop({ packagedBundle: bundlePath, startupTimeout: 60_000, userDataDirectory, profileDirectory: profile, workspaceDirectory, workspacePermissions: 'development', environment, extraArgs: ['--inspect-brk=127.0.0.1:0'] });
		const before = await lifecycle('version');
		expect(before.status).toBe('running');
		await desktop.quit();
		const afterQuit = await lifecycle('version');
		expect(afterQuit.pid).toBe(before.pid);
		const restarted = await lifecycle('restart');
		expect(restarted.status).toBe('restarted');
		expect(restarted.pid).not.toBe(before.pid);
		const directory = join(profile, 'app-server-packages', 'manifests');
		const selected = (await readdir(directory)).filter(name => /^\d{20}\.json$/u.test(name)).sort().at(-1)!;
		const selection = JSON.parse(await readFile(join(directory, selected), 'utf8'));
		expect(selection.formatVersion).toBe(1);
		expect(selection.installation.electronVersion).toBe(metadata.javascriptRuntime.electronVersion);
		const expectedExecutable = process.platform === 'darwin' ? join(bundlePath, 'Contents', 'MacOS', 'Ash') : join(bundlePath, 'Ash.exe');
		expect(selection.installation.executable).toBe(await realpath(expectedExecutable));
		expect(selection.installation.sha256).toMatch(/^[a-f0-9]{64}$/u);
	} finally {
		await desktop?.close();
		await lifecycle('stop');
		const absolute = await realpath(userDataDirectory);
		assert.equal(dirname(absolute), await realpath(tmpdir()));
		assert(absolute.startsWith(join(await realpath(tmpdir()), 'ash-')));
		await rm(absolute, { recursive: true, force: true });
	}
});

test('Desktop package saves files, renders Markdown, executes a terminal command and restarts with its bundled backend', { tag: ['@win32', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(120_000);
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Desktop bundle.');
	const bundlePath = resolve(bundle!);
	const installation = process.platform === 'darwin' ? dirname(bundlePath) : bundlePath;
	const resources = process.platform === 'darwin' ? join(bundlePath, 'Contents', 'Resources') : join(bundlePath, 'resources');
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	try {
		const userData = directory;
		const workspace = join(directory, 'workspace');
		await mkdir(workspace);
		await mkdir(join(userData, 'profile'), { recursive: true });
		await writeFile(join(userData, 'profile', 'settings.json'), '{"update.policy":"never"}');
		await writeFile(join(workspace, 'main.ts'), 'const release = 1;\n');
		const { version } = JSON.parse(await readFile(join(resources, 'app', 'package.json'), 'utf8'));
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 2;', testInfo, 'package');
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 3;', testInfo, 'restart');
	} finally {
		const absolute = await realpath(directory);
		assert.equal(dirname(absolute), await realpath(tmpdir()));
		assert(absolute.startsWith(join(await realpath(tmpdir()), 'ash-')));
		await rm(absolute, { recursive: true, force: true });
	}
});

test('macOS package launches with a Dock icon and opens a native window tab', { tag: ['@darwin'] }, async ({ }, testInfo) => {
	const bundle = process.env.ASH_PACKAGED_BUNDLE;
	test.skip(!bundle, 'Set ASH_PACKAGED_BUNDLE to a built Ash.app directory.');
	const bundlePath = resolve(bundle!);
	const userDataDirectory = testInfo.outputPath('user-data');
	const homeDirectory = join(userDataDirectory, 'home');
	const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	delete environment.ASH_DESKTOP_UI_ONLY;
	environment.ASH_HOME = join(userDataDirectory, 'profile');
	delete environment.ELECTRON_RUN_AS_NODE;
	delete environment.ASH_RENDERER_URL;
	const desktop = await launchPackagedDesktop({ packagedBundle: bundlePath, userDataDirectory, homeDirectory, environment, windowMode: 'active' });
	const { page } = desktop;
	try {
		const { stdout: activationPolicy } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
			'ObjC.import("AppKit"); function run(argv) { return $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])).activationPolicy; }',
			String(desktop.process.pid),
		]);
		expect(activationPolicy.trim()).toBe('0'); // NSApplicationActivationPolicyRegular has a Dock icon.
		await new Workbench(page).quickaccess.runCommand('workbench.action.newWindowTab');
		await expect.poll(() => page.context().pages().filter(candidate => /\/workbench\/workbench\.html(?:[?#].*)?$/u.test(candidate.url())).length).toBe(2);
	} finally {
		await desktop.close();
	}
});
