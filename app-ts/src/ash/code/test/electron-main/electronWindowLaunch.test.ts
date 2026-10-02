import { strict as assert } from "node:assert";
import { test } from "mocha";
import { electronWorkspaceLaunchArguments, parseElectronWindowLaunch, windowsCommandLine } from "../../electron-main/electronWindowLaunch.js";

test("packaged second-instance arguments retain the Workspace target without process-only switches", () => {
	assert.deepEqual(electronWorkspaceLaunchArguments({
		arguments: ["/Applications/Ash.app/Contents/MacOS/Ash", "--user-data-dir", "/tmp/ash", "--remote-ssh", "build", "--folder", "/srv/project"],
		packaging: "packaged",
		appPath: "/Applications/Ash.app/Contents/Resources/app.asar",
	}), ["--remote-ssh", "build", "--folder", "/srv/project"]);
});

test("development second-instance arguments remove Electron and the app entry", () => {
	assert.deepEqual(electronWorkspaceLaunchArguments({
		arguments: ["/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/repo/app-ts", "/repo/app-ts", "--folder", "/repo/project"],
		packaging: "development",
		appPath: "/repo/app-ts",
	}), ["--folder", "/repo/project"]);
});

test('development process switches before a custom entry do not turn the entry into a requested file', () => {
	assert.deepEqual(electronWorkspaceLaunchArguments({
		arguments: ['/electron', '--inspect=0', '--remote-debugging-port=0', '/tests/late-start.mjs', '--user-data-dir=/tmp/ash', '--goto', '/project/main.ts:2:4'],
		packaging: 'development',
		appPath: '/repo/app-ts',
	}), ['--inspect=0', '--remote-debugging-port=0', '--goto', '/project/main.ts:2:4']);
});

test('Windows relaunch commands preserve spaces, embedded quotes and trailing path separators', () => {
	assert.equal(windowsCommandLine(['C:\\Program Files\\Ash\\Ash.exe', '--user-data-dir=C:\\Ash profile\\', 'a"b', '--new-window']), '"C:\\Program Files\\Ash\\Ash.exe" "--user-data-dir=C:\\Ash profile\\\\" "a\\"b" "--new-window"');
});

test('Agents launches accept a project target and reject file, window and wait requests before startup', () => {
	const message = 'Invalid Agents launch';
	const launch = parseElectronWindowLaunch(['--agents-window', '--folder', 'C:\\project'], 'C:\\', message);
	assert.equal(launch.agentsWindow, true);
	assert.equal(launch.args.workspace?.path, 'C:\\project');
	for (const option of ['--wait', '--new-window', '--reuse-window', '--goto', 'file.txt']) {
		assert.throws(() => parseElectronWindowLaunch(['--agents-window', option], 'C:\\', message), { message });
	}
	assert.equal(parseElectronWindowLaunch(['--', '--agents-window'], 'C:\\', message).agentsWindow, false);
});
