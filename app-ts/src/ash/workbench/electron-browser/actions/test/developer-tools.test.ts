import assert from "node:assert/strict";
import { test } from "mocha";
import {
	MenuId,
	registerAction2,
} from "../../../../platform/actions/common/actions.js";
import {
	MenuService,
} from "../../../../platform/actions/common/menuService.js";
import { ContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import {
	ServiceContainer,
} from "../../../../platform/instantiation/common/instantiation.js";
import {
	NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	NATIVE_HOST_PICK_FOLDER_CHANNEL,
	NATIVE_HOST_PICK_FILE_CHANNEL,
	NATIVE_HOST_SAVE_FILE_CHANNEL,
	NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL,
	NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
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
import { OpenFolderAction, OpenFolderCommandId } from '../../../../workbench/browser/actions/workspaceActions.js';
import "../../../../workbench/electron-browser/desktop.contribution.js";
import {
	CommandService,
} from "../../../../workbench/services/commands/common/commandService.js";
import { IWorkspaceOpenService } from "../../../../workbench/services/workspaces/browser/workspaceOpenService.js";
import { OpenFolderWorkspaceSupportContext } from '../../../../workbench/common/contextkeys.js';

test("native host routes validate folder picking and developer tools", async () => {
	let pickedFolder: string | undefined;
	let toggles = 0;
	let savedFileOptions: unknown;
	const windowThemes: unknown[] = [];
	const windowDimmed: boolean[] = [];
	const routes = nativeHostIpcRoutes({
		performDialogOperation: () => undefined,
		performShellCommand: async () => '',
		pickFolder: async () => {
			pickedFolder = "/tmp/trusted-folder";
			return pickedFolder;
		},
		pickFile: async () => ['C:\\project\\paper.md'],
		openWorkspace: async () => {},
		revealFile: () => {},
		saveFile: async (options) => {
			savedFileOptions = options;
			return "C:\\project\\draft.txt";
		},
		isAccessibilitySupportEnabled: () => false,
		setWindowTheme: (theme) => {
			windowThemes.push(theme);
		},
		setWindowDimmed: dimmed => { windowDimmed.push(dimmed); },
		toggleDeveloperTools: () => {
			toggles += 1;
		},
		syncSystemWideKeybindings: () => ({ failed: [] }),
	});
	const accessibilitySupport = routes.find(
		({ channel }) => channel === NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL,
	);
	const pickFolder = routes.find(
		({ channel }) => channel === NATIVE_HOST_PICK_FOLDER_CHANNEL,
	);
	const pickFile = routes.find(({ channel }) => channel === NATIVE_HOST_PICK_FILE_CHANNEL);
	const toggleDeveloperTools = routes.find(
		({ channel }) =>
			channel === NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL,
	);
	const setWindowTheme = routes.find(
		({ channel }) => channel === NATIVE_HOST_SET_WINDOW_THEME_CHANNEL,
	);
	const setWindowDimmed = routes.find(({ channel }) => channel === NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL);
	const syncSystemWideKeybindings = routes.find(
		({ channel }) => channel === NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
	);
	const saveFile = routes.find(
		({ channel }) => channel === NATIVE_HOST_SAVE_FILE_CHANNEL,
	);
	assert.ok(accessibilitySupport);
	assert.ok(pickFolder);
	assert.ok(pickFile);
	assert.ok(setWindowTheme);
	assert.ok(setWindowDimmed);
	assert.ok(toggleDeveloperTools);
	assert.ok(saveFile);
	assert.ok(syncSystemWideKeybindings);
	assert.throws(
		() => syncSystemWideKeybindings.validate([{ accelerator: 'Control+Shift+A', commandId: '', userSettingsLabel: 'ctrl+shift+a' }]),
		/Invalid system-wide keybinding/,
	);
	const systemWideBindings = syncSystemWideKeybindings.validate([{ accelerator: 'Control+Shift+A', commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+shift+a' }]);
	assert.deepEqual(syncSystemWideKeybindings.invoke(systemWideBindings), { failed: [] });

	assert.throws(
		() => pickFolder.validate(null),
		/does not accept parameters/,
	);
	assert.equal(await pickFolder.invoke(pickFolder.validate(undefined)), "/tmp/trusted-folder");
	assert.equal(pickedFolder, "/tmp/trusted-folder");
	assert.throws(() => pickFile.validate(null), /Invalid open dialog options/);
	assert.throws(() => pickFile.validate({ canSelectFiles: false, canSelectFolders: false }), /Invalid open dialog options/);
	assert.throws(() => pickFile.validate({ canSelectFiles: true, canSelectFolders: false, filters: [{ name: 'Text', extensions: ['../txt'] }] }), /Invalid file filter/);
	const openOptions = { canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: [{ name: 'Text', extensions: ['txt'] }] };
	assert.deepEqual(await pickFile.invoke(pickFile.validate(openOptions)), ['C:\\project\\paper.md']);
	assert.throws(
		() => saveFile.validate({ defaultName: "" }),
		/default name must be a non-empty string/,
	);
	const validatedSaveFile = saveFile.validate({ defaultName: "Untitled-1" });
	assert.equal(await saveFile.invoke(validatedSaveFile), "C:\\project\\draft.txt");
	assert.deepEqual(savedFileOptions, { defaultName: "Untitled-1" });
	assert.deepEqual(saveFile.validate({ defaultPath: 'C:\\project\\report.txt', filters: [{ name: 'Text', extensions: ['txt'] }] }), { defaultPath: 'C:\\project\\report.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
	assert.throws(
		() => accessibilitySupport.validate(null),
		/does not accept parameters/,
	);
	assert.equal(accessibilitySupport.invoke(accessibilitySupport.validate(undefined)), false);
	assert.throws(
		() => setWindowTheme.validate({ backgroundColor: "white", symbolColor: "#000000", backdropColor: '#00000073' }),
		/backgroundColor must be an opaque hexadecimal color/,
	);
	const validatedTheme = setWindowTheme.validate({
		backgroundColor: "#F3F3F3",
		symbolColor: "#424242",
		backdropColor: '#00000073',
	});
	setWindowTheme.invoke(validatedTheme);
	assert.deepEqual(windowThemes, [{
		backgroundColor: "#f3f3f3",
		symbolColor: "#424242",
		backdropColor: '#00000073',
	}]);
	assert.throws(() => setWindowDimmed.validate('true'), /boolean/);
	setWindowDimmed.invoke(setWindowDimmed.validate(true));
	assert.deepEqual(windowDimmed, [true]);
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
	registerAction2(OpenFolderAction);
	const services = new ServiceContainer();
	let toggles = 0;
	services.registerInstance(INativeHostService, {
		showNativeDialog: async () => { throw new Error('unused'); },
		installShellCommand: async () => '',
		uninstallShellCommand: async () => '',
		listWindows: async () => [],
		focusWindowById: async () => {},
		focusWindow: async () => {},
		closeWindow: async () => {},
		closeOtherWindows: async () => {},
		getZoomLevel: async () => 0,
		onDidChangeZoomLevel: () => ({ dispose() {} }),
		setZoomLevel: async () => {},
		isAlwaysOnTop: async () => false,
		setAlwaysOnTop: async () => {},
		performNativeTabAction: async () => {},
		openNewWindowTab: async () => {},
		pickFolder: async () => undefined,
		pickFile: async () => undefined,
		openWorkspace: async () => {},
		revealFile: async () => {},
		saveFile: async () => undefined,
		isAccessibilitySupportEnabled: async () => false,
		onDidChangeAccessibilitySupport: () => ({ dispose() {} }),
		setWindowTheme: async () => {},
		setWindowDimmed: async () => {},
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
	OpenFolderWorkspaceSupportContext.bindTo(contexts).set(true);
	const paletteActions = new MenuService(commands, contexts)
		.getMenuActions(MenuId.CommandPalette)
		.flatMap(([, actions]) => actions);

	const action = paletteActions.find(
		({ id }) => id === ToggleDeveloperToolsCommandId,
	);
	assert.equal(action?.label, "Developer: Toggle Developer Tools");
	await action?.run();
	assert.equal(toggles, 1);
	const helpMenuActions = new MenuService(commands, contexts)
		.getMenuActions(MenuId.MenubarHelpMenu)
		.flatMap(([, actions]) => actions);
	const helpMenuAction = helpMenuActions.find(
		({ id }) => id === ToggleDeveloperToolsCommandId,
	);
	assert.equal(helpMenuAction?.label, "Developer: Toggle Developer Tools");
	await helpMenuAction?.run();
	assert.equal(toggles, 2);

	const openFolder = paletteActions.find(
		({ id }) => id === OpenFolderCommandId,
	);
	assert.equal(openFolder?.label, "Open Folder...");
	await openFolder?.run();
	assert.equal(folderOpens, 1);
	const fileMenuActions = new MenuService(commands, contexts)
		.getMenuActions(MenuId.MenubarFileMenu)
		.flatMap(([, actions]) => actions);
	const openFolderFromMenu = fileMenuActions.find(
		({ id }) => id === OpenFolderCommandId,
	);
	assert.equal(openFolderFromMenu?.label, "Open Folder...");
	await openFolderFromMenu?.run();
	assert.equal(folderOpens, 2);
});
