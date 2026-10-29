import './testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CodeEditorContributions } from '../../browser/widget/codeEditor/codeEditorContributions.js';
import { EditorContributionInstantiation, type TextEditorContributionConfigurationContext, type TextEditorContributionContext } from '../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../browser/editorBrowser.js';

suite('Code editor first-interaction lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const trigger of ['input', 'idle'] as const) {
		test(`${trigger} releases startup listeners and still admits later contributions`, () => {
			const dom = new JSDOM('<!doctype html><body><main></main></body>');
			using cleanup = { [Symbol.dispose]: () => dom.window.close() };
			const target = dom.window.document.querySelector('main')!;
			const listeners = new Set<EventListenerOrEventListenerObject>();
			const add = target.addEventListener.bind(target);
			const remove = target.removeEventListener.bind(target);
			target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
				listeners.add(listener);
				add(type, listener, options);
			}) as typeof target.addEventListener;
			target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
				listeners.delete(listener);
				remove(type, listener, options);
			}) as typeof target.removeEventListener;
			const idle = new Map<number, IdleRequestCallback>();
			let nextIdleId = 0;
			Object.assign(dom.window, {
				requestIdleCallback: (callback: IdleRequestCallback) => {
					idle.set(++nextIdleId, callback);
					return nextIdleId;
				},
				cancelIdleCallback: (id: number) => {
					idle.delete(id);
				},
			});
			let created = 0;
			let disposed = 0;
			class Contribution extends Disposable {
				constructor() {
					super();
					created++;
				}
				protected override disposeCore(): void {
					disposed++;
					super.disposeCore();
				}
			}
			const first = {
				id: 'first',
				ctor: Contribution,
				instantiation: EditorContributionInstantiation.BeforeFirstInteraction,
			};
			using services = new InstantiationService();
			using contributions = services.createInstance(CodeEditorContributions);
			contributions.configure([first], {} as TextEditorContributionConfigurationContext);
			contributions.initialize({ getDomNode: () => target } as ICodeEditor, {} as TextEditorContributionContext);
			assert.ok(listeners.size > 0);
			assert.equal(created, 0);
			if (trigger === 'input') target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a' }));
			else idle.values().next().value!({ didTimeout: false, timeRemaining: () => 50 });
			assert.equal(created, 1);
			assert.equal(listeners.size, 0);
			assert.equal(idle.size, 1, 'Only the unrelated eventual phase remains scheduled');
			contributions.refresh([first, { ...first, id: 'late' }]);
			assert.equal(created, 2, 'Late providers use the completed phase without reinstalling input listeners');
			target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'b' }));
			assert.equal(created, 2);
			assert.equal(listeners.size, 0);
			contributions.dispose();
			assert.equal(disposed, 2);
			assert.equal(idle.size, 0);
		});
	}
});
