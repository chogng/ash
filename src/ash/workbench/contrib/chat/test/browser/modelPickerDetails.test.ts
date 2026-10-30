import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { renderModelDescription } from '../../browser/widget/input/modelPicker/modelPickerDetails.js';

test('Model descriptions render markup safely, open documentation through the host and release their handlers', () => {
	const environment = new JSDOM('<body><div></div></body>');
	try {
		const target = environment.window.document.querySelector('div')!;
		const opened: unknown[] = [];
		const opener = { open: async (href, options) => { opened.push({ href, options }); return true; } } as IOpenerService;
		const scope = new DisposableStore();
		try {
			const rendered = renderModelDescription('**Strong** description. <img src=x onerror=alert(1)> [Docs](https://example.test/docs)', opener, scope, URI.parse('https://example.test/more'), target);
			assert.equal(rendered.element, target);
			assert.equal(target.querySelector('strong')?.textContent, 'Strong');
			assert.equal(target.querySelector('img'), null);
			assert.ok(target.textContent?.includes('<img src=x onerror=alert(1)>'));
			assert.equal(rendered.learnMoreLink?.parentElement?.tagName, 'P');
			assert.deepEqual(opened, []);
			rendered.learnMoreLink!.click();
			assert.deepEqual(opened, [{ href: 'https://example.test/more', options: { allowCommands: false, fromUserGesture: true } }]);
			scope.dispose();
			target.addEventListener('click', event => event.preventDefault(), { once: true });
			rendered.learnMoreLink!.click();
			assert.equal(opened.length, 1);
			assert.equal(target.isConnected, true);
		} finally { scope.dispose(); }
	} finally { environment.window.close(); }
});
