import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../base/common/async.js';
import type { CodeWindow } from '../../../base/browser/window.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IHostService } from '../../services/host/browser/host.js';
import { TestHostService } from '../../services/host/test/browser/testHostService.js';
import { BaseWindow } from '../../browser/window.js';

class TestWindow extends BaseWindow { }

suite('Workbench window focus', () => {
	test('element focus reaches the owning host and disposal restores the original DOM method', async () => {
		const dom = new JSDOM('<body><input></body>');
		using services = new InstantiationService();
		const host = new TestHostService();
		const original = dom.window.HTMLElement.prototype.focus;
		try {
			assert.throws(() => services.createInstance(TestWindow, dom.window as unknown as CodeWindow), /hostService/);
			services.registerInstance(IHostService, host);
			const owner = services.createInstance(TestWindow, dom.window as unknown as CodeWindow);
			const input = dom.window.document.querySelector('input')!;
			Object.defineProperty(dom.window.document, 'hasFocus', { value: () => false });
			input.focus();
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(dom.window.document.activeElement, input);
			assert.deepEqual(host.focused, [dom.window]);
			owner.dispose();
			assert.equal(dom.window.HTMLElement.prototype.focus, original);
		} finally { dom.window.close(); }
	});

	test('background application and stale requests cannot take host focus', async () => {
		const dom = new JSDOM('<body><input><button>Other control</button></body>');
		using services = new InstantiationService();
		const host = new TestHostService();
		services.registerInstance(IHostService, host);
		try {
			using owner = services.createInstance(TestWindow, dom.window as unknown as CodeWindow);
			Object.defineProperty(dom.window.document, 'hasFocus', { value: () => false });
			const input = dom.window.document.querySelector('input')!;
			const button = dom.window.document.querySelector('button')!;
			host.windows = host.windows.map(window => ({ ...window, focused: false }));
			input.focus();
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(host.focused, []);
			const first = promiseWithResolvers<typeof host.windows>();
			const second = promiseWithResolvers<typeof host.windows>();
			const third = promiseWithResolvers<typeof host.windows>();
			let request = 0;
			host.getWindows = () => [first.promise, second.promise, third.promise][request++]!;
			button.focus();
			input.focus();
			first.resolve(host.windows.map(window => ({ ...window, focused: true })));
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(host.focused, []);
			dom.window.dispatchEvent(new dom.window.Event('blur'));
			second.resolve(host.windows.map(window => ({ ...window, focused: true })));
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(host.focused, []);
			button.focus();
			owner.dispose();
			third.reject(new Error('Window closed during focus query'));
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(host.focused, []);
		} finally { dom.window.close(); }
	});
});
