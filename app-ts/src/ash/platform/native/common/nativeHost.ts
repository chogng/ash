import type { DisposableHandle } from "../../ipc/common/ipc.js";

export const NATIVE_HOST_TOGGLE_DEVELOPER_TOOLS_CHANNEL =
	"ash:native-host:toggle-developer-tools";
export const NATIVE_HOST_OPEN_FOLDER_CHANNEL =
	"ash:native-host:open-folder";
export const NATIVE_HOST_PICK_FOLDER_CHANNEL =
	"ash:native-host:pick-folder";
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

export interface INativeWindowTheme {
	readonly backgroundColor: string;
	readonly symbolColor: string;
}

/** Native save-dialog defaults supplied by a renderer Workbench. */
export interface INativeSaveFileOptions {
	readonly defaultName?: string;
}

/** Window-scoped native capabilities exposed to an Electron renderer. */
export interface INativeHostApi {
	openFolder(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
	openWorkspace(root: string): Promise<void>;
	setWindowTheme(theme: INativeWindowTheme): Promise<void>;
	toggleDeveloperTools(): Promise<void>;
	saveFile(options?: INativeSaveFileOptions): Promise<string | undefined>;
	isAccessibilitySupportEnabled(): Promise<boolean>;
	onDidChangeAccessibilitySupport(listener: (enabled: boolean) => void): DisposableHandle;
}

export function validateOpenWorkspace(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("workspace root must be a non-empty string");
	}
	return value;
}

export function validateOpenFolder(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("open folder does not accept parameters");
	}
	return undefined;
}

export function validatePickFolder(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("pick folder does not accept parameters");
	}
	return undefined;
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
	if (keys.length > 1 || (keys.length === 1 && keys[0] !== "defaultName")) {
		throw new Error("save file options contain unknown fields");
	}
	if (candidate.defaultName !== undefined && (typeof candidate.defaultName !== "string" || candidate.defaultName.trim().length === 0)) {
		throw new Error("save file default name must be a non-empty string");
	}
	return {
		...(candidate.defaultName === undefined ? {} : { defaultName: candidate.defaultName }),
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
