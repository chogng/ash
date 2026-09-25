import assert from "node:assert/strict";
import { test } from "mocha";
import {
	WorkbenchState,
} from "../../../../platform/workspace/common/workspace.js";
import {
	defaultWindowState,
} from "../../../../platform/window/electron-main/window.js";
import {
	resolveBrowserWindowOptions,
	WindowControlsOverlay,
} from "../../../../platform/windows/electron-main/windows.js";

test("window options apply the custom titlebar host policy", () => {
	const webPreferences = {
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		preload: "preload.js",
		additionalArguments: [],
	};
	const state = defaultWindowState(WorkbenchState.FOLDER);
	const customWindows = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: "win32",
	});
	assert.equal(customWindows.titleBarStyle, "hidden");
	assert.deepEqual(customWindows.titleBarOverlay, {
		color: "#181818",
		symbolColor: "#d6d6d6",
		height: 35,
	});

	const customMac = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: "darwin",
	});
	assert.equal(customMac.titleBarStyle, "hiddenInset");
	assert.equal(customMac.titleBarOverlay, true);

	const customLinux = resolveBrowserWindowOptions({
		state,
		webPreferences,
		platform: "linux",
	});
	assert.equal(customLinux.titleBarStyle, "hidden");
	assert.deepEqual(customLinux.titleBarOverlay, {
		color: "#181818",
		symbolColor: "#d6d6d6",
		height: 35,
	});
});

test('window controls follow the modal backdrop and restore the latest theme', () => {
	const updates: { color: string; symbolColor: string; height: number }[] = [];
	const controls = new WindowControlsOverlay(colors => updates.push(colors));
	controls.setTheme({ backgroundColor: '#ffffff', symbolColor: '#424242', backdropColor: '#00000080' });
	controls.setDimmed(true);
	controls.setTheme({ backgroundColor: '#202020', symbolColor: '#eeeeee', backdropColor: '#ffffff40' });
	controls.setDimmed(false);
	assert.deepEqual(updates, [
		{ color: '#ffffff', symbolColor: '#424242', height: 35 },
		{ color: '#7e7e7e', symbolColor: '#202020', height: 35 },
		{ color: '#575757', symbolColor: '#f2f2f2', height: 35 },
		{ color: '#202020', symbolColor: '#eeeeee', height: 35 },
	]);
});

test('opaque high-contrast backdrop keeps window control symbols visible', () => {
	const updates: { color: string; symbolColor: string; height: number }[] = [];
	const controls = new WindowControlsOverlay(colors => updates.push(colors));
	controls.setTheme({ backgroundColor: '#000000', symbolColor: '#ffffff', backdropColor: '#000000' });
	controls.setDimmed(true);
	assert.deepEqual(updates.at(-1), { color: '#000000', symbolColor: '#ffffff', height: 35 });
});
