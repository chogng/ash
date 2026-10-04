import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';

export const IBrowserViewService = createServiceIdentifier<IBrowserViewService>('browserViewService');
export const BROWSER_VIEW_CREATE_CHANNEL = "ash:browser-view:create";
export const BROWSER_VIEW_STATE_CHANNEL = "ash:browser-view:state";
export const BROWSER_VIEW_LAYOUT_CHANNEL = "ash:browser-view:layout";
export const BROWSER_VIEW_VISIBILITY_CHANNEL =
	"ash:browser-view:visibility";
export const BROWSER_VIEW_NAVIGATE_CHANNEL =
	"ash:browser-view:navigate";
export const BROWSER_VIEW_GO_BACK_CHANNEL =
	"ash:browser-view:go-back";
export const BROWSER_VIEW_GO_FORWARD_CHANNEL =
	"ash:browser-view:go-forward";
export const BROWSER_VIEW_RELOAD_CHANNEL = "ash:browser-view:reload";
export const BROWSER_VIEW_STOP_CHANNEL = "ash:browser-view:stop";
export const BROWSER_VIEW_FOCUS_CHANNEL = "ash:browser-view:focus";
export const BROWSER_VIEW_CLOSE_CHANNEL = "ash:browser-view:close";
export const BROWSER_VIEW_EVENT_CHANNEL = "ash:browser-view:event";
export const BROWSER_VIEW_LIST_CHANNEL = 'ash:browser-view:list';

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
	readonly targetId: BrowserViewTargetId;
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly visible: boolean;
}

export type BrowserViewEvent =
	| { readonly type: 'created'; readonly info: IBrowserViewInfo }
	| { readonly type: "focusAddress"; readonly targetId: BrowserViewTargetId }
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

export type IBrowserViewOwner = { readonly type: 'user' } | { readonly type: 'agent'; readonly sessionId: string };

export enum BrowserViewStorageScope {
	Global = 'global',
	Workspace = 'workspace',
	Ephemeral = 'ephemeral',
	Agent = 'agent',
}

export type IBrowserViewSessionOptions =
	| { readonly scope: BrowserViewStorageScope.Global | BrowserViewStorageScope.Workspace | BrowserViewStorageScope.Ephemeral }
	| { readonly scope: BrowserViewStorageScope.Agent; readonly affinity: string };

export interface IBrowserViewInfo {
	readonly id: string;
	readonly host: { readonly windowId: number };
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
	getBrowserViews(): Promise<readonly IBrowserViewInfo[]>;
	getOrCreateBrowserView(id: string, options: IBrowserViewCreateOptions): Promise<IBrowserViewInfo>;
	getState(id: string): Promise<IBrowserViewState>;
	layout(id: string, bounds: IBrowserViewBounds): Promise<void>;
	setVisible(id: string, visible: boolean): Promise<void>;
	loadURL(id: string, url: string): Promise<void>;
	goBack(id: string): Promise<void>;
	goForward(id: string): Promise<void>;
	reload(id: string): Promise<void>;
	stop(id: string): Promise<void>;
	focus(id: string): Promise<void>;
	destroyBrowserView(id: string): Promise<void>;
	onDidEvent(listener: (event: BrowserViewEvent) => void): IDisposable;
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
	readonly screenshot?: { readonly mimeType: 'image/png'; readonly dataBase64: string; readonly decodedLength: number };
}
export type BrowserViewAction =
	| { readonly type: 'navigate'; readonly url: string }
	| { readonly type: 'click'; readonly target: { readonly nodeId: string } }
	| { readonly type: 'typeText'; readonly text: string; readonly target: { readonly type: 'focusedElement' } | { readonly type: 'element'; readonly target: { readonly nodeId: string } } }
	| { readonly type: 'scroll'; readonly deltaX: number; readonly deltaY: number }
	| { readonly type: 'goBack' | 'reload' };

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
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && localHttpHost) &&
		url.href !== "about:blank"
	) {
		throw new Error(
			"browser view URL must use HTTPS, loopback HTTP, or about:blank",
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
