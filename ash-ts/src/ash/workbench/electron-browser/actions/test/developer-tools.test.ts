import assert from "node:assert/strict";
import { test } from "mocha";
import {
	MenuId,
} from "../../../../platform/actions/common/actions.js";
import {
	MenuService,
} from "../../../../platform/actions/common/menuService.js";
import {
	ContextKeyService,
} from "../../../../platform/contextkey/common/contextkey.js";
import {
	ServiceContainer,
} from "../../../../platform/instantiation/common/instantiation.js";
import {
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_OPEN_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
} from "../../../../platform/native/common/nativeHost.js";
import {
	nativeHostIpcRoutes,
} from "../../../../platform/native/electron-main/nativeHostIpc.js";
import {
	INativeHostService,
} from "../../../../workbench/common/services.js";
import {
	ToggleDeveloperToolsCommandId,
} from "../../../../workbench/electron-browser/actions/developerActions.js";
import { OpenFolderCommandId } from "../../../../workbench/electron-browser/actions/workspaceActions.js";
import "../../../../workbench/electron-browser/desktop.contribution.js";
import {
	CommandService,
} from "../../../../workbench/services/commands/common/commandService.js";
import { IWorkspaceOpenService } from "../../../../workbench/services/workspaces/browser/workspaceOpenService.js";

test("native host routes validate folder opening and developer tools", async () => {
	let folderOpens = 0;
	let pickedFolder: string | undefined;
	let toggles = 0;
	let savedFileOptions: unknown;
	const windowThemes: unknown[] = [];
	const routes = nativeHostIpcRoutes({
		openFolder: async () => {
			folderOpens += 1;
		},
		pickFolder: async () => {
			pickedFolder = "/tmp/trusted-folder";
			return pickedFolder;
		},
		openWorkspace: async () => {},
		saveFile: async (options) => {
			savedFileOptions = options;
			return "C:\\project\\draft.txt";
		},
		isAccessibilitySupportEnabled: () => false,
		setWindowTheme: (theme) => {
			windowThemes.push(theme);
		},
		toggleDeveloperTools: () => {
			toggles += 1;
		},
	});
	const openFolder = routes.find(
		({ channel }) => channel === NATIVE_HOST_OPEN_FOLDER_CHANNEL,
	);
	const accessibilitySupport = routes.find(
		({ channel }) => channel === NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	);
	const pickFolder = routes.find(
		({ channel }) => channel === NATIVE_HOST_PICK_FOLDER_CHANNEL,
	);
	const toggleDeveloperTools = routes.find(
		({ channel }) =>
			channel === NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	);
	const setWindowTheme = routes.find(
		({ channel }) => channel === NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	);
	assert.ok(openFolder);
	const saveFile = routes.find(
		({ channel }) => channel === NATIVE_HOST_SAVE_FILE_CHANNEL,
	);
	assert.ok(accessibilitySupport);
	assert.ok(pickFolder);
	assert.ok(setWindowTheme);
	assert.ok(toggleDeveloperTools);
	assert.ok(saveFile);

	assert.throws(
		() => openFolder.validate(null),
		/does not accept parameters/,
	);
	await openFolder.invoke(openFolder.validate(undefined));
	assert.equal(folderOpens, 1);
	assert.throws(
		() => pickFolder.validate(null),
		/does not accept parameters/,
	);
	assert.equal(await pickFolder.invoke(pickFolder.validate(undefined)), "/tmp/trusted-folder");
	assert.equal(pickedFolder, "/tmp/trusted-folder");
	assert.throws(
		() => saveFile.validate({ defaultName: "" }),
		/default name must be a non-empty string/,
	);
	const validatedSaveFile = saveFile.validate({ defaultName: "Untitled-1" });
	assert.equal(await saveFile.invoke(validatedSaveFile), "C:\\project\\draft.txt");
	assert.deepEqual(savedFileOptions, { defaultName: "Untitled-1" });
	assert.throws(
		() => accessibilitySupport.validate(null),
		/does not accept parameters/,
	);
	assert.equal(accessibilitySupport.invoke(accessibilitySupport.validate(undefined)), false);
	assert.throws(
		() => setWindowTheme.validate({ backgroundColor: "white", symbolColor: "#000000" }),
		/backgroundColor must be an opaque hexadecimal color/,
	);
	const validatedTheme = setWindowTheme.validate({
		backgroundColor: "#F3F3F3",
		symbolColor: "#424242",
	});
	setWindowTheme.invoke(validatedTheme);
	assert.deepEqual(windowThemes, [{
		backgroundColor: "#f3f3f3",
		symbolColor: "#424242",
	}]);
	assert.throws(
		() => toggleDeveloperTools.validate(null),
		/does not accept parameters/,
	);
	toggleDeveloperTools.invoke(
		toggleDeveloperTools.validate(undefined),
	);
	assert.equal(toggles, 1);
});

test("desktop commands are available from the command palette", async () => {
	const services = new ServiceContainer();
	let toggles = 0;
	services.registerInstance(INativeHostService, {
		openFolder: async () => {},
		pickFolder: async () => undefined,
		openWorkspace: async () => {},
		saveFile: async () => undefined,
		isAccessibilitySupportEnabled: async () => false,
		onDidChangeAccessibilitySupport: () => ({ dispose() {} }),
		setWindowTheme: async () => {},
		async toggleDeveloperTools() {
			toggles += 1;
		},
	});
	let folderOpens = 0;
	services.registerInstance(IWorkspaceOpenService, {
		canOpenFolder: true,
		canOpenWorkspace: true,
		async openFolder() {
			folderOpens += 1;
		},
		async openWorkspace() {},
		async pickFolder() {
			return undefined;
		},
	});
	using commands = new CommandService(services);
	using contexts = new ContextKeyService();
	const paletteActions = new MenuService(commands, contexts)
		.getMenuActions(MenuId.CommandPalette)
		.flatMap(([, actions]) => actions);

	const action = paletteActions.find(
		({ id }) => id === ToggleDeveloperToolsCommandId,
	);
	assert.equal(action?.label, "Developer: Toggle Developer Tools");
	await action?.run();
	assert.equal(toggles, 1);

	const openFolder = paletteActions.find(
		({ id }) => id === OpenFolderCommandId,
	);
	assert.equal(openFolder?.label, "Open Folder...");
	await openFolder?.run();
	assert.equal(folderOpens, 1);
});
