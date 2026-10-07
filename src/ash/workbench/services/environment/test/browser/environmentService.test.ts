import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { BrowserWorkbenchEnvironmentService } from '../../browser/environmentService.js';

suite('Webview host environment', () => {
	test('gives local webviews independent origins on the existing product port', () => {
		const dom = new JSDOM('', { url: 'http://127.0.0.1:5173/browser/workbench/workbench.html' });
		try {
			const environment = new BrowserWorkbenchEnvironmentService(dom.window.location);
			assert.equal(environment.webviewExternalEndpoint, 'http://{{uuid}}.localhost:5173');
		} finally {
			dom.window.close();
		}
	});

	test('requires a secure origin per instance and an explicit endpoint for a deployed Web host', () => {
		const dom = new JSDOM('', { url: 'https://workbench.example.test/' });
		try {
			assert.throws(() => new BrowserWorkbenchEnvironmentService(dom.window.location), /configure an isolated webviewEndpoint/);
			for (const endpoint of ['https://resources.example.test/{{uuid}}', 'http://{{uuid}}.example.test', 'https://resources.example.test', 'https://user:secret@{{uuid}}.example.test']) {
				assert.throws(() => new BrowserWorkbenchEnvironmentService(dom.window.location, endpoint), TypeError);
			}
			assert.equal(new BrowserWorkbenchEnvironmentService(dom.window.location, 'https://{{uuid}}.resources.example.test').webviewExternalEndpoint, 'https://{{uuid}}.resources.example.test');
		} finally {
			dom.window.close();
		}
	});

	test('rejects an insecure Workbench ancestor even with an HTTPS resource endpoint', () => {
		const dom = new JSDOM('', { url: 'http://workbench.example.test/' });
		try {
			assert.throws(() => new BrowserWorkbenchEnvironmentService(dom.window.location, 'https://{{uuid}}.resources.example.test'), /Web host requires HTTPS/);
		} finally {
			dom.window.close();
		}
	});
});
