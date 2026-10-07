import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/webview.contribution.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWebviewService, type IWebview } from '../../browser/webview.js';
import { MarkdownPreview } from '../../../markdown/browser/markdownPreview.js';

suite('Webview service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('production registration creates tracked containers and clears only the current focus', () => {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IWebviewService)!;
		using instantiation = new InstantiationService(new ServiceCollection(descriptor));
		const service = instantiation.get(IWebviewService);
		using first = service.createWebviewElement({ title: 'First', options: {} });
		using second = service.createWebviewElement({ title: 'Second', options: {} });
		first.mountTo(document.body, mainWindow);
		second.mountTo(document.body, mainWindow);
		const changes: Array<IWebview | undefined> = [];
		using listener = service.onDidChangeActiveWebview(view => changes.push(view));
		first.element.dispatchEvent(new mainWindow.Event('focus'));
		first.element.dispatchEvent(new mainWindow.Event('focus'));
		second.element.dispatchEvent(new mainWindow.Event('focus'));
		first.element.dispatchEvent(new mainWindow.Event('blur'));
		assert.equal(service.activeWebview, second);
		first.dispose();
		assert.deepEqual([...service.webviews], [second]);
		assert.equal(service.activeWebview, second);
		second.dispose();
		assert.deepEqual({ views: [...service.webviews], active: service.activeWebview, changes },
			{ views: [], active: undefined, changes: [first, second, undefined] });
	});

	test('the preview requires the registered service and owns its container lifetime', () => {
		using missing = new InstantiationService();
		assert.throws(() => missing.createInstance(MarkdownPreview, document.body, {}), /Unknown service: webviewService/);
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IWebviewService)!;
		using instantiation = new InstantiationService(new ServiceCollection(descriptor));
		const service = instantiation.get(IWebviewService);
		using preview = instantiation.createInstance(MarkdownPreview, document.body, { title: 'Preview', markdown: '# Preview' });
		assert.equal([...service.webviews].length, 1);
		assert.equal(preview.element.isConnected, true);
		preview.dispose();
		assert.deepEqual([...service.webviews], []);
		assert.equal(preview.element.isConnected, false);
	});
});
