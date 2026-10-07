import { AbstractDisposable, DisposableStore, setDisposableOwner, type IDisposable } from "../common/lifecycle.js";
import { autorun, type IObservable, type IReader, isObservable } from "../common/observable.js";
import type { DomElementProperties } from "./dom.js";

type ReactiveValue<T> = T | IObservable<T>;
type ReactiveValueList<T> = ReactiveValue<T> | readonly ReactiveValueList<T>[];

export type ReactiveDomChild =
	| Node
	| string
	| number
	| false
	| null
	| undefined
	| IReactiveElement
	| IObservable<ReactiveDomChild>
	| readonly ReactiveDomChild[];

export interface IReactiveElement {
	readonly element: HTMLElement | SVGElement;
	/** @internal */
	update(reader: IReader): void;
}

export type ReactiveDomElementProperties<TElement> = {
	readonly [TKey in keyof DomElementProperties<TElement>]?: ReactiveValue<
		DomElementProperties<TElement>[TKey]
	>;
};

export interface ReactiveDomElementOptions<
	TElement extends HTMLElement | SVGElement,
> {
	readonly className?: ReactiveValueList<string | false | null | undefined>;
	readonly attributes?: Readonly<
		Record<string, ReactiveValue<string | number | null | undefined>>
	>;
	readonly properties?: ReactiveDomElementProperties<TElement>;
	readonly dataset?: Readonly<
		Record<string, ReactiveValue<string | undefined>>
	>;
	readonly style?: Readonly<
		Record<string, ReactiveValue<string | undefined>>
	>;
	readonly ref?: (element: TElement) => void;
}

export interface ReactiveDomFactory {
	readonly document: Document;

	div(
		options?: ReactiveDomElementOptions<HTMLDivElement>,
		children?: ReactiveDomChild,
	): ReactiveElement<HTMLDivElement>;

	elem<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		options?: ReactiveDomElementOptions<HTMLElementTagNameMap[K]>,
		children?: ReactiveDomChild,
	): ReactiveElement<HTMLElementTagNameMap[K]>;

	svg(
		options?: ReactiveDomElementOptions<SVGSVGElement>,
		children?: ReactiveDomChild,
	): ReactiveElement<SVGSVGElement>;

	svgElem<K extends keyof SVGElementTagNameMap>(
		tag: K,
		options?: ReactiveDomElementOptions<SVGElementTagNameMap[K]>,
		children?: ReactiveDomChild,
	): ReactiveElement<SVGElementTagNameMap[K]>;
}

/** Creates `n.div`/`n.elem` helpers bound to a specific document. */
export function createReactiveDom(ownerDocument: Document): ReactiveDomFactory {
	return {
		document: ownerDocument,
		div: (options = {}, children) =>
			new ReactiveElement(ownerDocument, "div", undefined, options, children),
		elem: (tag, options = {}, children) =>
			new ReactiveElement(ownerDocument, tag, undefined, options, children),
		svg: (options = {}, children) =>
			new ReactiveElement(
				ownerDocument,
				"svg",
				"http://www.w3.org/2000/svg",
				options,
				children,
			),
		svgElem: (tag, options = {}, children) =>
			new ReactiveElement(
				ownerDocument,
				tag,
				"http://www.w3.org/2000/svg",
				options,
				children,
			),
	};
}

/**
 * A lazily activated reactive element description.
 *
 * Nested descriptions share the root reaction. Call `toLiveElement` at the
 * component boundary and register the result with its disposable owner.
 */
export class ReactiveElement<
	TElement extends HTMLElement | SVGElement = HTMLElement | SVGElement,
> implements IReactiveElement {
	readonly element: TElement;
	private renderedChildren: readonly (Node | string)[] | undefined;

	constructor(
		ownerDocument: Document,
		tag: string,
		namespace: string | undefined,
		private readonly options: ReactiveDomElementOptions<TElement>,
		private readonly children: ReactiveDomChild,
	) {
		this.element = (namespace
			? ownerDocument.createElementNS(namespace, tag)
			: ownerDocument.createElement(tag)) as TElement;
		options.ref?.(this.element);
	}

	/** Keeps this reactive tree current until `store` is disposed. */
	keepUpdated(store: DisposableStore): this {
		store.add(autorun(reader => this.update(reader)));
		return this;
	}

	/** Activates this tree and returns its element with an owned lifetime. */
	toLiveElement(): LiveElement<TElement> {
		const store = new DisposableStore();
		this.keepUpdated(store);
		return new LiveElement(this.element, store);
	}

	/** @internal */
	update(reader: IReader): void {
		if (this.options.className !== undefined) {
			setClassName(this.element, resolveClassName(this.options.className, reader));
		}
		for (const [name, value] of Object.entries(this.options.attributes ?? {})) {
			setOrRemoveAttribute(this.element, name, read(value, reader));
		}
		for (const [name, value] of Object.entries(this.options.properties ?? {})) {
			Reflect.set(this.element, name, read(value as ReactiveValue<unknown>, reader));
		}
		for (const [name, value] of Object.entries(this.options.dataset ?? {})) {
			const resolved = read(value, reader);
			if (resolved === undefined) {
				delete this.element.dataset[name];
			} else {
				this.element.dataset[name] = resolved;
			}
		}
		for (const [name, value] of Object.entries(this.options.style ?? {})) {
			const resolved = read(value, reader);
			const propertyName = toCssPropertyName(name);
			if (resolved === undefined) this.element.style.removeProperty(propertyName);
			else this.element.style.setProperty(propertyName, resolved);
		}

		const children: (Node | string)[] = [];
		resolveChildren(this.children, reader, children);
		if (!equalChildren(this.renderedChildren, children)) {
			this.element.replaceChildren(...children);
			this.renderedChildren = children;
		}
	}
}

export class LiveElement<TElement extends HTMLElement | SVGElement> extends AbstractDisposable {
	constructor(
		public readonly element: TElement,
		private readonly registration: IDisposable,
	) {
		super();
		setDisposableOwner(registration, this);
	}

	protected override disposeCore(): void {
		this.registration.dispose();
	}
}

function read<T>(value: ReactiveValue<T>, reader: IReader): T {
	return isObservable(value) ? value.read(reader) as T : value;
}

function resolveClassName(
	value: ReactiveValueList<string | false | null | undefined> | undefined,
	reader: IReader,
): string {
	const names: string[] = [];
	resolveValues(value, reader, resolved => {
		if (resolved) names.push(resolved);
	});
	return names.join(" ");
}

function resolveValues<T>(
	value: ReactiveValueList<T> | undefined,
	reader: IReader,
	accept: (value: T) => void,
): void {
	if (isObservable(value)) {
		resolveValues(value.read(reader) as ReactiveValueList<T>, reader, accept);
	} else if (Array.isArray(value)) {
		for (const item of value) resolveValues(item, reader, accept);
	} else if (value !== undefined) {
		accept(value as T);
	}
}

function resolveChildren(
	child: ReactiveDomChild,
	reader: IReader,
	result: (Node | string)[],
): void {
	if (isObservable(child)) {
		resolveChildren(child.read(reader) as ReactiveDomChild, reader, result);
	} else if (isReactiveDomChildArray(child)) {
		for (const item of child) resolveChildren(item, reader, result);
	} else if (isReactiveElement(child)) {
		child.update(reader);
		result.push(child.element);
	} else if (child !== false && child !== null && child !== undefined) {
		result.push(typeof child === "number" ? String(child) : child);
	}
}

function setClassName(element: HTMLElement | SVGElement, className: string): void {
	element.setAttribute("class", className);
}

function toCssPropertyName(name: string): string {
	return name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function setOrRemoveAttribute(
	element: Element,
	name: string,
	value: string | number | null | undefined,
): void {
	if (value === null || value === undefined) element.removeAttribute(name);
	else element.setAttribute(name, String(value));
}

function equalChildren(
	previous: readonly (Node | string)[] | undefined,
	next: readonly (Node | string)[],
): boolean {
	return previous !== undefined &&
		previous.length === next.length &&
		previous.every((child, index) => child === next[index]);
}

function isReactiveDomChildArray(
	child: ReactiveDomChild,
): child is readonly ReactiveDomChild[] {
	return Array.isArray(child);
}

function isReactiveElement(child: ReactiveDomChild): child is IReactiveElement {
	return child instanceof ReactiveElement;
}
