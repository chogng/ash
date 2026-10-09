import type { IColorScheme } from '../../window/common/window.js';
import { validateJsonValue, type JsonValue } from '../../../base/common/jsonValue.js';
import type { SessionMode } from '../../sessions/common/sessionApi.js';
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import type { FileFilter, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';
import type { IWorkbenchWindowInfo, IOpenEmptyWindowOptions } from '../../window/common/window.js';

export const NATIVE_HOST_IS_ADMIN_CHANNEL = 'ash:native-host:is-admin';

export const NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL =
	"ash:native-host:toggle-developer-tools";
export const NATIVE_HOST_PICK_FOLDER_CHANNEL =
	"ash:native-host:pick-folder";
export const NATIVE_HOST_PICK_FILE_CHANNEL =
	"ash:native-host:pick-file";
export const NATIVE_HOST_OPEN_WORKSPACE_CHANNEL =
	"ash:native-host:open-workspace";
export const NATIVE_HOST_OPEN_WINDOW_CHANNEL = 'ash:window:open';
export const NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL = 'ash:native-host:open-agents-window';
export const NATIVE_HOST_SET_WINDOW_THEME_CHANNEL =
	"ash:native-host:set-window-theme";
export const NATIVE_HOST_SET_WINDOW_DIMMED_CHANNEL =
	"ash:native-host:set-window-dimmed";
export const NATIVE_HOST_SAVE_FILE_CHANNEL =
	"ash:native-host:save-file";
export const NATIVE_HOST_GET_ACCESSIBILITY_SUPPORT_CHANNEL =
	"ash:native-host:get-accessibility-support";
export const NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL =
	"ash:native-host:accessibility-support-changed";
export const NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL =
	'ash:native-host:sync-system-wide-keybindings';
export const NATIVE_HOST_SHELL_COMMAND_CHANNEL = 'ash:native-host:shell-command';
export const NATIVE_HOST_DIALOG_CHANNEL = 'ash:native-host:dialog';
export const NATIVE_HOST_REVEAL_FILE_CHANNEL = 'ash:native-host:reveal-file';


export function validateColorScheme(value: unknown): IColorScheme {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid system color scheme');
	const scheme = value as Record<string, unknown>;
	if (Object.keys(scheme).sort().join(',') !== 'dark,highContrast' || typeof scheme.dark !== 'boolean' || typeof scheme.highContrast !== 'boolean') throw new TypeError('Invalid system color scheme');
	return scheme as unknown as IColorScheme;
}

export type NativeDialogOperation =
	| { readonly kind: 'show'; readonly id: number; readonly options: Omit<MessageBoxOptions, 'signal'>; }
	| { readonly kind: 'cancel'; readonly id: number; };

export function validateNativeDialogOperation(value: unknown): NativeDialogOperation {
	const operation = dialogFields(value, ['kind', 'id', 'options'], 'dialog operation');
	if (!Number.isSafeInteger(operation.id) || (operation.id as number) <= 0) throw new TypeError('Invalid dialog ID');
	if (operation.kind === 'cancel' && Object.keys(operation).sort().join(',') === 'id,kind') return operation as NativeDialogOperation;
	if (operation.kind !== 'show' || Object.keys(operation).sort().join(',') !== 'id,kind,options') throw new TypeError('Invalid dialog operation');
	const options = dialogFields(operation.options, ['message', 'type', 'buttons', 'defaultId', 'title', 'detail', 'checkboxLabel', 'checkboxChecked', 'textWidth', 'cancelId', 'noLink', 'normalizeAccessKeys'], 'message box options');
	if (typeof options.message !== 'string' || options.type !== undefined && !['none', 'info', 'error', 'question', 'warning'].includes(options.type as string)) throw new TypeError('Invalid message box options');
	validateDialogStrings(options, ['title', 'detail', 'checkboxLabel']);
	validateDialogBooleans(options, ['checkboxChecked', 'noLink', 'normalizeAccessKeys']);
	if (options.buttons !== undefined && (!Array.isArray(options.buttons) || options.buttons.length > 100 || !options.buttons.every(button => typeof button === 'string'))) throw new TypeError('Invalid message box buttons');
	const buttons = Array.isArray(options.buttons) && options.buttons.length ? options.buttons.length : 1;
	for (const key of ['defaultId', 'cancelId']) {
		if (options[key] !== undefined && (!Number.isInteger(options[key]) || (options[key] as number) < (key === 'cancelId' ? -1 : 0) || (options[key] as number) >= buttons)) throw new TypeError('Invalid message box button index');
	}
	if (options.textWidth !== undefined && (typeof options.textWidth !== 'number' || !Number.isFinite(options.textWidth) || options.textWidth < 0)) throw new TypeError('Invalid message box text width');
	return operation as NativeDialogOperation;
}

export type ShellCommandOperation = 'install' | 'uninstall';

export function validateShellCommandOperation(value: unknown): ShellCommandOperation {
	if (value !== 'install' && value !== 'uninstall') throw new TypeError('Invalid shell command operation');
	return value;
}

export interface INativeSystemWideKeybinding {
	readonly accelerator: string;
	readonly commandId: string;
	/** The configured command argument is preserved through registration and dispatch. */
	readonly args?: JsonValue;
	readonly userSettingsLabel: string;
}

export interface INativeSystemWideKeybindingResult {
	readonly failed: readonly string[];
}

export function validateSystemWideKeybindings(value: unknown): readonly INativeSystemWideKeybinding[] {
	if (!Array.isArray(value) || value.length > 1_024) throw new TypeError('Invalid system-wide keybindings');
	return value.map((item: unknown) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid system-wide keybinding');
		const binding = item as Record<string, unknown>;
		if (Object.keys(binding).some(key => !['accelerator', 'commandId', 'args', 'userSettingsLabel'].includes(key))
			|| typeof binding.accelerator !== 'string' || !binding.accelerator
			|| typeof binding.commandId !== 'string' || !binding.commandId
			|| typeof binding.userSettingsLabel !== 'string' || !binding.userSettingsLabel) {
			throw new TypeError('Invalid system-wide keybinding');
		}
		if (binding.args !== undefined) validateJsonValue(binding.args);
		return binding as unknown as INativeSystemWideKeybinding;
	});
}

export function validateSystemWideKeybindingsResult(value: unknown): INativeSystemWideKeybindingResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid system-wide keybinding result');
	const result = value as Record<string, unknown>;
	if (Object.keys(result).join(',') !== 'failed' || !Array.isArray(result.failed)
		|| !result.failed.every(label => typeof label === 'string')) {
		throw new TypeError('Invalid system-wide keybinding result');
	}
	return result as unknown as INativeSystemWideKeybindingResult;
}

export interface INativeWindowTheme {
	readonly backgroundColor: string;
	readonly symbolColor: string;
	readonly backdropColor: string;
}

export interface IOpenAgentsWindowOptions {
	readonly conversation?: { readonly sessionId: string; readonly threadId: string; };
	readonly draft?: {
		readonly mode: SessionMode;
		readonly text: string;
		/** Optional resource is the original source URI; content is a snapshot or an instruction catalog path. */
		readonly contexts: readonly { readonly id: string; readonly kind: string; readonly name: string; readonly content: string; readonly resource?: string; }[];
	};
}

/** Window-scoped native capabilities exposed to an Electron renderer. */
export interface INativeHostApi {
	isAdmin(): Promise<boolean>;
	getOSColorScheme(): Promise<IColorScheme>;
	onDidChangeColorScheme(listener: (scheme: IColorScheme) => void): DisposableHandle;
	showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
	installShellCommand(): Promise<string>;
	uninstallShellCommand(): Promise<string>;
	listWindows(): Promise<readonly IWorkbenchWindowInfo[]>;
	focusWindowById(windowId: number): Promise<void>;
	focusWindow(): Promise<void>;
	closeWindow(): Promise<void>;
	closeOtherWindows(): Promise<void>;
	getZoomLevel(): Promise<number>;
	onDidChangeZoomLevel(listener: (level: number) => void): DisposableHandle;
	setZoomLevel(level: number): Promise<void>;
	isAlwaysOnTop(): Promise<boolean>;
	setAlwaysOnTop(enabled: boolean): Promise<void>;
	performNativeTabAction(action: 'next' | 'previous' | 'newWindow' | 'merge' | 'toggleBar'): Promise<void>;
	openNewWindowTab(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
	showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
	openWorkspace(root: string): Promise<void>;
	openWindow(options: IOpenEmptyWindowOptions): Promise<void>;
	openAgentsWindow(options?: IOpenAgentsWindowOptions): Promise<void>;
	syncSystemWideKeybindings(keybindings: readonly INativeSystemWideKeybinding[]): Promise<INativeSystemWideKeybindingResult>;
	openExternal(target: string): Promise<boolean>;
	onDidRequestOpenExternalUri(listener: (target: string) => void): DisposableHandle;
	revealFile(path: string): Promise<void>;
	setWindowTheme(theme: INativeWindowTheme): Promise<void>;
	setWindowDimmed(dimmed: boolean): Promise<void>;
	toggleDeveloperTools(): Promise<void>;
	showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
	isAccessibilitySupportEnabled(): Promise<boolean>;
	onDidChangeAccessibilitySupport(listener: (enabled: boolean) => void): DisposableHandle;
}

export function validateRevealFilePath(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		throw new TypeError('Invalid file path to reveal');
	}
	return value;
}

export function validateOpenWorkspace(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("workspace root must be a non-empty string");
	}
	return value;
}

export function validateOpenAgentsWindow(value: unknown): IOpenAgentsWindowOptions | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Agents Window options');
	const options = value as Record<string, unknown>;
	if (Object.keys(options).some(key => key !== 'conversation' && key !== 'draft')) throw new TypeError('Invalid Agents Window options');
	if (options.conversation === undefined && options.draft === undefined) throw new TypeError('Agents Window handoff requires a conversation or draft');
	if (options.conversation !== undefined) {
		const conversation = options.conversation;
		if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) throw new TypeError('Invalid Agents Window conversation');
		const fields = conversation as Record<string, unknown>;
		if (Object.keys(fields).sort().join(',') !== 'sessionId,threadId' || typeof fields.sessionId !== 'string' || !fields.sessionId || typeof fields.threadId !== 'string' || !fields.threadId) throw new TypeError('Invalid Agents Window conversation');
	}
	if (options.draft !== undefined) {
		const draft = options.draft;
		if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new TypeError('Invalid Agents Window draft');
		const fields = draft as Record<string, unknown>;
		if (!['agent', 'plan', 'debug', 'multitask', 'ask'].includes(fields.mode as string) || Object.keys(fields).sort().join(',') !== 'contexts,mode,text' || typeof fields.text !== 'string' || !Array.isArray(fields.contexts)) throw new TypeError('Invalid Agents Window draft');
		for (const context of fields.contexts) {
			if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Invalid Agents Window context');
			const attachment = context as Record<string, unknown>;
			if (!['content', 'id', 'kind', 'name'].every(key => typeof attachment[key] === 'string') || Object.keys(attachment).some(key => !['content', 'id', 'kind', 'name', 'resource'].includes(key)) || attachment.resource !== undefined && typeof attachment.resource !== 'string') throw new TypeError('Invalid Agents Window context');
		}
	}
	return value as IOpenAgentsWindowOptions;
}

export function validatePickFolder(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("pick folder does not accept parameters");
	}
	return undefined;
}

function validateFileFilters(value: unknown): FileFilter[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid file filters');
	for (const filter of value) {
		if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Invalid file filter');
		const fields = filter as Record<string, unknown>;
		if (Object.keys(fields).sort().join(',') !== 'extensions,name' || typeof fields.name !== 'string' || !fields.name
			|| !Array.isArray(fields.extensions) || !fields.extensions.every(extension => typeof extension === 'string' && (extension === '*' || /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/i.test(extension)))) {
			throw new TypeError('Invalid file filter');
		}
	}
	return value as FileFilter[];
}

function dialogFields(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`Invalid ${name}`);
	return value as Record<string, unknown>;
}

function validateDialogStrings(fields: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new TypeError(`Invalid dialog ${key}`);
	}
}

function validateDialogBooleans(fields: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		if (fields[key] !== undefined && typeof fields[key] !== 'boolean') throw new TypeError(`Invalid dialog ${key}`);
	}
}

function validateDialogProperties(value: unknown, allowed: readonly string[]): void {
	if (value !== undefined && (!Array.isArray(value) || value.length > allowed.length || !value.every(property => typeof property === 'string' && allowed.includes(property)))) throw new TypeError('Invalid dialog properties');
}

export function validateOpenDialogOptions(value: unknown): OpenDialogOptions {
	const fields = dialogFields(value, ['title', 'defaultPath', 'buttonLabel', 'filters', 'properties', 'message', 'securityScopedBookmarks'], 'open dialog options');
	validateDialogStrings(fields, ['title', 'defaultPath', 'buttonLabel', 'message']);
	validateDialogBooleans(fields, ['securityScopedBookmarks']);
	validateFileFilters(fields.filters);
	validateDialogProperties(fields.properties, ['openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles', 'createDirectory', 'promptToCreate', 'noResolveAliases', 'treatPackageAsDirectory', 'dontAddToRecent']);
	return fields as OpenDialogOptions;
}

export function validateOpenDialogResult(value: unknown): OpenDialogReturnValue {
	const fields = dialogFields(value, ['canceled', 'filePaths', 'bookmarks'], 'open dialog result');
	if (typeof fields.canceled !== 'boolean' || !Array.isArray(fields.filePaths) || !fields.filePaths.every(path => typeof path === 'string')
		|| fields.bookmarks !== undefined && (!Array.isArray(fields.bookmarks) || !fields.bookmarks.every(bookmark => typeof bookmark === 'string'))) throw new TypeError('Invalid open dialog result');
	return fields as unknown as OpenDialogReturnValue;
}

export function validateSaveDialogResult(value: unknown): SaveDialogReturnValue {
	const fields = dialogFields(value, ['canceled', 'filePath', 'bookmark'], 'save dialog result');
	if (typeof fields.canceled !== 'boolean' || typeof fields.filePath !== 'string' || fields.bookmark !== undefined && typeof fields.bookmark !== 'string') throw new TypeError('Invalid save dialog result');
	return fields as unknown as SaveDialogReturnValue;
}

export function validateMessageBoxResult(value: unknown): MessageBoxReturnValue {
	const fields = dialogFields(value, ['response', 'checkboxChecked'], 'message box result');
	// Electron can return -1 when cancellation is configured without a cancel button.
	if (!Number.isSafeInteger(fields.response) || (fields.response as number) < -1 || typeof fields.checkboxChecked !== 'boolean') throw new TypeError('Invalid message box result');
	return fields as unknown as MessageBoxReturnValue;
}

export function validateToggleDeveloperTools(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("toggle developer tools does not accept parameters");
	}
	return undefined;
}

export function validateAccessibilitySupportRead(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("accessibility support read does not accept parameters");
	}
	return undefined;
}

export function validateSaveDialogOptions(value: unknown): SaveDialogOptions {
	const fields = dialogFields(value, ['title', 'defaultPath', 'buttonLabel', 'filters', 'message', 'nameFieldLabel', 'showsTagField', 'properties', 'securityScopedBookmarks'], 'save dialog options');
	validateDialogStrings(fields, ['title', 'defaultPath', 'buttonLabel', 'message', 'nameFieldLabel']);
	validateDialogBooleans(fields, ['showsTagField', 'securityScopedBookmarks']);
	validateFileFilters(fields.filters);
	validateDialogProperties(fields.properties, ['showHiddenFiles', 'createDirectory', 'treatPackageAsDirectory', 'showOverwriteConfirmation', 'dontAddToRecent']);
	return fields as SaveDialogOptions;
}

export function validateAccessibilitySupport(value: unknown): boolean {
	if (typeof value !== "boolean") {
		throw new Error("accessibility support must be a boolean");
	}
	return value;
}

export function validateNativeWindowTheme(value: unknown): INativeWindowTheme {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("window theme must be an object");
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	if (keys.length !== 3 || keys[0] !== "backdropColor" || keys[1] !== "backgroundColor" || keys[2] !== "symbolColor") throw new Error("window theme contains unknown fields");
	return {
		backgroundColor: validateOpaqueHexColor(candidate.backgroundColor, "backgroundColor"),
		symbolColor: validateOpaqueHexColor(candidate.symbolColor, "symbolColor"),
		backdropColor: validateHexColor(candidate.backdropColor, "backdropColor"),
	};
}

export function validateWindowDimmed(value: unknown): boolean {
	if (typeof value !== 'boolean') throw new TypeError('Window dimmed state must be a boolean');
	return value;
}

function validateOpaqueHexColor(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} must be an opaque hexadecimal color`);
	return value.toLowerCase();
}

function validateHexColor(value: unknown, name: string): string {
	if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) throw new TypeError(`${name} must be a hexadecimal color`);
	return value.toLowerCase();
}
