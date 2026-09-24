import { addDisposableListener, getDomNodePagePosition, getWindow, h, isHTMLElement } from '../../base/browser/dom.js';
import { FastDomNode } from '../../base/browser/fastDomNode.js';
import { StandardMouseEvent } from '../../base/browser/mouseEvent.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { ThemeColor, type ThemeColor as ThemeColorValue } from '../../base/common/themables.js';
import { colorCssVariable } from '../../platform/theme/common/colorRegistry.js';
import { type ICodeEditor } from './editorBrowser.js';
import { type IDimension } from '../common/core/2d/dimension.js';

/** Coordinates relative to the entire document. */
export class PageCoordinates {
	declare readonly _pageCoordinatesBrand: void;

	constructor(
		public readonly x: number,
		public readonly y: number,
	) {}

	toClientCoordinates(targetWindow: Window): ClientCoordinates {
		return new ClientCoordinates(this.x - targetWindow.scrollX, this.y - targetWindow.scrollY);
	}
}

/** Coordinates relative to the browser client area. */
export class ClientCoordinates {
	declare readonly _clientCoordinatesBrand: void;

	constructor(
		public readonly clientX: number,
		public readonly clientY: number,
	) {}

	toPageCoordinates(targetWindow: Window): PageCoordinates {
		return new PageCoordinates(this.clientX + targetWindow.scrollX, this.clientY + targetWindow.scrollY);
	}
}

/** The editor bounds expressed in document coordinates. */
export class EditorPagePosition {
	declare readonly _editorPagePositionBrand: void;

	constructor(
		public readonly x: number,
		public readonly y: number,
		public readonly width: number,
		public readonly height: number,
	) {}
}

/** Coordinates transformed into the editor's unscaled layout space. */
export class CoordinatesRelativeToEditor {
	declare readonly _positionRelativeToEditorBrand: void;

	constructor(
		public readonly x: number,
		public readonly y: number,
	) {}
}

export function createEditorPagePosition(editorViewDomNode: HTMLElement): EditorPagePosition {
	const position = getDomNodePagePosition(editorViewDomNode);
	return new EditorPagePosition(position.left, position.top, position.width, position.height);
}

export function createCoordinatesRelativeToEditor(
	editorViewDomNode: HTMLElement,
	editorPagePosition: EditorPagePosition,
	pos: PageCoordinates,
): CoordinatesRelativeToEditor {
	const scaleX = positiveScale(editorPagePosition.width, editorViewDomNode.offsetWidth);
	const scaleY = positiveScale(editorPagePosition.height, editorViewDomNode.offsetHeight);
	return new CoordinatesRelativeToEditor(
		(pos.x - editorPagePosition.x) / scaleX,
		(pos.y - editorPagePosition.y) / scaleY,
	);
}

/** A normalized browser event with editor-aware page and relative coordinates. */
export class EditorMouseEvent extends StandardMouseEvent {
	declare readonly _editorMouseEventBrand: void;
	readonly pos: PageCoordinates;
	private editorPagePosition: EditorPagePosition | undefined;
	private relativeEditorPosition: CoordinatesRelativeToEditor | undefined;

	constructor(
		event: MouseEvent,
		readonly isFromPointerCapture: boolean,
		private readonly editorViewDomNode: HTMLElement,
	) {
		super(event);
		this.pos = new PageCoordinates(this.pageX, this.pageY);
	}

	get editorPos(): EditorPagePosition {
		return this.editorPagePosition ??= createEditorPagePosition(this.editorViewDomNode);
	}

	get relativePos(): CoordinatesRelativeToEditor {
		return this.relativeEditorPosition ??= createCoordinatesRelativeToEditor(this.editorViewDomNode, this.editorPos, this.pos);
	}
}

/** Creates disposable editor-coordinate mouse listeners. */
export class EditorMouseEventFactory {
	constructor(private readonly editorViewDomNode: HTMLElement) {}

	onContextMenu(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen<MouseEvent>(target, 'contextmenu', callback);
	}

	onMouseUp(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen<MouseEvent>(target, 'mouseup', callback);
	}

	onMouseDown(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen<MouseEvent>(target, 'mousedown', callback);
	}

	onPointerDown(target: HTMLElement, callback: (event: EditorMouseEvent, pointerId: number) => void): IDisposable {
		return addDisposableListener<PointerEvent>(target, 'pointerdown', event => {
			callback(this.create(event), event.pointerId);
		});
	}

	onMouseLeave(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen<MouseEvent>(target, 'mouseleave', callback);
	}

	onMouseMove(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen<MouseEvent>(target, 'mousemove', callback);
	}

	private listen<T extends MouseEvent>(target: HTMLElement, type: string, callback: (event: EditorMouseEvent) => void): IDisposable {
		return addDisposableListener<T>(target, type, event => callback(this.create(event)));
	}

	private create(event: MouseEvent): EditorMouseEvent {
		return new EditorMouseEvent(event, false, this.editorViewDomNode);
	}
}

/** Creates disposable editor-coordinate pointer listeners. */
export class EditorPointerEventFactory {
	constructor(private readonly editorViewDomNode: HTMLElement) {}

	onPointerUp(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen(target, 'pointerup', callback);
	}

	onPointerDown(target: HTMLElement, callback: (event: EditorMouseEvent, pointerId: number) => void): IDisposable {
		return addDisposableListener<PointerEvent>(target, 'pointerdown', event => {
			callback(this.create(event), event.pointerId);
		});
	}

	onPointerLeave(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen(target, 'pointerleave', callback);
	}

	onPointerMove(target: HTMLElement, callback: (event: EditorMouseEvent) => void): IDisposable {
		return this.listen(target, 'pointermove', callback);
	}

	private listen(target: HTMLElement, type: string, callback: (event: EditorMouseEvent) => void): IDisposable {
		return addDisposableListener<PointerEvent>(target, type, event => callback(this.create(event)));
	}

	private create(event: MouseEvent): EditorMouseEvent {
		return new EditorMouseEvent(event, false, this.editorViewDomNode);
	}
}

/** Owns one global pointer-move session and replaces it atomically on restart. */
export class GlobalEditorPointerMoveMonitor extends Disposable {
	private readonly monitoring = this._register(new MutableDisposable<DisposableStore>());
	private stopCurrent: ((event?: PointerEvent | KeyboardEvent) => void) | undefined;

	constructor(private readonly editorViewDomNode: HTMLElement) {
		super();
	}

	startMonitoring(
		initialElement: Element,
		pointerId: number,
		initialButtons: number,
		pointerMoveCallback: (event: EditorMouseEvent) => void,
		onStopCallback: (browserEvent?: PointerEvent | KeyboardEvent) => void,
	): void {
		this.stopMonitoring();
		const targetWindow = getWindow(initialElement);
		const store = new DisposableStore();
		let stopped = false;
		const stop = (event?: PointerEvent | KeyboardEvent): void => {
			if (stopped) return;
			stopped = true;
			this.stopCurrent = undefined;
			this.monitoring.clear();
			onStopCallback(event);
		};
		this.stopCurrent = stop;
		store.add(addDisposableListener<PointerEvent>(targetWindow, 'pointermove', event => {
			if (event.pointerId !== pointerId) return;
			if (initialButtons !== 0 && (event.buttons & initialButtons) === 0) {
				stop(event);
				return;
			}
			pointerMoveCallback(new EditorMouseEvent(event, true, this.editorViewDomNode));
		}));
		store.add(addDisposableListener<PointerEvent>(targetWindow, 'pointerup', event => {
			if (event.pointerId === pointerId) stop(event);
		}));
		store.add(addDisposableListener<PointerEvent>(targetWindow, 'pointercancel', event => {
			if (event.pointerId === pointerId) stop(event);
		}));
		store.add(addDisposableListener(targetWindow, 'blur', () => stop(), { once: true }));
		store.add(addDisposableListener<KeyboardEvent>(initialElement.ownerDocument, 'keydown', event => {
			if (!isModifierKey(event.key)) stop(event);
		}, true));
		this.monitoring.value = store;
	}

	stopMonitoring(): void {
		this.stopCurrent?.();
	}

	protected override disposeCore(): void {
		this.stopMonitoring();
		super.disposeCore();
	}
}

function positiveScale(renderedSize: number, layoutSize: number): number {
	if (!Number.isFinite(renderedSize) || !Number.isFinite(layoutSize) || renderedSize <= 0 || layoutSize <= 0) return 1;
	return renderedSize / layoutSize;
}

function isModifierKey(key: string): boolean {
	return key === 'Alt' || key === 'AltGraph' || key === 'Control' || key === 'Meta' || key === 'Shift';
}

export interface EditorDomOptions {
	readonly rootClassName: string;
	readonly contentClassName: string;
}

/** Owns the stable DOM roots shared by a browser editor projection. */
export class EditorDom extends Disposable {
	private readonly options: EditorDomOptions;
	private domNodeHandle: FastDomNode<HTMLDivElement> | undefined;
	private contentDomNodeHandle: FastDomNode<HTMLDivElement> | undefined;
	private attached = false;

	public constructor(options: EditorDomOptions) {
		super();
		if (!options?.rootClassName?.trim() || !options.contentClassName?.trim()) {
			this.dispose();
			throw new TypeError('Editor DOM requires root and content class names');
		}
		this.options = options;
	}

	public get domNode(): HTMLDivElement {
		return this.requireHandles().domNode.domNode;
	}

	public get contentDomNode(): HTMLDivElement {
		return this.requireHandles().contentDomNode.domNode;
	}

	public attach(parent: HTMLElement): void {
		this.assertNotDisposed();
		if (!isHTMLElement(parent)) throw new TypeError('Editor DOM parent must be an HTMLElement');
		if (this.attached) throw new ReferenceError('Editor DOM has already been attached');
		const domNode = new FastDomNode(h(parent.ownerDocument, 'div', { className: this.options.rootClassName }));
		const contentDomNode = new FastDomNode(h(parent.ownerDocument, 'div', { className: this.options.contentClassName }));
		this.domNodeHandle = domNode;
		this.contentDomNodeHandle = contentDomNode;
		this._register(toDisposable(() => domNode.domNode.remove()));
		parent.append(domNode.domNode);
		this.attached = true;
	}

	public layout(dimension: IDimension): void {
		const { domNode, contentDomNode } = this.requireHandles();
		const width = Math.max(0, dimension.width);
		const height = Math.max(0, dimension.height);
		domNode.setWidth(width);
		domNode.setHeight(height);
		contentDomNode.setWidth(width);
		contentDomNode.setHeight(height);
	}

	private requireHandles(): { readonly domNode: FastDomNode<HTMLDivElement>; readonly contentDomNode: FastDomNode<HTMLDivElement> } {
		if (!this.domNodeHandle || !this.contentDomNodeHandle) throw new ReferenceError('Editor DOM has not been attached');
		return { domNode: this.domNodeHandle, contentDomNode: this.contentDomNodeHandle };
	}
}

/**
 * Creates reusable editor-scoped CSS classes for values that are only known at runtime.
 * References are counted and unused rules are collected after a short reuse window.
 */
export class DynamicCssRules implements IDisposable {
	private static idPool = 0;
	private readonly instanceId = ++DynamicCssRules.idPool;
	private counter = 0;
	private readonly rules = new DisposableMap<string, RefCountedCssRule>();
	private readonly garbageCollectionScheduler = new RunOnceScheduler(() => this.garbageCollect(), 1_000);
	private disposed = false;

	constructor(private readonly editor: ICodeEditor) {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.garbageCollectionScheduler.dispose();
		this.rules.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	createClassNameRef(properties: CssProperties): ClassNameReference {
		if (this.disposed) throw new ReferenceError('DynamicCssRules is already disposed');
		const rule = this.getOrCreateRule(properties);
		rule.increaseRefCount();
		let disposed = false;
		return {
			className: rule.className,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				rule.decreaseRefCount();
				if (!this.disposed) this.garbageCollectionScheduler.schedule();
			},
			[Symbol.dispose]() { this.dispose(); },
		};
	}

	private getOrCreateRule(properties: CssProperties): RefCountedCssRule {
		const key = JSON.stringify(properties);
		for (const [candidateKey, rule] of this.rules) {
			if (candidateKey === key) return rule;
		}
		const rule = new RefCountedCssRule(
			key,
			`dyn-rule-${this.instanceId}-${this.counter++}`,
			this.editor.getContainerDomNode(),
			properties,
		);
		this.rules.set(key, rule);
		return rule;
	}

	private garbageCollect(): void {
		for (const [key, rule] of this.rules) {
			if (!rule.hasReferences()) this.rules.deleteAndDispose(key);
		}
	}
}

export interface ClassNameReference extends IDisposable {
	className: string;
}

export interface CssProperties {
	border?: string;
	borderColor?: string | ThemeColorValue;
	borderRadius?: string;
	fontStyle?: string;
	fontWeight?: string;
	fontSize?: string;
	fontFamily?: string;
	unicodeBidi?: string;
	textDecoration?: string;
	color?: string | ThemeColorValue;
	backgroundColor?: string | ThemeColorValue;
	opacity?: string;
	verticalAlign?: string;
	cursor?: string;
	margin?: string;
	padding?: string;
	width?: string;
	height?: string;
	display?: string;
}

class RefCountedCssRule implements IDisposable {
	private referenceCount = 0;
	private readonly style: HTMLStyleElement;

	constructor(
		readonly key: string,
		readonly className: string,
		container: HTMLElement,
		properties: CssProperties,
	) {
		this.style = h(container.ownerDocument, 'style');
		this.style.type = 'text/css';
		this.style.textContent = cssRule(className, properties);
		const root = container.getRootNode();
		const ShadowRootConstructor = container.ownerDocument.defaultView?.ShadowRoot;
		if (ShadowRootConstructor && root instanceof ShadowRootConstructor) root.append(this.style);
		else container.ownerDocument.head.append(this.style);
	}

	dispose(): void {
		this.style.remove();
	}

	increaseRefCount(): void {
		this.referenceCount += 1;
	}

	decreaseRefCount(): void {
		this.referenceCount = Math.max(0, this.referenceCount - 1);
	}

	hasReferences(): boolean {
		return this.referenceCount > 0;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function cssRule(className: string, properties: CssProperties): string {
	const declarations = Object.entries(properties).map(([name, value]) => {
		const cssValue = ThemeColor.isThemeColor(value) ? `var(${colorCssVariable(value.id)})` : value;
		return `\t${camelToDashes(name)}: ${cssValue};`;
	});
	return `.${className} {\n${declarations.join('\n')}\n}`;
}

function camelToDashes(value: string): string {
	return value.replace(/(^[A-Z])/u, first => first.toLowerCase()).replace(/([A-Z])/gu, letter => `-${letter.toLowerCase()}`);
}
