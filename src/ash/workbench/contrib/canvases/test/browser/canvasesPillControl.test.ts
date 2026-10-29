import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue, constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanvasesPillControl } from '../../browser/canvasesPillControl.js';
import type { ICanvas, ICanvasContext, ICanvasService } from '../../common/canvas.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { readFile } from 'node:fs/promises';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';

suite('Canvas composer controls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('Canvas controls use translated action labels while preserving provider titles', async () => {
		try {
			setNlsMessages('zh-CN', JSON.parse(await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
			using lifetime = new DisposableStore();
			const container = document.createElement('div');
			const context: ICanvasContext = { owner: { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one') }, canvases: constObservable([{ resource: URI.parse('canvas:/one'), instanceId: 'board', title: '画板', source: URI.parse('https://example.test') }]), closeCanvas: async () => { } };
			lifetime.add(new CanvasesPillControl(container, constObservable(context), () => { }, { enabled: constObservable(true) } as unknown as ICanvasService, {} as INotificationService));
			assert.ok(container.querySelector('[aria-label="打开 Canvas 画板"]'));
			assert.ok(container.querySelector('[aria-label="关闭 Canvas 画板"]'));
		} finally { resetNlsResolver(); }
	});
	test('keeps focused controls across source updates, deduplicates close, and restores composer focus after removal', async () => {
		using lifetime = new DisposableStore();
		const container = document.createElement('div'); document.body.append(container);
		lifetime.add(toDisposable(() => container.remove()));
		const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one') };
		const canvas: ICanvas = { resource: URI.parse('canvas:/one'), instanceId: 'board', title: 'Board', source: URI.parse('https://example.test') };
		const canvases = observableValue<readonly ICanvas[]>('test', [canvas]);
		const closing = promiseWithResolvers<void>();
		let closes = 0; let focused = 0; let opens = 0;
		const context = observableValue<ICanvasContext | undefined>('test', { owner, canvases, closeCanvas: async () => { closes++; await closing.promise; } });
		const service = { enabled: constObservable(true), isOwnerPresentable: () => true, revealCanvas: async () => { opens++; } } as unknown as ICanvasService;
		const control = lifetime.add(new CanvasesPillControl(container, context, () => focused++, service, { error: () => assert.fail('Unexpected notification') } as unknown as INotificationService));
		const open = container.querySelector<HTMLButtonElement>('[aria-label="Open Canvas Board"]')!;
		open.focus(); open.click();
		canvases.set([{ ...canvas, title: 'Updated', status: 'Ready' }], undefined);
		assert.equal(document.activeElement, open);
		assert.equal(control.getAccessibleContent(), 'Updated: Ready');
		assert.equal(opens, 1);
		const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Canvas Updated"]')!;
		close.focus(); close.click(); close.click();
		assert.equal(closes, 1);
		canvases.set([], undefined);
		assert.equal(focused, 1);
		assert.equal(control.domNode.hidden, true);
		closing.resolve(); await Promise.resolve();
	});

	test('a failed close leaves the control usable and an absent host close omits the action', async () => {
		using lifetime = new DisposableStore();
		const container = document.createElement('div');
		let errors = 0;
		const context = observableValue<ICanvasContext | undefined>('test', { owner: { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one') }, canvases: constObservable([{ resource: URI.parse('canvas:/one'), instanceId: 'board', title: 'Board', source: URI.parse('https://example.test') }]), closeCanvas: async () => { throw new Error('offline'); } });
		lifetime.add(new CanvasesPillControl(container, context, () => { }, { enabled: constObservable(true), isOwnerPresentable: () => true } as unknown as ICanvasService, { error: () => errors++ } as unknown as INotificationService));
		const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Canvas Board"]')!;
		close.click(); await new Promise(resolve => setImmediate(resolve));
		assert.equal(errors, 1); assert.equal(close.disabled, false);
		context.set({ ...context.get()!, closeCanvas: undefined }, undefined);
		assert.equal(close.hidden, true);
	});
});
