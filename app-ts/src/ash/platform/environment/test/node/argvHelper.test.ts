import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseMainProcessArgv, windowsCommandLine } from '../../node/argvHelper.js';

test("packaged second-instance arguments retain the Workspace target without process-only switches", () => {
	assert.deepEqual(parseMainProcessArgv({
		arguments: ["/Applications/Ash.app/Contents/MacOS/Ash", "--user-data-dir", "/tmp/ash", "--remote-ssh", "build", "--folder", "/srv/project"],
		packaging: "packaged",
		appPath: "/Applications/Ash.app/Contents/Resources/app.asar",
	}), ["--remote-ssh", "build", "--folder", "/srv/project"]);
});

test("development second-instance arguments remove Electron and the app entry", () => {
	assert.deepEqual(parseMainProcessArgv({
		arguments: ["/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/repo/app-ts", "/repo/app-ts", "--folder", "/repo/project"],
		packaging: "development",
		appPath: "/repo/app-ts",
	}), ["--folder", "/repo/project"]);
});

test('development process switches before a custom entry do not turn the entry into a requested file', () => {
	assert.deepEqual(parseMainProcessArgv({
		arguments: ['/electron', '--inspect=0', '--remote-debugging-port=0', '/tests/late-start.mjs', '--user-data-dir=/tmp/ash', '--goto', '/project/main.ts:2:4'],
		packaging: 'development',
		appPath: '/repo/app-ts',
	}), ['--inspect=0', '--remote-debugging-port=0', '--goto', '/project/main.ts:2:4']);
});

test('Windows relaunch commands preserve spaces, embedded quotes and trailing path separators', () => {
	assert.equal(windowsCommandLine(['C:\\Program Files\\Ash\\Ash.exe', '--user-data-dir=C:\\Ash profile\\', 'a"b', '--new-window']), '"C:\\Program Files\\Ash\\Ash.exe" "--user-data-dir=C:\\Ash profile\\\\" "a\\"b" "--new-window"');
});

