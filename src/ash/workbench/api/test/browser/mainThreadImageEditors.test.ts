import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import type { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import type { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ImageEditorService } from '../../../services/imageEditor/browser/imageEditorService.js';
import { MainThreadImageEditors } from '../../browser/mainThreadImageEditors.js';

class TestImageEditorService extends ImageEditorService {
	constructor() {
		super();
	}
	async capture() {
		return undefined;
	}
}

function fixture(payload: JsonValue) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
	lifetime.add(
		toDisposable(() => {
			if (previous) Object.defineProperty(globalThis, 'document', previous);
			else Reflect.deleteProperty(globalThis, 'document');
			dom.window.close();
		}),
	);
	const editors = lifetime.add(new TestImageEditorService());
	const adapter = lifetime.add(
		new MainThreadImageEditors(
			30_000,
			{ invoke: async () => payload } as unknown as IExtensionHostApi,
			{
				getExtensionPointContributions: () => [
					{
						description: { id: 'test.image' },
						value: [{ id: 'editor', displayName: 'Test image', default: true, accessibilityHelp: '' }],
					},
				],
			} as unknown as IExtensionService,
			editors,
			{} as ICodeEditorService,
			{} as IThemeService,
			{} as IConfigurationService,
			{} as INotificationService,
		),
	);
	const update = (enabled: boolean) =>
		adapter.update({
			generation: 1,
			extensions: [
				{
					id: 'test.image',
					packageDigest: 'digest',
					lifecycle: 'ready',
					incarnation: 1,
					activationGeneration: 1,
					registrations: enabled ? [{ kind: 'dataChannel', registrationId: 'editor', channelId: 'image.editor.v1' }] : [],
				},
			],
		} as unknown as ExtensionHostFleetSnapshot);
	update(true);
	return { editors, update, document: dom.window.document, [Symbol.dispose]: () => lifetime.dispose() };
}

test('public image providers can supply standalone HTML without packaged script or stylesheet roles', async () => {
	using value = fixture({
		html: '<main>Standalone</main><style>main{color:red}</style><script>window.hostExecuted=true</script>',
		resources: [],
		state: { marker: true },
	});
	const resolved = await value.editors.resolve('screen', new AbortController().signal);
	assert.match(resolved.view.html, /<main>Standalone<\/main>/);
	assert.match(resolved.view.html, /default-src 'none'/);
	assert.deepEqual(resolved.view.state, { marker: true });
	assert.equal((value.document.defaultView as unknown as Record<string, unknown>).hostExecuted, undefined);
	value.update(false);
	assert.equal(resolved.signal.aborted, true);
	assert.equal(value.editors.available, false);
});

test('public image resources are optional, preserve document order, and never execute in the host', async () => {
	const scripts = ['window.hostExecuted=1', 'window.hostExecuted=2'];
	const urls = scripts.map(script => URL.createObjectURL(new Blob([script], { type: 'text/javascript' })));
	try {
		using value = fixture({
			html: `<script src="${urls[0]}"></script><p>Between</p><script src="${urls[1]}"></script>`,
			resources: urls,
		});
		const resolved = await value.editors.resolve('selection', new AbortController().signal);
		assert(resolved.view.html.indexOf(scripts[0]) < resolved.view.html.indexOf('<p>Between</p>'));
		assert(resolved.view.html.indexOf('<p>Between</p>') < resolved.view.html.indexOf(scripts[1]));
		assert.equal((value.document.defaultView as unknown as Record<string, unknown>).hostExecuted, undefined);
		assert(!urls.some(url => resolved.view.html.includes(url)));
	} finally {
		urls.forEach(url => URL.revokeObjectURL(url));
	}
});

test('image HTML cannot make the host read an unregistered resource', async () => {
	using value = fixture({ html: '<script src="https://example.invalid/private.js"></script>', resources: [] });
	await assert.rejects(value.editors.resolve('screen', new AbortController().signal), /resource was not registered/);
});
