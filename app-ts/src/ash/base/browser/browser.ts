export interface BrowserFeatures {
	readonly isFirefox: boolean;
	readonly isWebKit: boolean;
	readonly isChrome: boolean;
	readonly isSafari: boolean;
	readonly isWebkitWebView: boolean;
	readonly isElectron: boolean;
	readonly isAndroid: boolean;
	readonly isIOS: boolean;
}

export interface TrustedTypesPolicyOptions {
	readonly createHTML?: (value: string, ...arguments_: string[]) => string;
	readonly createScript?: (value: string, ...arguments_: string[]) => string;
	readonly createScriptURL?: (value: string, ...arguments_: string[]) => string;
}

export interface TrustedTypesPolicy {
	readonly name: string;
	readonly createHTML?: (value: string, ...arguments_: string[]) => string;
	readonly createScript?: (value: string, ...arguments_: string[]) => string;
	readonly createScriptURL?: (value: string, ...arguments_: string[]) => string;
}

export interface IMonacoEnvironment {
	createTrustedTypesPolicy?(policyName: string, policyOptions?: TrustedTypesPolicyOptions): TrustedTypesPolicy | undefined;
	getWorker?(moduleId: string, label: string): Worker | Promise<Worker>;
	getWorkerUrl?(moduleId: string, label: string): string;
	globalAPI?: boolean;
}

interface BrowserGlobals {
	readonly navigator?: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;
	readonly MonacoEnvironment?: IMonacoEnvironment;
}

/** Resolves browser-engine capabilities from one user-agent value. */
export function getBrowserFeatures(source: string | Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = browserGlobals.navigator ?? ''): Readonly<BrowserFeatures> {
	const userAgent = typeof source === 'string' ? source : source.userAgent;
	const maxTouchPoints = typeof source === 'string' ? 0 : source.maxTouchPoints;
	const isFirefox = userAgent.includes('Firefox');
	const isWebKit = userAgent.includes('AppleWebKit');
	const isChrome = userAgent.includes('Chrome') || userAgent.includes('Chromium');
	const isSafari = !isChrome && userAgent.includes('Safari');
	return Object.freeze({
		isFirefox,
		isWebKit,
		isChrome,
		isSafari,
		isWebkitWebView: !isChrome && !isSafari && isWebKit,
		isElectron: userAgent.includes('Electron/'),
		isAndroid: userAgent.includes('Android'),
		isIOS: maxTouchPoints > 0 && /Macintosh|iPad|iPhone/u.test(userAgent),
	});
}

/** Registers a media-query change listener without relying on deprecated listener APIs. */
export function addMatchMediaChangeListener(targetWindow: Window, query: string | MediaQueryList, listener: (this: MediaQueryList, event: MediaQueryListEvent) => unknown): void {
	const mediaQuery = typeof query === 'string' ? targetWindow.matchMedia(query) : query;
	mediaQuery.addEventListener('change', listener);
}

export function getMonacoEnvironment(): IMonacoEnvironment | undefined {
	return browserGlobals.MonacoEnvironment;
}

const browserGlobals = globalThis as BrowserGlobals;
const browserFeatures = getBrowserFeatures();

export const isFirefox = browserFeatures.isFirefox;
export const isWebKit = browserFeatures.isWebKit;
export const isChrome = browserFeatures.isChrome;
export const isSafari = browserFeatures.isSafari;
export const isWebkitWebView = browserFeatures.isWebkitWebView;
export const isElectron = browserFeatures.isElectron;
export const isAndroid = browserFeatures.isAndroid;
export const isIOS = browserFeatures.isIOS;
