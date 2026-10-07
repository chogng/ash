import { isHotReloadEnabled } from '../../../base/common/hotReload.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { constObservable, observableValue, type IObservable, type ISettableObservable } from '../../../base/common/observable.js';
import type { IInstantiationService } from '../../instantiation/common/instantiation.js';

type WidgetConstructor = new (...args: never[]) => DomWidget;
const widgets = new Map<string, ISettableObservable<WidgetConstructor>>();
const constructors = new WeakMap<Function, IObservable<WidgetConstructor>>();

/** A disposable DOM component whose implementation can be replaced during development. */
export abstract class DomWidget extends Disposable {

	/** The widget's stable root. The caller owns its placement in the DOM. */
	public abstract get element(): HTMLElement;

	/** The supplied scope owns every instance and the subscription to future replacements. */
	public static createObservable<TArgs extends unknown[], T extends DomWidget>(this: new (...args: TArgs) => T, store: DisposableStore, ...params: TArgs): IObservable<T> {
		const create = (constructor: WidgetConstructor): T => new (constructor as unknown as new (...args: TArgs) => T)(...params);
		return createWidgetObservable(this as unknown as WidgetConstructor, store, create);
	}

	/** Resolves decorated dependencies in the original service scope for every replacement. */
	public static instantiateObservable<T extends DomWidget>(this: new (...args: never[]) => T, instantiationService: IInstantiationService, store: DisposableStore, ...params: unknown[]): IObservable<T> {
		return createWidgetObservable(this, store, constructor => instantiationService.createInstance(constructor as unknown as new (...args: unknown[]) => T, ...params));
	}

	/** Called by the development transform; the identity includes the module path and class name. */
	public static registerWidgetHotReplacement(this: WidgetConstructor, id: string): void {
		if (!isHotReloadEnabled()) {
			return;
		}
		let versions = widgets.get(id);
		if (!versions) {
			versions = observableValue(id, this);
			widgets.set(id, versions);
		}
		constructors.set(this, versions);
		versions.set(this);
	}
}

function createWidgetObservable<T extends DomWidget>(constructor: WidgetConstructor, store: DisposableStore, create: (constructor: WidgetConstructor) => T): IObservable<T> {
	const versions = isHotReloadEnabled() ? constructors.get(constructor) : undefined;
	const instance = store.add(new MutableDisposable<T>());
	instance.value = create(versions?.get() ?? constructor);
	if (!versions) {
		return constObservable(instance.value);
	}
	const result = observableValue<T>(constructor, instance.value);
	store.add(versions.onDidChange(next => {
		const replacement = create(next);
		const previous = instance.clearAndLeak();
		instance.value = replacement;
		try {
			// The host transfers view state and placement before old listeners and DOM are released.
			result.set(replacement);
		} finally {
			previous?.dispose();
		}
	}));
	return result;
}
