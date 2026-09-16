import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { Context, ContextKeyValue, ContextKeyExpression, ContextKeyChangeEvent, IContextKey, IContextKeyService as IContextKeyValueService } from "../common/contextkey.js";

/** Evaluates and publishes context values for one window or DOM scope. */
export interface IContextKeyService extends IContextKeyValueService {
	contextMatchesRules(expression: ContextKeyExpression | undefined, target?: Node | null): boolean;
	createScoped(target: HTMLElement): IScopedContextKeyService;
	getContext(target?: Node | null): Context;
}

/** A disposable context layer inherited by descendants of one DOM element. */
export interface IScopedContextKeyService
	extends IContextKeyService, IDisposable {}

export const IContextKeyService =
	createServiceIdentifier<IContextKeyService>("contextKeyService");

interface ContextKeyState {
	readonly emitter: Emitter<ContextKeyChangeEvent>;
	readonly scopes: WeakMap<Node, AbstractContextKeyService>;
	readonly bufferedKeys: Set<string>;
	bufferDepth: number;
	root: AbstractContextKeyService | undefined;
}

abstract class AbstractContextKeyService
	extends Disposable
	implements IContextKeyService {
	private readonly values = new Map<string, ContextKeyValue>();
	private readonly parent: AbstractContextKeyService | undefined;
	protected readonly state: ContextKeyState;

	protected constructor(
		state: ContextKeyState,
		parent?: AbstractContextKeyService,
	) {
		super();
		this.state = state;
		this.parent = parent;
		this._register(toDisposable(() => {
			const keys = new Set(this.values.keys());
			this.values.clear();
			fireContextChange(this.state, keys);
		}));
	}

	get onDidChangeContext(): Event<ContextKeyChangeEvent> {
		return this.state.emitter.event;
	}

	getValue<T extends ContextKeyValue>(key: string): T | undefined {
		if (this.values.has(key)) {
			return this.values.get(key) as T | undefined;
		}
		return this.parent?.getValue<T>(key);
	}

	contextMatchesRules(
		expression: ContextKeyExpression | undefined,
		target?: Node | null,
	): boolean {
		return expression?.evaluate(this.getContext(target)) ?? true;
	}

	createKey<T extends ContextKeyValue>(
		key: string,
		defaultValue: T,
	): IContextKey<T> {
		return new BoundContextKey(this, key, defaultValue);
	}

	createScoped(target: HTMLElement): IScopedContextKeyService {
		const parent = findScopedContext(
			this.state,
			getComposedParent(target),
		) ?? this;
		return new ScopedContextKeyService(parent, target, this.state);
	}

	getContext(target?: Node | null): Context {
		if (!target) return this;
		return findScopedContext(this.state, target) ??
			this.state.root ??
			this;
	}

	bufferChangeEvents(callback: () => void): void {
		this.state.bufferDepth += 1;
		try {
			callback();
		} finally {
			this.state.bufferDepth -= 1;
			if (this.state.bufferDepth === 0 && this.state.bufferedKeys.size > 0) {
				const keys = new Set(this.state.bufferedKeys);
				this.state.bufferedKeys.clear();
				fireContextChange(this.state, keys);
			}
		}
	}

	setContext(key: string, value: ContextKeyValue): void {
		if (this.values.has(key) && Object.is(this.values.get(key), value)) {
			return;
		}
		this.values.set(key, value);
		fireContextChange(this.state, new Set([key]));
	}

	removeContext(key: string): void {
		if (!this.values.delete(key)) return;
		fireContextChange(this.state, new Set([key]));
	}
}

/** Default mutable context key service for one workbench window. */
export class ContextKeyService extends AbstractContextKeyService {
	constructor() {
		const state: ContextKeyState = {
			emitter: new Emitter<ContextKeyChangeEvent>(),
			scopes: new WeakMap(),
			bufferedKeys: new Set(),
			bufferDepth: 0,
			root: undefined,
		};
		super(state);
		state.root = this;
		this._register(state.emitter);
	}
}

class ScopedContextKeyService
	extends AbstractContextKeyService
	implements IScopedContextKeyService {
	constructor(
		parent: AbstractContextKeyService,
		target: HTMLElement,
		state: ContextKeyState,
	) {
		if (state.scopes.has(target)) {
			throw new Error("A context key scope is already bound to this element");
		}
		super(state, parent);
		state.scopes.set(target, this);
		this._register(toDisposable(() => {
			if (state.scopes.get(target) === this) state.scopes.delete(target);
		}));
	}
}

class BoundContextKey<T extends ContextKeyValue>
	implements IContextKey<T> {
	private readonly service: IContextKeyService;
	private readonly key: string;
	private readonly defaultValue: T;

	constructor(
		service: IContextKeyService,
		key: string,
		defaultValue: T,
	) {
		if (!key) throw new TypeError("Context key must not be empty");
		this.service = service;
		this.key = key;
		this.defaultValue = defaultValue;
		this.reset();
	}

	set(value: T): void {
		this.service.setContext(this.key, value);
	}

	reset(): void {
		if (this.defaultValue === undefined) {
			this.service.removeContext(this.key);
		} else {
			this.service.setContext(this.key, this.defaultValue);
		}
	}

	get(): T | undefined {
		return this.service.getValue<T>(this.key);
	}
}

function fireContextChange(
	state: ContextKeyState,
	keys: ReadonlySet<string>,
): void {
	if (keys.size === 0) return;
	if (state.bufferDepth > 0) {
		for (const key of keys) state.bufferedKeys.add(key);
		return;
	}
	state.emitter.fire({
		keys,
		affectsSome(candidateKeys): boolean {
			for (const key of keys) {
				if (candidateKeys.has(key)) return true;
			}
			return false;
		},
	});
}

function getComposedParent(node: Node): Node | null {
	if (node.parentNode) return node.parentNode;
	const root = node.getRootNode();
	return "host" in root ? (root as ShadowRoot).host : null;
}

function findScopedContext(
	state: ContextKeyState,
	target: Node | null,
): AbstractContextKeyService | undefined {
	for (
		let current = target;
		current;
		current = getComposedParent(current)
	) {
		const scoped = state.scopes.get(current);
		if (scoped) return scoped;
	}
	return undefined;
}
