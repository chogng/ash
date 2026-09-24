import { IntervalTimer, type IntervalTimerContext } from "../common/async.js";
import { Emitter, type Event as BaseEvent } from "../common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../common/lifecycle.js";
import { type BrowserWindow, getWindows, isWindow, mainWindow } from "./window.js";

type DomListenerOptions = boolean | AddEventListenerOptions;
type DomChild = Node | string;
type DomTreeChild =
	| Node
	| string
	| number
	| false
	| null
	| undefined
	| readonly DomTreeChild[];

const DOCUMENT_NODE_TYPE = 9;
const ELEMENT_NODE_TYPE = 1;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

export { runAtThisOrScheduleAtNextAnimationFrame, scheduleAtNextAnimationFrame } from "./scheduler.js";
export { getWindowById, getWindowId } from './window.js';

export interface IDimension {
	readonly width: number;
	readonly height: number;
}

export class Dimension implements IDimension {
	static readonly Zero = new Dimension(0, 0);
	static readonly None = Dimension.Zero;

	constructor(readonly width: number, readonly height: number) {}

	with(width = this.width, height = this.height): Dimension {
		return width === this.width && height === this.height ? this : new Dimension(width, height);
	}

	static is(value: unknown): value is IDimension {
		return typeof value === "object" && value !== null && typeof (value as IDimension).width === "number" && typeof (value as IDimension).height === "number";
	}

	static lift(value: IDimension): Dimension {
		return value instanceof Dimension ? value : new Dimension(value.width, value.height);
	}

	static equals(left: IDimension | undefined, right: IDimension | undefined): boolean {
		return left === right || Boolean(left && right && left.width === right.width && left.height === right.height);
	}
}

export interface IDomNodePagePosition extends IDimension {
	readonly left: number;
	readonly top: number;
}

export function getClientArea(element: HTMLElement, defaultValue?: Dimension, fallbackElement?: HTMLElement): Dimension {
	const targetWindow = getWindow(element);
	if (element !== targetWindow.document.body) return new Dimension(element.clientWidth, element.clientHeight);
	const viewport = targetWindow.visualViewport;
	if (viewport) return new Dimension(viewport.width, viewport.height);
	if (targetWindow.innerWidth && targetWindow.innerHeight) return new Dimension(targetWindow.innerWidth, targetWindow.innerHeight);
	const body = targetWindow.document.body;
	if (body.clientWidth && body.clientHeight) return new Dimension(body.clientWidth, body.clientHeight);
	const documentElement = targetWindow.document.documentElement;
	if (documentElement.clientWidth && documentElement.clientHeight) return new Dimension(documentElement.clientWidth, documentElement.clientHeight);
	if (fallbackElement) return getClientArea(fallbackElement, defaultValue);
	if (defaultValue) return defaultValue;
	throw new Error("Unable to determine browser client area");
}

export function getDomNodePagePosition(element: HTMLElement): IDomNodePagePosition {
	const bounds = element.getBoundingClientRect();
	const targetWindow = getWindow(element);
	return {
		left: bounds.left + targetWindow.scrollX,
		top: bounds.top + targetWindow.scrollY,
		width: bounds.width,
		height: bounds.height,
	};
}

/** Schedules cancellable work during an idle period with a timer fallback. */
export function runWhenWindowIdle(targetWindow: Window | typeof globalThis, callback: (idle: IdleDeadline) => void, timeout?: number): IDisposable {
	const idleWindow = targetWindow as typeof globalThis & {
		requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
		cancelIdleCallback?: (handle: number) => void;
	};
	if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
		const handle = idleWindow.requestIdleCallback(callback, { timeout });
		return toDisposable(() => idleWindow.cancelIdleCallback?.(handle));
	}

	const started = targetWindow.performance.now();
	const handle = targetWindow.setTimeout(() => callback({
		didTimeout: timeout !== undefined,
		timeRemaining: () => Math.max(0, 50 - (targetWindow.performance.now() - started)),
	}), timeout ?? 0);
	return toDisposable(() => (targetWindow.clearTimeout as (value: typeof handle) => void)(handle));
}

/** Computes a value during window idle time, or synchronously when first requested. */
export class WindowIdleValue<T> implements IDisposable {
	private readonly executor: () => void;
	private readonly registration: IDisposable;
	private initialized = false;
	private result: T | undefined;
	private error: unknown;

	constructor(targetWindow: Window, executor: () => T) {
		this.executor = () => {
			if (this.initialized) return;
			try {
				this.result = executor();
			} catch (error) {
				this.error = error;
			} finally {
				this.initialized = true;
			}
		};
		this.registration = runWhenWindowIdle(targetWindow, this.executor);
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get value(): T {
		if (!this.initialized) {
			this.registration.dispose();
			this.executor();
		}
		if (this.error !== undefined) throw this.error;
		return this.result as T;
	}

	dispose(): void {
		this.registration.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

export class WindowIntervalTimer extends IntervalTimer {
	private readonly defaultWindow: Window | undefined;

	constructor(node?: Node) {
		super();
		this.defaultWindow = node ? getWindow(node) : undefined;
	}

	override cancelAndSet(runner: () => void, interval: number, targetWindow: IntervalTimerContext = this.defaultWindow ?? getActiveWindow()): void {
		super.cancelAndSet(runner, interval, targetWindow);
	}
}

export interface IExternalFocusInfo {
	readonly hasFocus: boolean;
	readonly window?: BrowserWindow;
}

export type ExternalFocusChecker = () => IExternalFocusInfo;

const externalFocusCheckers = new Set<ExternalFocusChecker>();

export function registerExternalFocusChecker(checker: ExternalFocusChecker): IDisposable {
	externalFocusCheckers.add(checker);
	return toDisposable(() => externalFocusCheckers.delete(checker));
}

export function getExternalFocusWindow(): BrowserWindow | undefined {
	for (const checker of externalFocusCheckers) {
		const result = checker();
		if (result.hasFocus) return result.window;
	}
	return undefined;
}

export function hasAppFocus(): boolean {
	return getWindows().some(({ window }) => window.document.hasFocus()) ||
		[...externalFocusCheckers].some(checker => checker().hasFocus);
}

export function getActiveWindow(): BrowserWindow {
	return getWindows().find(({ window }) => window.document.hasFocus())?.window ??
		getExternalFocusWindow() ??
		getMainWindow();
}

export function getActiveDocument(): Document {
	return getActiveWindow().document;
}

/** Returns the deepest active element, including open shadow roots. */
export function getActiveElement(root: Document | ShadowRoot = getActiveDocument()): Element | null {
	let active = root.activeElement;
	while (active?.shadowRoot?.activeElement) {
		active = active.shadowRoot.activeElement;
	}
	return active;
}

/** Resolves the owning window for a node, document, event, or window. */
export function getWindow(source?: Node | Document | UIEvent | Window | null): BrowserWindow {
	if (!source) return getMainWindow();
	if (isWindow(source)) return source as BrowserWindow;
	if ("nodeType" in source && source.nodeType === DOCUMENT_NODE_TYPE) {
		return ((source as Document).defaultView ?? getMainWindow()) as BrowserWindow;
	}
	if ("ownerDocument" in source) {
		return (source.ownerDocument?.defaultView ?? getMainWindow()) as BrowserWindow;
	}
	return (source.view ?? getMainWindow()) as BrowserWindow;
}

export function getDocument(source?: Node | Document | UIEvent | Window | null): Document {
	return getWindow(source).document;
}

export function $<T extends HTMLElement>(description: string, attrs?: { [key: string]: any }, ...children: Array<Node | string>): T {
	const match = /^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/.exec(description);
	if (!match) throw new Error(`Invalid DOM description '${description}'`);
	const result = getActiveDocument().createElement(match[1] || 'div') as T;
	if (match[2]) result.id = match[2];
	if (match[3]) result.className = match[3].slice(1).replace(/\./g, ' ');
	for (const [name, value] of Object.entries(attrs ?? {})) {
		if (value === undefined) continue;
		if (/^on\w+$/.test(name)) {
			(result as unknown as Record<string, unknown>)[name] = value;
		} else if (name !== 'selected' || value) {
			result.setAttribute(name, String(value));
		}
	}
	result.append(...children);
	return result;
}

/** Keeps a CSS size on a stable whole-screen-pixel boundary. */
export function computeScreenAwareSize(targetWindow: Window, cssPixels: number): number {
	return Math.max(1, Math.floor(targetWindow.devicePixelRatio * cssPixels)) / targetWindow.devicePixelRatio;
}

function getMainWindow(): BrowserWindow {
	getWindows();
	if (!mainWindow) throw new Error("A browser window is required");
	return mainWindow;
}

export interface IModifierKeyStatus {
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
}

/** Tracks modifier keys for one browser window. */
export class ModifierKeyEmitter extends Disposable {
	private static readonly instances = new WeakMap<Window, ModifierKeyEmitter>();
	private readonly _onDidChange = this._register(new Emitter<IModifierKeyStatus>());
	private status: IModifierKeyStatus = emptyModifierKeyStatus();

	readonly event: BaseEvent<IModifierKeyStatus> = this._onDidChange.event;

	private constructor(targetWindow: Window) {
		super();
		this._register(addDisposableListener(targetWindow, "keydown", (event: KeyboardEvent) => this.update(event), true));
		this._register(addDisposableListener(targetWindow, "keyup", (event: KeyboardEvent) => this.update(event), true));
		this._register(addDisposableListener(targetWindow, "mousedown", (event: MouseEvent) => this.update(event), true));
		this._register(addDisposableListener(targetWindow, "mouseup", (event: MouseEvent) => this.update(event), true));
		this._register(addDisposableListener(targetWindow, "blur", () => this.reset()));
	}

	static getInstance(targetWindow: Window): ModifierKeyEmitter {
		let instance = this.instances.get(targetWindow);
		if (!instance) {
			instance = new ModifierKeyEmitter(targetWindow);
			this.instances.set(targetWindow, instance);
		}
		return instance;
	}

	static disposeInstance(targetWindow: Window): void {
		const instance = this.instances.get(targetWindow);
		if (!instance) return;
		this.instances.delete(targetWindow);
		instance.dispose();
	}

	get keyStatus(): IModifierKeyStatus {
		return this.status;
	}

	private update(event: KeyboardEvent | MouseEvent): void {
		const status: IModifierKeyStatus = {
			altKey: event.altKey,
			shiftKey: event.shiftKey,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
		};
		if (sameModifierKeyStatus(this.status, status)) return;
		this.status = status;
		this._onDidChange.fire(status);
	}

	private reset(): void {
		const status = emptyModifierKeyStatus();
		if (sameModifierKeyStatus(this.status, status)) return;
		this.status = status;
		this._onDidChange.fire(status);
	}
}

function emptyModifierKeyStatus(): IModifierKeyStatus {
	return { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
}

function sameModifierKeyStatus(left: IModifierKeyStatus, right: IModifierKeyStatus): boolean {
	return left.altKey === right.altKey &&
		left.shiftKey === right.shiftKey &&
		left.ctrlKey === right.ctrlKey &&
		left.metaKey === right.metaKey;
}

/**
 * Registers a DOM event listener whose removal participates in disposable
 * ownership.
 */
export function addDisposableListener<
	K extends keyof GlobalEventHandlersEventMap,
>(
	target: EventTarget,
	type: K,
	listener: (event: GlobalEventHandlersEventMap[K]) => void,
	options?: DomListenerOptions,
): IDisposable;
export function addDisposableListener<TEvent extends Event>(
	target: EventTarget,
	type: string,
	listener: (event: TEvent) => void,
	options?: DomListenerOptions,
): IDisposable;
export function addDisposableListener(
	target: EventTarget,
	type: string,
	listener: (event: Event) => void,
	options?: DomListenerOptions,
): IDisposable {
	const eventListener = listener as EventListener;
	target.addEventListener(type, eventListener, options);
	const capture = typeof options === "boolean" ? options : options?.capture ?? false;
	let activeTarget: EventTarget | undefined = target;
	let activeListener: EventListener | undefined = eventListener;
	return toDisposable(() => {
		if (activeTarget && activeListener) {
			activeTarget.removeEventListener(type, activeListener, capture);
		}
		activeTarget = undefined;
		activeListener = undefined;
	});
}

/** Replaces a container's children with the supplied nodes or text. */
export function reset(
	parent: Element | DocumentFragment,
	...children: readonly DomChild[]
): void {
	parent.replaceChildren(...children);
}

/** Tests DOM ancestry without assuming that either node is connected. */
export function isAncestor(
	candidate: Node | null,
	ancestor: Node | null,
): boolean {
	return Boolean(candidate && ancestor?.contains(candidate));
}

export function isNode(value: unknown): value is Node {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const nodeConstructor = getNodeConstructor(value);
	if (nodeConstructor) {
		return value instanceof nodeConstructor;
	}
	return typeof Node !== "undefined" && value instanceof Node;
}

/** Cross-realm Element guard. */
export function isElement(value: unknown): value is Element {
	return isNode(value) && value.nodeType === ELEMENT_NODE_TYPE;
}

/** Cross-realm HTMLElement guard. */
export function isHTMLElement(value: unknown): value is HTMLElement {
	if (!isElement(value)) {
		return false;
	}
	const htmlElementConstructor = value.ownerDocument?.defaultView?.HTMLElement;
	return typeof htmlElementConstructor === "function"
		? value instanceof htmlElementConstructor
		: value.namespaceURI === HTML_NAMESPACE;
}

export function isEditableElement(element: Element): boolean {
	const tagName = element.tagName.toLowerCase();
	return tagName === 'input' || tagName === 'textarea' || isHTMLElement(element) && (
		element.isContentEditable ||
		element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false' ||
		(element as HTMLElement & { readonly editContext?: unknown }).editContext != null
	);
}

export function getShadowRoot(node: Node): ShadowRoot | null {
	const root = node.getRootNode();
	return root.nodeType === 11 && 'host' in root ? root as ShadowRoot : null;
}

/** Stops propagation and, by default, the browser's native behavior. */
export function stopEvent(
	event: Event,
	options: {
		readonly preventDefault?: boolean;
		readonly immediate?: boolean;
	} = {},
): void {
	if (options.preventDefault !== false) event.preventDefault();
	if (options.immediate) event.stopImmediatePropagation();
	else event.stopPropagation();
}

type PrimitiveDomProperty = string | number | boolean | null | undefined;

type SafeDomPropertyName<TElement> = {
	[TKey in keyof TElement]-?: TKey extends "innerHTML" | "outerHTML"
		? never
		: TElement[TKey] extends PrimitiveDomProperty ? TKey
		: never;
}[keyof TElement];

export type DomElementProperties<TElement> = Partial<
	Pick<TElement, SafeDomPropertyName<TElement>>
>;

interface DomElementOptions<TElement extends HTMLElement | SVGElement> {
	readonly className?: string | readonly (string | false | null | undefined)[];
	/** String-valued markup attributes. Use `properties` for native booleans. */
	readonly attributes?: Readonly<
		Record<string, string | number | null | undefined>
	>;
	readonly properties?: Readonly<DomElementProperties<TElement>>;
	readonly dataset?: Readonly<Record<string, string | undefined>>;
	/** Camel-case or CSS property names map to CSS text. Length units must be explicit. */
	readonly style?: Readonly<Record<string, string | undefined>>;
	readonly ref?: (element: TElement) => void;
}

type HtmlElementForTag<TTag extends string> =
	TTag extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TTag]
		: HTMLElement;

/** Creates one HTML element in the supplied document. */
export function h<TTag extends string>(
	ownerDocument: Document,
	tag: TTag,
	optionsOrChild?: DomElementOptions<HtmlElementForTag<TTag>> | DomTreeChild,
	...children: readonly DomTreeChild[]
): HtmlElementForTag<TTag> {
	const args = splitElementArguments(optionsOrChild, children);
	const element = ownerDocument.createElement(tag) as HtmlElementForTag<TTag>;
	applyElementOptions(element, args.options);
	appendDomChildren(element, args.children);
	args.options.ref?.(element);
	return element;
}

/** Creates one SVG element in the supplied document. */
export function svg<K extends keyof SVGElementTagNameMap>(
	ownerDocument: Document,
	tag: K,
	optionsOrChild?: DomElementOptions<SVGElementTagNameMap[K]> | DomTreeChild,
	...children: readonly DomTreeChild[]
): SVGElementTagNameMap[K] {
	const args = splitElementArguments(optionsOrChild, children);
	const element = ownerDocument.createElementNS(
		"http://www.w3.org/2000/svg",
		tag,
	);
	applyElementOptions(element, args.options);
	appendDomChildren(element, args.children);
	args.options.ref?.(element);
	return element;
}

/** Creates a text node in the supplied document. */
export function text(
	ownerDocument: Document,
	value: string | number,
): Text {
	return ownerDocument.createTextNode(String(value));
}

/** Creates a document fragment containing the supplied children. */
export function fragment(
	ownerDocument: Document,
	...children: readonly DomTreeChild[]
): DocumentFragment {
	const result = ownerDocument.createDocumentFragment();
	appendDomChildren(result, children);
	return result;
}

function applyElementOptions<TElement extends HTMLElement | SVGElement>(
	element: TElement,
	options: DomElementOptions<TElement>,
): void {
	const classNames = typeof options.className === "string"
		? options.className.split(/\s+/)
		: options.className;
	if (classNames) {
		element.classList.add(...classNames.filter((name): name is string => Boolean(name)));
	}
	for (const [name, value] of Object.entries(options.attributes ?? {})) {
		if (value === null || value === undefined) element.removeAttribute(name);
		else element.setAttribute(name, String(value));
	}
	for (const [name, value] of Object.entries(options.properties ?? {})) {
		Reflect.set(element, name, value);
	}
	for (const [name, value] of Object.entries(options.dataset ?? {})) {
		if (value === undefined) {
			delete element.dataset[name];
		} else {
			element.dataset[name] = value;
		}
	}
	for (const [name, value] of Object.entries(options.style ?? {})) {
		const propertyName = toCssPropertyName(name);
		if (value === undefined) element.style.removeProperty(propertyName);
		else element.style.setProperty(propertyName, value);
	}
}

function isDomElementOptions<TElement extends HTMLElement | SVGElement>(
	value: DomElementOptions<TElement> | DomTreeChild,
): value is DomElementOptions<TElement> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !isNode(value);
}

function getNodeConstructor(value: object): typeof Node | undefined {
	const candidate = value as Node;
	const ownerDocument = candidate.nodeType === DOCUMENT_NODE_TYPE
		? value as Document
		: candidate.ownerDocument;
	const nodeConstructor = ownerDocument?.defaultView?.Node;
	return typeof nodeConstructor === "function" ? nodeConstructor : undefined;
}

function splitElementArguments<TElement extends HTMLElement | SVGElement>(
	optionsOrChild: DomElementOptions<TElement> | DomTreeChild,
	children: readonly DomTreeChild[],
): {
	readonly options: DomElementOptions<TElement>;
	readonly children: readonly DomTreeChild[];
} {
	return isDomElementOptions(optionsOrChild)
		? { options: optionsOrChild, children }
		: { options: {}, children: optionsOrChild === undefined ? children : [optionsOrChild, ...children] };
}

function toCssPropertyName(name: string): string {
	return name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function appendDomChildren(
	parent: Element | DocumentFragment,
	children: readonly DomTreeChild[],
): void {
	for (const child of children) {
		if (Array.isArray(child)) {
			appendDomChildren(parent, child);
		} else if (child !== false && child !== null && child !== undefined) {
			parent.append(
				typeof child === "string" || typeof child === "number"
					? String(child)
					: child as Node,
			);
		}
	}
}
