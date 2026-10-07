import { Emitter, type Event } from "../common/event.js";
import {
	Disposable,
	DisposableStore,
	type IDisposable,

	toDisposable,
} from "../common/lifecycle.js";

export type BrowserWindow = Window & typeof globalThis;
export type CodeWindow = BrowserWindow;

export interface IRegisteredWindow {
	readonly id: number;
	readonly window: BrowserWindow;
	readonly disposables: DisposableStore;
}

const registrations = new Map<number, IRegisteredWindow>();
const windowIds = new WeakMap<Window, number>();
const onDidRegisterEmitter = new Emitter<IRegisteredWindow>();
const onWillUnregisterEmitter = new Emitter<IRegisteredWindow>();
const onDidUnregisterEmitter = new Emitter<BrowserWindow>();
let nextWindowId = 2;

export let mainWindow = globalThis.window as BrowserWindow;

registerMainWindowIfAvailable();

export const onDidRegisterWindow: Event<IRegisteredWindow> =
	onDidRegisterEmitter.event;
export const onWillUnregisterWindow: Event<IRegisteredWindow> =
	onWillUnregisterEmitter.event;
export const onDidUnregisterWindow: Event<BrowserWindow> =
	onDidUnregisterEmitter.event;

/**
 * Registers an auxiliary browser window and owns resources scoped to its
 * lifetime.
 */
export function registerWindow(targetWindow: Window): IDisposable {
	registerMainWindowIfAvailable();
	if (windowIds.has(targetWindow)) {
		throw new Error("Browser window is already registered");
	}

	const id = nextWindowId++;
	const lifecycle = new WindowRegistrationLifecycle();
	const registration: IRegisteredWindow = {
		id,
		window: targetWindow as BrowserWindow,
		disposables: lifecycle.disposables,
	};
	lifecycle.initialize(registration);
	registrations.set(id, registration);
	windowIds.set(targetWindow, id);
	onDidRegisterEmitter.fire(registration);
	return lifecycle;
}

export function getWindows(): readonly IRegisteredWindow[] {
	registerMainWindowIfAvailable();
	return [...registrations.values()];
}

export function getWindowById(id: number): IRegisteredWindow | undefined {
	registerMainWindowIfAvailable();
	return registrations.get(id);
}

export function getWindowId(targetWindow: Window): number | undefined {
	registerMainWindowIfAvailable();
	return windowIds.get(targetWindow);
}

export function isRegisteredWindow(targetWindow: Window): boolean {
	registerMainWindowIfAvailable();
	return windowIds.has(targetWindow);
}

/** Opens a new browsing context without exposing the opener capability. */
export function openWindowNoOpener(
	targetWindow: Window,
	url: URL,
): void {
	targetWindow.open(url.toString(), "_blank", "noopener");
}

export interface PopupWindowOptions {
	readonly width?: number;
	readonly height?: number;
	readonly left?: number;
	readonly top?: number;
}

/** Opens a popup without exposing the opener capability. */
export function openPopupWindow(
	targetWindow: Window,
	url: URL,
	options: PopupWindowOptions = {},
): void {
	const features = [
		"popup=yes",
		"noopener",
		options.width === undefined ? undefined : `width=${options.width}`,
		options.height === undefined ? undefined : `height=${options.height}`,
		options.left === undefined ? undefined : `left=${options.left}`,
		options.top === undefined ? undefined : `top=${options.top}`,
	].filter((feature): feature is string => feature !== undefined);
	targetWindow.open(url.toString(), "_blank", features.join(","));
}

export function isWindow(value: unknown): value is Window {
	return typeof value === "object" &&
		value !== null &&
		"window" in value &&
		(value as Window).window === value;
}

function registerMainWindowIfAvailable(): void {
	const targetWindow = globalThis.window as BrowserWindow | undefined;
	if (!targetWindow || windowIds.has(targetWindow)) return;
	mainWindow = targetWindow;
	const registration: IRegisteredWindow = {
		id: 1,
		window: targetWindow,
		disposables: new DisposableStore(),
	};
	registrations.set(registration.id, registration);
	windowIds.set(targetWindow, registration.id);
}

class WindowRegistrationLifecycle extends Disposable {
	readonly disposables: DisposableStore;
	private registration: IRegisteredWindow | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => {
			const registration = this.registration;
			if (!registration) return;
			registrations.delete(registration.id);
			windowIds.delete(registration.window);
			onDidUnregisterEmitter.fire(registration.window);
			this.registration = undefined;
		}));
		this.disposables = this._register(new DisposableStore());
		this._register(toDisposable(() => {
			if (this.registration) {
				onWillUnregisterEmitter.fire(this.registration);
			}
		}));
	}

	initialize(registration: IRegisteredWindow): void {
		this.registration = registration;
	}
}
