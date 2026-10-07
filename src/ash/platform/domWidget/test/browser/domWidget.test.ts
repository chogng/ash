import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { enableHotReload, isHotReloadEnabled } from '../../../../base/common/hotReload.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { DomWidget } from '../../browser/domWidget.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';

test('production DomWidget reads retain one instance and dispose it with its scope', () => {
	assert.equal(isHotReloadEnabled(), false);
	const dom = new JSDOM('<!doctype html>');
	try {
		class Widget extends DomWidget {
			public readonly element = dom.window.document.createElement('div');
		}
		using scope = new DisposableStore();
		const observable = Widget.createObservable(scope);
		const instance = observable.get();
		assert.equal(observable.get(), instance);
		scope.dispose();
		assert.equal(instance.isDisposed, true);
	} finally {
		dom.window.close();
	}
});

test('DomWidget scopes retain the latest constructor, replace twice, and release each instance once', () => {
	const dom = new JSDOM('<!doctype html><main></main>');
	try {
		enableHotReload();
		const events: string[] = [];
		const widget = (version: string) => {
			return class extends DomWidget {
				public readonly element = dom.window.document.createElement('button');

				constructor(label: string) {
					super();
					this.element.textContent = `${label}:${version}`;
					events.push(`create:${version}`);
					this._register(toDisposable(() => {
						events.push(`dispose:${version}`);
						this.element.remove();
					}));
				}
			};
		};
		const Initial = widget('initial');
		Initial.registerWidgetHotReplacement('domWidget.test#scoped');
		using scope = new DisposableStore();
		const versions = Initial.createObservable(scope, 'kept');
		const roots: HTMLElement[] = [];
		const mount = (value: DomWidget): void => {
			if (roots.length > 0) {
				assert.equal(roots.at(-1)!.isConnected, true, 'The host must be able to replace the previous root before disposal');
				roots.at(-1)!.replaceWith(value.element);
			} else {
				dom.window.document.querySelector('main')!.append(value.element);
			}
			roots.push(value.element);
		};
		scope.add(versions.onDidChange(mount));
		mount(versions.get());
		for (const version of ['second', 'third']) {
			widget(version).registerWidgetHotReplacement('domWidget.test#scoped');
		}
		assert.deepEqual({ text: versions.get().element.textContent, connected: roots.map(root => root.isConnected), events }, {
			text: 'kept:third', connected: [false, false, true],
			events: ['create:initial', 'create:second', 'dispose:initial', 'create:third', 'dispose:second'],
		});
		scope.dispose();
		widget('after-disposal').registerWidgetHotReplacement('domWidget.test#scoped');
		assert.deepEqual(events, ['create:initial', 'create:second', 'dispose:initial', 'create:third', 'dispose:second', 'dispose:third']);
		using reopened = new DisposableStore();
		assert.equal(Initial.createObservable(reopened, 'reopened').get().element.textContent, 'reopened:after-disposal');
	} finally {
		dom.window.close();
	}
});

test('DomWidget identities distinguish classes with the same name in different modules', () => {
	enableHotReload();
	const dom = new JSDOM('<!doctype html>');
	try {
		const First = class SameName extends DomWidget { public readonly element = dom.window.document.createElement('div'); };
		const Second = class SameName extends DomWidget { public readonly element = dom.window.document.createElement('div'); };
		First.registerWidgetHotReplacement('first.ts#SameName');
		Second.registerWidgetHotReplacement('second.ts#SameName');
		using scope = new DisposableStore();
		const first = First.createObservable(scope).get();
		const second = Second.createObservable(scope).get();
		const Replacement = class SameName extends DomWidget { public readonly element = dom.window.document.createElement('section'); };
		Replacement.registerWidgetHotReplacement('second.ts#SameName');
		assert.deepEqual({ firstDisposed: first.isDisposed, secondDisposed: second.isDisposed }, { firstDisposed: false, secondDisposed: true });
	} finally {
		dom.window.close();
	}
});

test('DomWidget replacements resolve decorated services in the same scope and reject missing dependencies', () => {
	enableHotReload();
	const dom = new JSDOM('<!doctype html>');
	try {
		const ILabelService = createDecorator<{ readonly label: string; }>('domWidget.test.label');
		const dependency = { label: 'service' };
		class Initial extends DomWidget {
			public readonly element = dom.window.document.createElement('div');
			constructor(public readonly suffix: string, @ILabelService public readonly service: { readonly label: string; }) {
				super();
				this.element.textContent = `${service.label}:${suffix}`;
			}
		}
		class Replacement extends Initial { }
		Initial.registerWidgetHotReplacement('domWidget.test#injected');
		using services = new InstantiationService();
		using scope = new DisposableStore();
		assert.throws(() => Initial.instantiateObservable(services, scope, 'kept'), /service/i);
		services.registerInstance(ILabelService, dependency);
		const instances = Initial.instantiateObservable(services, scope, 'kept');
		const previous = instances.get();
		Replacement.registerWidgetHotReplacement('domWidget.test#injected');
		assert.equal(previous.isDisposed, true);
		assert.equal(instances.get().service, dependency);
		assert.equal(instances.get().element.textContent, 'service:kept');
		scope.dispose();
		assert.equal(instances.get().isDisposed, true);
	} finally { dom.window.close(); }
});
