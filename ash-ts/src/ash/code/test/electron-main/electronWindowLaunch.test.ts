import { strict as assert } from "node:assert";
import { test } from "mocha";
import { electronWorkspaceLaunchArguments } from "../../electron-main/electronWindowLaunch.js";

test("packaged second-instance arguments retain the Workspace target without process-only switches", () => {
	assert.deepEqual(electronWorkspaceLaunchArguments({
		arguments: ["/Applications/Ash.app/Contents/MacOS/Ash", "--user-data-dir", "/tmp/ash", "--remote-ssh", "build", "--folder", "/srv/project"],
		packaging: "packaged",
		appPath: "/Applications/Ash.app/Contents/Resources/app.asar",
	}), ["--remote-ssh", "build", "--folder", "/srv/project"]);
});

test("development second-instance arguments remove Electron and the app entry", () => {
	assert.deepEqual(electronWorkspaceLaunchArguments({
		arguments: ["/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/repo/ash-ts", "/repo/ash-ts", "--folder", "/repo/project"],
		packaging: "development",
		appPath: "/repo/ash-ts",
	}), ["--folder", "/repo/project"]);
});
