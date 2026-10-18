import type { IPermissionCategoryState, ISerializedBrowserPermissionsSnapshot } from './browserPermissions.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ISerializedBrowserHistoryEntriesSnapshot } from './browserHistory.js';
import type { VSBuffer } from '../../../base/common/buffer.js';

/** Stable command IDs shared by browser controls, keybindings and external callers. */
export enum BrowserViewCommandId {
	Open = 'workbench.action.browser.open',
	OpenExternal = 'workbench.action.browser.openExternal',
	OpenSettings = 'workbench.action.browser.openSettings',
	OpenFile = 'workbench.action.browser.openFile',
	NewTab = 'workbench.action.browser.newTab',
	QuickOpen = 'workbench.action.browser.quickOpen',
	CloseAll = 'workbench.action.browser.closeAll',
	CloseAllInGroup = 'workbench.action.browser.closeAllInGroup',
	GoBack = 'workbench.action.browser.goBack',
	GoForward = 'workbench.action.browser.goForward',
	Reload = 'workbench.action.browser.reload',
	HardReload = 'workbench.action.browser.hardReload',
	FocusUrlInput = 'workbench.action.browser.focusUrlInput',
	AddConsoleLogsToChat = 'workbench.action.browser.addConsoleLogsToChat',
	AddScreenshotToChat = 'workbench.action.browser.addScreenshotToChat',
	AddFullPageScreenshotToChat = 'workbench.action.browser.addFullPageScreenshotToChat',
	ManagePermissions = 'workbench.action.browser.managePermissions',
	ShowHistory = 'workbench.action.browser.showHistory',
	ToggleFavorite = 'workbench.action.browser.toggleFavorite',
	ShowFind = 'workbench.action.browser.showFind',
	HideFind = 'workbench.action.browser.hideFind',
	FindNext = 'workbench.action.browser.findNext',
	FindPrevious = 'workbench.action.browser.findPrevious',
}

export const IBrowserViewService = createServiceIdentifier<IBrowserViewService>('browserViewService');
export const ipcBrowserViewChannelName = 'browserView';
export const browserViewIsolatedWorldId = 999;

export interface IBrowserViewKeyDownEvent {
	readonly key: string;
	readonly keyCode: number;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly repeat: boolean;
}

export enum BrowserElementSelectionMode { Select = 'select', Comment = 'comment' }
export interface IBrowserElementSelectionOptions {
	readonly highlightFocusedElement?: boolean;
	readonly continuous?: boolean;
	readonly mode?: BrowserElementSelectionMode;
}
export interface IBrowserViewRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface IElementData {
	readonly url?: string;
	readonly elementId?: string;
	readonly comment?: string;
	readonly outerHTML: string;
	readonly computedStyle: string;
	readonly bounds: IBrowserViewRect;
	readonly innerText?: string;
}
export interface IBrowserElementComment { readonly elementId: string; readonly body: string; }
export interface IBrowserElementCommentsUpdate {
	readonly comments?: readonly IBrowserElementComment[];
	readonly pendingCommentIdsToDiscard?: readonly string[];
}
export interface IBrowserViewTheme {
	readonly focusBorder?: string;
	readonly buttonBackground?: string;
	readonly buttonForeground?: string;
	readonly widgetBackground?: string;
	readonly widgetForeground?: string;
	readonly widgetBorder?: string;
	readonly contrastBorder?: string;
}
export interface IBrowserViewPreloadLocalizedStrings {
	readonly addComment: string;
	readonly addCommentPlaceholder: string;
	readonly commentOnSelectedElement: string;
	readonly elementComment: string;
	readonly elementCommentWithBody: string;
	readonly emptyElementComment: string;
	readonly removeComment: string;
	readonly removeElementComment: string;
	readonly cancel: string;
	readonly selectionHelp: string;
}
export interface IBrowserViewWindowConfiguration {
	readonly theme: IBrowserViewTheme;
	readonly localizedStrings: IBrowserViewPreloadLocalizedStrings;
}
export interface IBrowserViewCaptureScreenshotOptions {
	readonly fullPage?: boolean;
	readonly format?: 'jpeg' | 'png';
	readonly quality?: number;
	readonly screenRect?: IBrowserViewRect;
	readonly awaitNextPaint?: boolean;
}
export interface IBrowserViewFindInPageOptions { readonly recompute?: boolean; readonly forward?: boolean; readonly matchCase?: boolean; }

export const browserZoomFactors = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
export const browserZoomDefaultIndex = browserZoomFactors.indexOf(1);
export interface IBrowserDeviceProfile {
	readonly width?: number;
	readonly height?: number;
	readonly mobile?: boolean;
	readonly userAgent?: string;
	readonly deviceScaleFactor?: number;
}

export type BrowserViewTargetId = string;

/** Window-content coordinates used to place an embedded browser page. */
export interface IBrowserViewBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface IBrowserViewCreateRequest {
	readonly targetId: string;
	readonly options: IBrowserViewCreateOptions;
}

export interface IBrowserViewTargetRequest {
	readonly targetId: BrowserViewTargetId;
}

export interface IBrowserViewLayoutRequest extends IBrowserViewTargetRequest {
	readonly bounds: IBrowserViewBounds;
}

export interface IBrowserViewVisibilityRequest
	extends IBrowserViewTargetRequest {
	readonly visible: boolean;
}

export interface IBrowserViewNavigateRequest
	extends IBrowserViewTargetRequest {
	readonly url: string;
}

/** Serializable host-authoritative state for one embedded browser. */
export interface IBrowserViewState {
	readonly permissions?: ISerializedBrowserPermissionsSnapshot;
	readonly browserZoomIndex?: number;
	readonly deviceEmulation?: IBrowserDeviceProfile;
	readonly targetId: BrowserViewTargetId;
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly visible: boolean;
	readonly errorDescription?: string;
}

export type BrowserViewEvent =
	| { readonly type: 'passwordSaveRequested'; readonly targetId: string; readonly requestId: string; readonly origin: string; readonly username: string; readonly update: boolean; }
	| { readonly type: 'passwordFillRequested'; readonly targetId: string; readonly requestId: string; readonly origin: string; readonly accounts: readonly { readonly id: string; readonly username: string; }[]; }
	| { readonly type: 'passwordRequestClosed'; readonly targetId: string; readonly requestId: string; }
	| { readonly type: 'authenticationRequested'; readonly targetId: string; readonly requestId: string; readonly origin: string; readonly realm: string; readonly isProxy: boolean; readonly canRemember: boolean; readonly storageFailed: boolean; }
	| { readonly type: 'authenticationRequestClosed'; readonly targetId: string; readonly requestId: string; }
	| { readonly type: 'authenticationStorageFailed'; readonly targetId: string; }
	| { readonly type: 'fileRequested'; readonly targetId: string; readonly requestId: string; readonly url: string; }
	| { readonly type: 'keyDown'; readonly targetId: string; readonly event: IBrowserViewKeyDownEvent; }
	| { readonly type: 'elementPicked'; readonly targetId: string; readonly data: IElementData; }
	| { readonly type: 'elementCommentRemoved'; readonly targetId: string; readonly elementId: string; }
	| { readonly type: 'areaPicked'; readonly targetId: string; readonly rect: IBrowserViewRect; }
	| { readonly type: 'selectionStopped'; readonly targetId: string; }
	| { readonly type: 'networkRequested'; readonly targetId: string; readonly requestId: string; readonly networkToken: string; readonly url: string; readonly method: string; }
	| { readonly type: 'created'; readonly info: IBrowserViewInfo; }
	| { readonly type: 'sharingChanged'; readonly targetId: string; readonly threadIds: readonly string[]; }
	| { readonly type: 'permissionRequested'; readonly targetId: string; readonly requestId: string; readonly origin: string; readonly permission: string; }
	| { readonly type: 'permissionRequestClosed'; readonly targetId: string; readonly requestId: string; }
	| { readonly type: 'downloadProgress'; readonly targetId: string; readonly filename: string; readonly receivedBytes: number; readonly totalBytes: number; readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; }
	| { readonly type: "focusAddress"; readonly targetId: BrowserViewTargetId; }
	| {
		readonly type: "stateChanged";
		readonly state: IBrowserViewState;
	}
	| {
		readonly type: "loadFailed";
		readonly targetId: BrowserViewTargetId;
		readonly url: string;
		readonly errorCode: number;
		readonly errorDescription: string;
	}
	| {
		readonly type: "openRequested";
		readonly targetId: BrowserViewTargetId;
		readonly url: string;
	}
	| {
		readonly type: "renderProcessGone";
		readonly targetId: BrowserViewTargetId;
		readonly reason: string;
	}
	| {
		readonly type: "closed";
		readonly targetId: BrowserViewTargetId;
	};

export interface IBrowserViewCreateOptions {
	readonly initialUrl: string;
	readonly owner: IBrowserViewOwner;
	readonly session: IBrowserViewSessionOptions;
}

export type IBrowserViewOwner = { readonly type: 'user'; } | { readonly type: 'agent'; readonly sessionId: string; };

export enum BrowserViewStorageScope {
	Global = 'global',
	Workspace = 'workspace',
	Ephemeral = 'ephemeral',
	Agent = 'agent',
}

export interface IBrowserViewStorageKeys {
	readonly history?: string;
	readonly favicons?: string;
}

export type IBrowserViewSessionOptions =
	| { readonly scope: BrowserViewStorageScope.Global | BrowserViewStorageScope.Workspace | BrowserViewStorageScope.Ephemeral; }
	| { readonly scope: BrowserViewStorageScope.Agent; readonly affinity: string; };

export interface IBrowserViewInfo {
	readonly remoteAuthority?: string;
	readonly id: string;
	readonly host: { readonly windowId: number; };
	readonly owner: IBrowserViewOwner;
	readonly session: IBrowserViewSessionOptions;
	readonly state: IBrowserViewState;
}

/**
 * Narrow workbench capability for main-owned Electron WebContentsViews.
 *
 * Electron objects never cross this boundary; callers exchange validated,
 * serializable commands and state only.
 */
export interface IBrowserViewService {
	respondToPasswordSave(id: string, requestId: string, save: boolean): Promise<void>;
	respondToPasswordFill(id: string, requestId: string, accountId: string | null): Promise<void>;
	respondToAuthentication(id: string, requestId: string, credentials: { readonly username: string; readonly password: string; readonly remember: boolean; } | null): Promise<void>;
	/** Defer rendering matching elements on one HTTPS or bundled-page origin; undefined restores page-owned styles. */
	setContentVisibility(id: string, rule: IBrowserContentVisibilityRule | undefined): Promise<void>;
	setPermissions(id: string, origin: string, grants: readonly IPermissionCategoryState[]): Promise<void>;
	respondToFileRequest(id: string, requestId: string, data: string | null): Promise<void>;
	toggleDevTools(id: string): Promise<void>;
	setBrowserZoomIndex(id: string, zoomIndex: number): Promise<void>;
	setDeviceEmulation(id: string, device: IBrowserDeviceProfile | undefined): Promise<void>;
	clearStorage(id: string): Promise<void>;
	updateWindowConfiguration(windowId: number, configuration: IBrowserViewWindowConfiguration): Promise<void>;
	getConsoleLogs(id: string): Promise<string>;
	getSelectedText(id: string): Promise<string>;
	findInPage(id: string, text: string, options?: IBrowserViewFindInPageOptions): Promise<void>;
	stopFindInPage(id: string, keepSelection?: boolean): Promise<void>;
	toggleElementSelection(id: string, enabled?: boolean, options?: IBrowserElementSelectionOptions): Promise<void>;
	setElementComments(id: string, update: IBrowserElementCommentsUpdate): Promise<void>;
	toggleAreaSelection(id: string, enabled?: boolean): Promise<void>;
	captureScreenshot(id: string, options?: IBrowserViewCaptureScreenshotOptions): Promise<VSBuffer>;
	getBrowserHistory(id: string): Promise<ISerializedBrowserHistoryEntriesSnapshot>;
	deleteBrowserHistory(id: string, entryIds?: readonly number[]): Promise<void>;
	getSharing(id: string): Promise<readonly string[]>;
	setSharing(id: string, threadIds: readonly string[]): Promise<void>;
	respondToPermission(id: string, requestId: string, allowed: boolean): Promise<void>;
	clearPermissions(id: string): Promise<void>;
	cancelDownloads(id: string): Promise<void>;
	getBrowserViews(): Promise<readonly IBrowserViewInfo[]>;
	getOrCreateBrowserView(id: string, options: IBrowserViewCreateOptions): Promise<IBrowserViewInfo>;
	getState(id: string): Promise<IBrowserViewState>;
	layout(id: string, bounds: IBrowserViewBounds): Promise<void>;
	setVisible(id: string, visible: boolean): Promise<void>;
	loadURL(id: string, url: string): Promise<void>;
	goBack(id: string): Promise<void>;
	goForward(id: string): Promise<void>;
	reload(id: string, hard?: boolean): Promise<void>;
	stop(id: string): Promise<void>;
	focus(id: string): Promise<void>;
	destroyBrowserView(id: string): Promise<void>;
	onDidEvent(listener: (event: BrowserViewEvent) => void): IDisposable;
}

export interface IBrowserContentVisibilityRule {
	readonly origin: string;
	readonly selector: string;
}

/** Parameters for observations of the page currently owned by this view. */
export interface IBrowserViewObservationOptions {
	readonly includeAccessibilityTree: boolean;
	readonly includeDomSnapshot: boolean;
	readonly includeScreenshot: boolean;
}
export interface IBrowserViewObservation {
	readonly targetId: string;
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	readonly accessibilityTree?: string;
	readonly domSnapshot?: string;
	readonly screenshot?: { readonly mimeType: 'image/png'; readonly dataBase64: string; readonly decodedLength: number; };
}
export type BrowserViewAction =
	| { readonly type: 'cdp'; readonly operation: BrowserCDPOperation; }
	| { readonly type: 'hover'; readonly target: { readonly nodeId: string; }; }
	| { readonly type: 'drag'; readonly source: { readonly nodeId: string; }; readonly destination: { readonly nodeId: string; }; }
	| { readonly type: 'handleDialog'; readonly accept: boolean; readonly promptText?: string | null; }
	| { readonly type: 'runPlaywright'; readonly code: string; }
	| { readonly type: 'navigate'; readonly url: string; }
	| { readonly type: 'click'; readonly target: { readonly nodeId: string; }; }
	| { readonly type: 'typeText'; readonly text: string; readonly target: { readonly type: 'focusedElement'; } | { readonly type: 'element'; readonly target: { readonly nodeId: string; }; }; }
	| { readonly type: 'scroll'; readonly deltaX: number; readonly deltaY: number; }
	| { readonly type: 'goBack' | 'reload'; };

/** A connection is scoped to one Thread's Agent pages; event buffers are explicitly drained. */
export type BrowserCDPOperation =
	| { readonly type: 'command'; readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string; }
	| { readonly type: 'readEvents'; }
	| { readonly type: 'close'; };

/** File bytes read by the backend under the originating task's path permissions. */
export interface IBrowserUploadFile { readonly name: string; readonly dataBase64: string; }

export const BrowserChatToolsSettingId = 'workbench.browser.enableChatTools';
export const BrowserCDPSettingId = 'workbench.browser.enableCDP';

const MAX_URL_LENGTH = 8192;
const MAX_BOUND_MAGNITUDE = 100_000;
const TARGET_ID_PATTERN =
	/^browser_target_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateBrowserViewCreateRequest(
	value: unknown,
): IBrowserViewCreateRequest {
	const request = exactRecord(value, ['targetId', 'options'], 'browser view create request');
	const options = exactRecord(request.options, ['initialUrl', 'owner', 'session'], 'browser view options');
	const owner = validateBrowserViewOwner(options.owner);
	const session = validateBrowserViewSessionOptions(options.session);
	if (owner.type === 'agent' && (session.scope !== BrowserViewStorageScope.Agent || session.affinity !== owner.sessionId)) {
		throw new Error('Agent browser storage must belong to its session');
	}
	return { targetId: validateTargetId(request.targetId), options: { initialUrl: normalizeBrowserViewUrl(options.initialUrl), owner, session } };
}

function validateBrowserViewOwner(value: unknown): IBrowserViewOwner {
	const owner = value as Record<string, unknown> | null;
	if (owner?.type === 'user') {
		exactRecord(value, ['type'], 'browser view owner');
		return { type: 'user' };
	}
	exactRecord(value, ['type', 'sessionId'], 'browser view owner');
	if (owner?.type !== 'agent' || typeof owner.sessionId !== 'string' || !owner.sessionId.trim()) {
		throw new Error('Invalid browser view owner');
	}
	return { type: 'agent', sessionId: owner.sessionId };
}

function validateBrowserViewSessionOptions(value: unknown): IBrowserViewSessionOptions {
	const session = value as Record<string, unknown> | null;
	if (session?.scope === BrowserViewStorageScope.Agent) {
		exactRecord(value, ['scope', 'affinity'], 'browser session');
		if (typeof session.affinity !== 'string' || !session.affinity.trim()) {
			throw new Error('Invalid browser storage affinity');
		}
		return { scope: BrowserViewStorageScope.Agent, affinity: session.affinity };
	}
	exactRecord(value, ['scope'], 'browser session');
	if (session?.scope !== BrowserViewStorageScope.Global && session?.scope !== BrowserViewStorageScope.Workspace && session?.scope !== BrowserViewStorageScope.Ephemeral) {
		throw new Error('Invalid browser storage scope');
	}
	return { scope: session.scope };
}

export function validateBrowserViewTargetRequest(
	value: unknown,
): IBrowserViewTargetRequest {
	const request = exactRecord(
		value,
		["targetId"],
		"browser view target request",
	);
	return { targetId: validateTargetId(request.targetId) };
}

export function validateBrowserViewLayoutRequest(
	value: unknown,
): IBrowserViewLayoutRequest {
	const request = exactRecord(
		value,
		["bounds", "targetId"],
		"browser view layout request",
	);
	const bounds = exactRecord(
		request.bounds,
		["height", "width", "x", "y"],
		"browser view bounds",
	);
	return {
		targetId: validateTargetId(request.targetId),
		bounds: {
			x: boundedInteger(bounds.x, "bounds.x", true),
			y: boundedInteger(bounds.y, "bounds.y", true),
			width: boundedInteger(bounds.width, "bounds.width", false),
			height: boundedInteger(bounds.height, "bounds.height", false),
		},
	};
}

export function validateBrowserViewVisibilityRequest(
	value: unknown,
): IBrowserViewVisibilityRequest {
	const request = exactRecord(
		value,
		["targetId", "visible"],
		"browser view visibility request",
	);
	if (typeof request.visible !== "boolean") {
		throw new Error("browser view visible must be a boolean");
	}
	return {
		targetId: validateTargetId(request.targetId),
		visible: request.visible,
	};
}

export function validateBrowserViewNavigateRequest(
	value: unknown,
): IBrowserViewNavigateRequest {
	const request = exactRecord(
		value,
		["targetId", "url"],
		"browser view navigate request",
	);
	return {
		targetId: validateTargetId(request.targetId),
		url: normalizeBrowserViewUrl(request.url),
	};
}

/** Normalizes URLs accepted by the embedded browser origin policy. */
export function normalizeBrowserViewUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("browser view URL must be a non-empty string");
	}
	if (value.length > MAX_URL_LENGTH) {
		throw new Error("browser view URL is too long");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("browser view URL is invalid");
	}
	if (url.username || url.password) {
		throw new Error("browser view URL credentials are not allowed");
	}
	const localHttpHost =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	const localFile = url.protocol === 'file:' && (url.hostname === '' || url.hostname === 'localhost');
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && localHttpHost) &&
		!localFile &&
		url.href !== "about:blank"
	) {
		throw new Error(
			"browser view URL must use HTTPS, loopback HTTP, a local file, or about:blank",
		);
	}
	return url.href;
}

function validateTargetId(value: unknown): BrowserViewTargetId {
	if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) {
		throw new Error("browser view targetId is invalid");
	}
	return value;
}

function boundedInteger(
	value: unknown,
	field: string,
	allowNegative: boolean,
): number {
	if (
		!Number.isSafeInteger(value) ||
		Math.abs(value as number) > MAX_BOUND_MAGNITUDE ||
		(!allowNegative && (value as number) <= 0)
	) {
		throw new Error(`${field} is outside the supported integer range`);
	}
	return value as number;
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
	label: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const result = value as Record<string, unknown>;
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
	}
	return result;
}
