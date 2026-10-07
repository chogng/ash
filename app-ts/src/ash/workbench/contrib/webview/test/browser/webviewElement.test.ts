import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WebviewElement } from '../../browser/webviewElement.js';

function mount(webview: WebviewElement): void {
	webview.mountTo(document.body, mainWindow);
}

function message(webview: WebviewElement, data: unknown, source: Window | null = webview.element.contentWindow): void {
	mainWindow.dispatchEvent(new mainWindow.MessageEvent('message', { source, data }));
}

function lifecycle(webview: WebviewElement, type: string, channel = webview.element.getAttribute('data-ash-webview-channel')): void {
	message(webview, { channel: channel + ':lifecycle', type });
}

suite('Webview element', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates an opaque-origin sandbox document and clears it on disposal', () => {
		using webview = new WebviewElement({ title: 'Markdown preview', options: {} });
		webview.setHtml('<h1>Preview</h1>');
		mount(webview);
		assert.deepEqual({
			sandbox: webview.element.getAttribute('sandbox'),
			referrer: webview.element.getAttribute('referrerpolicy'),
			credentialless: webview.element.getAttribute('credentialless'),
			title: webview.element.title,
			connected: webview.element.isConnected,
		}, {
			sandbox: 'allow-scripts', referrer: 'no-referrer', credentialless: '',
			title: 'Markdown preview', connected: true,
		});
		assert.match(webview.element.getAttribute('csp')!, /connect-src 'none'/);
		assert.match(webview.element.srcdoc, /Content-Security-Policy/);
		assert.match(webview.element.srcdoc, /default-src 'none'/);
		assert.match(webview.element.srcdoc, /acquireAshWebviewApi/);
		assert.match(webview.element.srcdoc, /<h1>Preview<\/h1>/);
		webview.dispose();
		assert.deepEqual({ connected: webview.element.isConnected, html: webview.element.srcdoc }, { connected: false, html: '' });
	});

	test('accepts only the owned iframe source and current document channel', () => {
		using webview = new WebviewElement({ title: 'Messages', options: {} });
		mount(webview);
		const received: unknown[] = [];
		using listener = webview.onMessage(event => received.push(event.message));
		const channel = webview.element.getAttribute('data-ash-webview-channel');
		message(webview, { channel, message: 'wrong source' }, mainWindow);
		message(webview, { channel: 'wrong', message: 'wrong channel' });
		message(webview, { channel, message: 'extra fields', extra: true });
		message(webview, { channel, message: { type: 'edit' } });
		webview.setHtml('<p>Next</p>');
		message(webview, { channel, message: 'stale edit' });
		message(webview, { channel: webview.element.getAttribute('data-ash-webview-channel'), message: 'new edit' });
		assert.deepEqual(received, [{ type: 'edit' }, 'new edit']);
	});

	test('queues messages before the first document and flushes once ready', async () => {
		using webview = new WebviewElement({ title: 'Queued', options: {} });
		const first = webview.postMessage('first');
		webview.setHtml('<p>Document</p>');
		mount(webview);
		const sent: unknown[] = [];
		const target = webview.element.contentWindow!;
		const original = target.postMessage;
		target.postMessage = value => { sent.push(value); };
		try {
			const second = webview.postMessage('second');
			assert.deepEqual(sent, []);
			lifecycle(webview, 'ready', 'stale');
			assert.deepEqual(sent, []);
			lifecycle(webview, 'ready');
			assert.deepEqual(await Promise.all([first, second]), [true, true]);
			lifecycle(webview, 'ready');
			assert.equal(await webview.postMessage('third'), true);
			assert.deepEqual(sent, ['first', 'second', 'third']);
		} finally {
			target.postMessage = original;
		}
	});

	test('replacement discards old pending messages and ignores late readiness', async () => {
		using webview = new WebviewElement({ title: 'Replacement', options: {} });
		mount(webview);
		const oldChannel = webview.element.getAttribute('data-ash-webview-channel');
		const discarded = webview.postMessage('old');
		webview.setHtml('<p>Replacement</p>');
		assert.equal(await discarded, false);
		const sent: unknown[] = [];
		const target = webview.element.contentWindow!;
		const original = target.postMessage;
		target.postMessage = value => { sent.push(value); };
		try {
			const current = webview.postMessage('current');
			lifecycle(webview, 'ready', oldChannel);
			assert.deepEqual(sent, []);
			lifecycle(webview, 'ready');
			assert.equal(await current, true);
			assert.deepEqual(sent, ['current']);
		} finally {
			target.postMessage = original;
		}
	});

	test('identical HTML keeps the document and its pending messages', async () => {
		using webview = new WebviewElement({ title: 'Same document', options: {} });
		webview.setHtml('<p>Same</p>');
		mount(webview);
		const channel = webview.element.getAttribute('data-ash-webview-channel');
		const pending = webview.postMessage('queued');
		webview.setHtml('<p>Same</p>');
		assert.equal(webview.element.getAttribute('data-ash-webview-channel'), channel);
		lifecycle(webview, 'ready');
		assert.equal(await pending, true);
	});

	test('preserves transfers and rejects a failed send without stranding later messages', async () => {
		using webview = new WebviewElement({ title: 'Transfers', options: {} });
		mount(webview);
		const target = webview.element.contentWindow!;
		const original = target.postMessage;
		const buffer = new ArrayBuffer(4);
		const sent: unknown[] = [];
		target.postMessage = (value: unknown, origin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
			if (value === 'invalid') {
				throw new mainWindow.DOMException('Cannot clone message', 'DataCloneError');
			}
			sent.push({ value, origin, transfer });
		};
		try {
			const rejected = assert.rejects(webview.postMessage('invalid'), { name: 'DataCloneError' });
			const transferred = webview.postMessage(buffer, [buffer]);
			lifecycle(webview, 'ready');
			await rejected;
			assert.equal(await transferred, true);
			assert.deepEqual(sent, [{ value: buffer, origin: '*', transfer: [buffer] }]);
			await assert.rejects(webview.postMessage('invalid'), { name: 'DataCloneError' });
		} finally {
			target.postMessage = original;
		}
	});

	test('disposal discards pending messages and releases message and focus listeners', async () => {
		using webview = new WebviewElement({ title: 'Disposed', options: {} });
		mount(webview);
		const target = webview.element.contentWindow!;
		const channel = webview.element.getAttribute('data-ash-webview-channel');
		const events: string[] = [];
		using focus = webview.onDidFocus(() => events.push('focus'));
		using blur = webview.onDidBlur(() => events.push('blur'));
		using disposed = webview.onDidDispose(() => events.push('dispose'));
		using received = webview.onMessage(() => events.push('message'));
		lifecycle(webview, 'focus');
		lifecycle(webview, 'focus');
		const pending = webview.postMessage('unsent');
		webview.dispose();
		mainWindow.dispatchEvent(new mainWindow.MessageEvent('message', { source: target, data: { channel, message: 'late' } }));
		webview.element.dispatchEvent(new mainWindow.Event('focus'));
		assert.deepEqual({ events, focused: webview.isFocused, sent: await pending, late: await webview.postMessage('late') },
			{ events: ['focus', 'blur', 'dispose'], focused: false, sent: false, late: false });
		assert.throws(() => webview.setHtml('late'), /already disposed/);
	});

	test('forwards valid keyboard events only when enabled', () => {
		using webview = new WebviewElement({ title: 'Keyboard', options: { forwardKeyboardEvents: true } });
		mount(webview);
		const events: string[] = [];
		using listener = webview.onDidKeyboardEvent(event => events.push(event.key));
		const channel = webview.element.getAttribute('data-ash-webview-channel') + ':keyboard';
		const event = { channel, type: 'keydown', key: 'F1', code: 'F1', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false };
		message(webview, { ...event, ctrlKey: 'invalid' });
		message(webview, event);
		using disabled = new WebviewElement({ title: 'No forwarding', options: {} });
		mount(disabled);
		using disabledListener = disabled.onDidKeyboardEvent(() => events.push('disabled'));
		message(disabled, { ...event, channel: disabled.element.getAttribute('data-ash-webview-channel') + ':keyboard' });
		assert.deepEqual(events, ['F1']);
	});
});
