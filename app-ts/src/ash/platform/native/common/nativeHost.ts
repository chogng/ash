import type { DisposableHandle } from "../../ipc/common/ipc.js";
import type { DialogRequest, FileFilter, IDialogOutcome } from '../../dialogs/common/dialogs.js';
import type { IWorkbenchWindowInfo } from '../../window/common/window.js';

export const NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL =
	"ash:native-host:toggle-developer-tools";
export const NATIVE_HOST_PICK_FOLDER_CHANNEL =
	"ash:native-host:pick-folder";
export const NATIVE_HOST_PICK_FILE_CHANNEL =
	"ash:native-host:pick-file";
export const NATIVE_HOST_OPEN_WORKSPACE_CHANNEL =
	"ash:native-host:open-workspace";
export const NATIVE_HOST_SET_WINDOW_THEME_CHANNEL =
	"ash:native-host:set-window-theme";
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

export type NativeDialogOperation =
	| { readonly kind: 'show'; readonly id: number; readonly request: DialogRequest }
	| { readonly kind: 'cancel'; readonly id: number };

export function validateNativeDialogOperation(value: unknown): NativeDialogOperation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid dialog operation');
	const operation = value as Record<string, unknown>;
	if (!Number.isSafeInteger(operation.id) || (operation.id as number) <= 0) throw new TypeError('Invalid dialog ID');
	if (operation.kind === 'cancel' && Object.keys(operation).sort().join(',') === 'id,kind') return operation as NativeDialogOperation;
	if (operation.kind !== 'show' || Object.keys(operation).sort().join(',') !== 'id,kind,request') throw new TypeError('Invalid dialog operation');
	const request = operation.request;
	if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Invalid dialog request');
	const fields = request as Record<string, unknown>;
	const allowed = new Set(['kind', 'title', 'message', 'detail', 'severity', 'primaryButton', 'secondaryButton', 'cancelButton', 'checkbox']);
	if (Object.keys(fields).some(key => !allowed.has(key)) || typeof fields.message !== 'string') throw new TypeError('Invalid dialog request');
	for (const key of ['title', 'detail', 'primaryButton', 'secondaryButton', 'cancelButton']) {
		if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new TypeError('Invalid dialog request');
	}
	if (fields.checkbox !== undefined) {
		const checkbox = fields.checkbox;
		if (!checkbox || typeof checkbox !== 'object' || Array.isArray(checkbox)) throw new TypeError('Invalid dialog checkbox');
		const properties = checkbox as Record<string, unknown>;
		if (Object.keys(properties).some(key => key !== 'label' && key !== 'checked') || typeof properties.label !== 'string' || properties.checked !== undefined && typeof properties.checked !== 'boolean') throw new TypeError('Invalid dialog checkbox');
	}
	if (fields.kind === 'message' && ['info', 'warning', 'error'].includes(fields.severity as string) && fields.secondaryButton === undefined && fields.cancelButton === undefined) return operation as NativeDialogOperation;
	if (fields.kind === 'confirmation' && fields.severity === undefined && fields.secondaryButton === undefined) return operation as NativeDialogOperation;
	if (fields.kind === 'prompt' && fields.severity === undefined && typeof fields.primaryButton === 'string' && typeof fields.secondaryButton === 'string') return operation as NativeDialogOperation;
	throw new TypeError('Invalid dialog request');
}

export type ShellCommandOperation = 'install' | 'uninstall';

export function validateShellCommandOperation(value: unknown): ShellCommandOperation {
	if (value !== 'install' && value !== 'uninstall') throw new TypeError('Invalid shell command operation');
	return value;
}

export interface INativeSystemWideKeybinding {
	readonly accelerator: string;
	readonly commandId: string;
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
		if (Object.keys(binding).sort().join(',') !== 'accelerator,commandId,userSettingsLabel'
			|| typeof binding.accelerator !== 'string' || !binding.accelerator
			|| typeof binding.commandId !== 'string' || !binding.commandId
			|| typeof binding.userSettingsLabel !== 'string' || !binding.userSettingsLabel) {
			throw new TypeError('Invalid system-wide keybinding');
		}
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
}

/** Native save-dialog defaults supplied by a renderer Workbench. */
export interface INativeSaveFileOptions {
	readonly defaultName?: string;
	readonly defaultPath?: string;
	readonly title?: string;
	readonly buttonLabel?: string;
	readonly filters?: readonly FileFilter[];
}

export interface INativeOpenDialogOptions {
	readonly title?: string;
	readonly defaultPath?: string;
	readonly buttonLabel?: string;
	readonly canSelectFiles: boolean;
	readonly canSelectFolders: boolean;
	readonly canSelectMany?: boolean;
	readonly filters?: readonly FileFilter[];
}

/** Window-scoped native capabilities exposed to an Electron renderer. */
export interface INativeHostApi {
	showNativeDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome>;
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
	pickFile(options: INativeOpenDialogOptions): Promise<readonly string[] | undefined>;
	openWorkspace(root: string): Promise<void>;
	revealFile(path: string): Promise<void>;
	setWindowTheme(theme: INativeWindowTheme): Promise<void>;
	toggleDeveloperTools(): Promise<void>;
	saveFile(options?: INativeSaveFileOptions): Promise<string | undefined>;
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

export function validatePickFolder(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("pick folder does not accept parameters");
	}
	return undefined;
}

function validateFileFilters(value: unknown): readonly FileFilter[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid file filters');
	for (const filter of value) {
		if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TypeError('Invalid file filter');
		const fields = filter as Record<string, unknown>;
		if (Object.keys(fields).sort().join(',') !== 'extensions,name' || typeof fields.name !== 'string' || !fields.name
			|| !Array.isArray(fields.extensions) || !fields.extensions.every(extension => typeof extension === 'string' && (extension === '*' || /^[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(extension)))) {
			throw new TypeError('Invalid file filter');
		}
	}
	return value as readonly FileFilter[];
}

export function validatePickFile(value: unknown): INativeOpenDialogOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid open dialog options');
	const fields = value as Record<string, unknown>;
	const allowed = new Set(['title', 'defaultPath', 'buttonLabel', 'canSelectFiles', 'canSelectFolders', 'canSelectMany', 'filters']);
	if (Object.keys(fields).some(key => !allowed.has(key)) || typeof fields.canSelectFiles !== 'boolean' || typeof fields.canSelectFolders !== 'boolean'
		|| !fields.canSelectFiles && !fields.canSelectFolders || fields.canSelectMany !== undefined && typeof fields.canSelectMany !== 'boolean') throw new TypeError('Invalid open dialog options');
	for (const key of ['title', 'defaultPath', 'buttonLabel']) {
		if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new TypeError('Invalid open dialog options');
	}
	validateFileFilters(fields.filters);
	return value as INativeOpenDialogOptions;
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

export function validateSaveFileOptions(value: unknown): INativeSaveFileOptions {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("save file options must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	if (keys.some(key => !['defaultName', 'defaultPath', 'title', 'buttonLabel', 'filters'].includes(key))) {
		throw new Error("save file options contain unknown fields");
	}
	if (candidate.defaultName !== undefined && (typeof candidate.defaultName !== "string" || candidate.defaultName.trim().length === 0)) {
		throw new Error("save file default name must be a non-empty string");
	}
	for (const key of ['defaultPath', 'title', 'buttonLabel']) {
		if (candidate[key] !== undefined && typeof candidate[key] !== 'string') throw new TypeError('Invalid save dialog options');
	}
	validateFileFilters(candidate.filters);
	return {
		...(candidate.defaultName === undefined ? {} : { defaultName: candidate.defaultName }),
		...(candidate.defaultPath === undefined ? {} : { defaultPath: candidate.defaultPath as string }),
		...(candidate.title === undefined ? {} : { title: candidate.title as string }),
		...(candidate.buttonLabel === undefined ? {} : { buttonLabel: candidate.buttonLabel as string }),
		...(candidate.filters === undefined ? {} : { filters: candidate.filters as readonly FileFilter[] }),
	};
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
	if (keys.length !== 2 || keys[0] !== "backgroundColor" || keys[1] !== "symbolColor") throw new Error("window theme contains unknown fields");
	return {
		backgroundColor: validateOpaqueHexColor(candidate.backgroundColor, "backgroundColor"),
		symbolColor: validateOpaqueHexColor(candidate.symbolColor, "symbolColor"),
	};
}

function validateOpaqueHexColor(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} must be an opaque hexadecimal color`);
	return value.toLowerCase();
}
