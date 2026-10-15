import type { ITerminalOutputSnapshot } from '../../terminal/common/terminal.js';
import type { TitleBarStyleConfiguration, IColorScheme, IWindowAlwaysOnTopChangedEvent, IAuxiliaryWindowState, IAuxiliaryWindowStateEvent } from '../../window/common/window.js';
import { validateJsonValue, type JsonValue } from '../../../base/common/jsonValue.js';
import type { SessionMode } from '../../agentHost/common/agentService.js';
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import type { FileFilter, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';
import type { IWorkbenchWindowInfo, IOpenEmptyWindowOptions } from '../../window/common/window.js';
import type { AgentHostEditorUpdate, IAgentHostEditorState, IAgentsWindowInvitation } from '../../chat/common/agentsWindowInvitation.js';
import { URI, type UriComponents } from '../../../base/common/uri.js';
import { buildOpenSessionLinkUri, parseOpenSessionLinkUri } from '../../agentHost/common/openSessionLink.js';
import { isRecord } from '../../../base/common/types.js';

export const AGENT_HOST_EDITOR_STATE_CHANNEL = 'ash:native-host:editor-state';
/** Main selects the backend profile's TOML resource; this is not the UI settings transport. */
export const EDIT_USER_CONFIGURATION_CHANNEL = 'ash:configuration:edit-user';
export const AGENT_HOST_EDITOR_STATE_CHANGED_CHANNEL = 'ash:native-host:editor-state-changed';
export const AGENT_HOST_EDITOR_UPDATE_CHANNEL = 'ash:native-host:editor-update';
export const AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL = 'ash:native-host:invitation-claim';
export const AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL = 'ash:native-host:invitation-shown';
export const AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL = 'ash:native-host:invitation-release';

export const NATIVE_HOST_GET_TITLE_BAR_STYLE_CHANNEL = 'ash:native-host:get-title-bar-style';

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
		readonly contexts: readonly { readonly id: string; readonly kind: string; readonly name: string; readonly content: string; readonly resource?: string; readonly terminalSnapshot?: ITerminalOutputSnapshot; readonly reference?: { readonly start: number; readonly end: number; }; }[];
	};
}

/** Window-scoped native capabilities exposed to an Electron renderer. */
export interface INativeHostApi {
	/** The frame style used to create this window, independently of saved settings. */
	getTitleBarStyle(): Promise<TitleBarStyleConfiguration>;
	isAdmin(): Promise<boolean>;
	getOSColorScheme(): Promise<IColorScheme>;
	onDidChangeColorScheme(listener: (scheme: IColorScheme) => void): DisposableHandle;
	showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
	installShellCommand(): Promise<string>;
	uninstallShellCommand(): Promise<string>;
	listWindows(): Promise<readonly IWorkbenchWindowInfo[]>;
	focusWindowById(windowId: number): Promise<void>;
	focusWindow(windowName?: string): Promise<void>;
	closeWindow(windowName?: string): Promise<void>;
	closeOtherWindows(): Promise<void>;
	getZoomLevel(windowName?: string): Promise<number>;
	onDidChangeZoomLevel(listener: (level: number) => void): DisposableHandle;
	setZoomLevel(level: number, windowName?: string, allWindows?: boolean): Promise<void>;
	/** An optional name selects an auxiliary window owned by this workbench. */
	getAuxiliaryWindowState(windowName: string): Promise<IAuxiliaryWindowState>;
	onDidChangeAuxiliaryWindowState(listener: (event: IAuxiliaryWindowStateEvent) => void): DisposableHandle;
	isAlwaysOnTop(windowName?: string): Promise<boolean>;
	setAlwaysOnTop(enabled: boolean, windowName?: string): Promise<void>;
	onDidChangeWindowAlwaysOnTop(listener: (event: IWindowAlwaysOnTopChangedEvent) => void): DisposableHandle;
	performNativeTabAction(action: 'next' | 'previous' | 'newWindow' | 'merge' | 'toggleBar'): Promise<void>;
	openNewWindowTab(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
	showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
	openWorkspace(root: string): Promise<void>;
	openWindow(options: IOpenEmptyWindowOptions): Promise<void>;
	openAgentsWindow(options?: IOpenAgentsWindowOptions): Promise<void>;
	getAgentHostEditorState(): Promise<IAgentHostEditorState>;
	updateAgentHostEditorState(update: AgentHostEditorUpdate): Promise<void>;
	onDidChangeAgentHostEditorState(listener: (state: IAgentHostEditorState) => void): DisposableHandle;
	claimAgentsWindowInvitation(resource: UriComponents): Promise<IAgentsWindowInvitation | undefined>;
	markAgentsWindowInvitationShown(id: string): Promise<void>;
	releaseAgentsWindowInvitation(id: string): Promise<void>;
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
			if (!['content', 'id', 'kind', 'name'].every(key => typeof attachment[key] === 'string') || Object.keys(attachment).some(key => !['content', 'id', 'kind', 'name', 'resource', 'terminalSnapshot', 'reference'].includes(key)) || attachment.resource !== undefined && typeof attachment.resource !== 'string') throw new TypeError('Invalid Agents Window context');
			if (attachment.terminalSnapshot !== undefined) {
				const snapshot = attachment.terminalSnapshot;
				if (attachment.kind !== 'terminal' || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('Invalid terminal snapshot');
				const data = snapshot as Record<string, unknown>;
				if (
					Object.keys(data).sort().join(',') !== 'columns,text'
					|| typeof data.text !== 'string' || data.text.length > 131072
					|| !Number.isInteger(data.columns) || (data.columns as number) < 2 || (data.columns as number) > 4096
				) throw new TypeError('Invalid terminal snapshot');
			}
			if (attachment.reference !== undefined) {
				const reference = attachment.reference as Record<string, unknown> | null;
				if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).sort().join(',') !== 'end,start'
					|| !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end)
					|| (reference.start as number) < 0 || (reference.end as number) <= (reference.start as number) || (reference.end as number) > fields.text.length
					|| fields.text.slice(reference.start as number, reference.end as number) !== attachment.name) {
					throw new TypeError('Invalid Agents Window context reference');
				}
			}
		}
	}
	return value as IOpenAgentsWindowOptions;
}

export function validateAgentHostEditorResource(value: unknown): UriComponents {
	if (!isRecord(value) || Object.keys(value).some(key => !['$mid', 'external', 'scheme', 'authority', 'path', 'query', 'fragment'].includes(key))
		|| !['scheme', 'authority', 'path', 'query'].every(key => typeof value[key] === 'string')
		|| value.$mid !== undefined && value.$mid !== 1
		|| value.fragment !== undefined && typeof value.fragment !== 'string') throw new TypeError('Invalid editor conversation resource');
	const resource = URI.from(value as unknown as UriComponents);
	// Ash's URI serialization includes its encoded spelling. Neither representation may redirect the other.
	if (value.external !== undefined && value.external !== resource.toString()) throw new TypeError('Inconsistent editor conversation resource');
	const link = parseOpenSessionLinkUri(resource);
	if (link.connectionAuthority !== 'local') throw new TypeError('Unknown editor conversation connection');
	return buildOpenSessionLinkUri(link.sessionId, link.threadId, link.connectionAuthority).toJSON();
}

export function validateAgentHostEditorUpdate(value: unknown): AgentHostEditorUpdate {
	if (!isRecord(value)) throw new TypeError('Invalid editor activity update');
	if (value.kind === 'request' && Object.keys(value).sort().join(',') === 'isNewSession,kind,requestSequence,resource' && typeof value.isNewSession === 'boolean' && Number.isSafeInteger(value.requestSequence) && (value.requestSequence as number) >= 0) {
		return { kind: 'request', resource: validateAgentHostEditorResource(value.resource), isNewSession: value.isNewSession, requestSequence: value.requestSequence as number };
	}
	if (value.kind === 'sessions' && Object.keys(value).sort().join(',') === 'kind,sessions' && Array.isArray(value.sessions) && value.sessions.length <= 128) {
		return {
			kind: 'sessions', sessions: value.sessions.map(session => {
				if (!isRecord(session) || Object.keys(session).sort().join(',') !== 'inProgress,needsInput,resource'
					|| typeof session.inProgress !== 'boolean' || typeof session.needsInput !== 'boolean') throw new TypeError('Invalid editor activity');
				return { resource: validateAgentHostEditorResource(session.resource), inProgress: session.inProgress, needsInput: session.needsInput };
			})
		};
	}
	if (value.kind === 'delete' && Object.keys(value).sort().join(',') === 'kind,resources' && Array.isArray(value.resources) && value.resources.length <= 128) {
		return { kind: 'delete', resources: value.resources.map(validateAgentHostEditorResource) };
	}
	throw new TypeError('Invalid editor activity update');
}

export function validateAgentsWindowInvitationId(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(value)) throw new TypeError('Invalid invitation ID');
	return value;
}

export function validateAgentsWindowInvitation(value: unknown): IAgentsWindowInvitation | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,resource,revision,shown,windowId'
		|| !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
		|| !Number.isSafeInteger(value.windowId) || (value.windowId as number) <= 0 || typeof value.shown !== 'boolean') throw new TypeError('Invalid invitation');
	return { id: validateAgentsWindowInvitationId(value.id), resource: validateAgentHostEditorResource(value.resource), revision: value.revision as number, windowId: value.windowId as number, shown: value.shown };
}

export function validateAgentHostEditorState(value: unknown): IAgentHostEditorState {
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'agentsWindowSessionCount,editorSessionCount,invitation,lastAgentsWindowSessionCreated,lastShown,revision,sessions'
		|| !['revision', 'editorSessionCount', 'agentsWindowSessionCount'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
		|| value.lastAgentsWindowSessionCreated !== undefined && (typeof value.lastAgentsWindowSessionCreated !== 'number' || !Number.isFinite(value.lastAgentsWindowSessionCreated) || value.lastAgentsWindowSessionCreated < 0)
		|| !Array.isArray(value.sessions) || value.sessions.length > 4096) throw new TypeError('Invalid editor activity state');
	const sessions = value.sessions.map(session => {
		if (!isRecord(session) || Object.keys(session).sort().join(',') !== 'inProgress,needsInput,resource,windowId'
			|| !Number.isSafeInteger(session.windowId) || (session.windowId as number) <= 0
			|| typeof session.inProgress !== 'boolean' || typeof session.needsInput !== 'boolean') throw new TypeError('Invalid editor activity state');
		return { resource: validateAgentHostEditorResource(session.resource), windowId: session.windowId as number, inProgress: session.inProgress, needsInput: session.needsInput };
	});
	if (value.lastShown !== undefined && (!isRecord(value.lastShown) || Object.keys(value.lastShown).sort().join(',') !== 'editorSessionCount,timestamp'
		|| typeof value.lastShown.editorSessionCount !== 'number' || !Number.isSafeInteger(value.lastShown.editorSessionCount) || value.lastShown.editorSessionCount < 0
		|| typeof value.lastShown.timestamp !== 'number' || !Number.isFinite(value.lastShown.timestamp) || value.lastShown.timestamp < 0)) throw new TypeError('Invalid invitation impression');
	return {
		revision: value.revision as number, editorSessionCount: value.editorSessionCount as number, agentsWindowSessionCount: value.agentsWindowSessionCount as number,
		lastAgentsWindowSessionCreated: value.lastAgentsWindowSessionCreated as number | undefined, sessions,
		invitation: validateAgentsWindowInvitation(value.invitation), lastShown: value.lastShown as IAgentHostEditorState['lastShown']
	};
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
