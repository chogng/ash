import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setImmediate } from 'node:timers/promises';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { resetNlsResolver, setNlsResolver, formatNlsMessage } from '../../../../../nls.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService, FileKind, type IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { inspectImage } from '../../../../../platform/media/browser/image.js';
import { EditorPanes } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { IMAGE_PREVIEW_ID, ImagePreview, matchImagePreview } from '../../browser/imagePreview.js';
import '../../browser/mediaPreview.contribution.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const resource = URI.file('/images/product.png');

class ImageFixture extends Disposable {
	public readonly browser = new JSDOM('<!doctype html><body></body>');
	public readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly services = this._register(new InstantiationService());
	public readonly revoked: string[] = [];
	public readonly preview: ImagePreview;
	public read = async (): Promise<Uint8Array> => png;
	public decode = async (): Promise<ImageBitmap> => ({ width: 800, height: 600, close: () => { this.closedBitmaps++; } }) as ImageBitmap;
	public closedBitmaps = 0;

	constructor() {
		super();
		this._register(toDisposable(() => this.preview.dispose()));
		const originalRevoke = URL.revokeObjectURL;
		this._register(toDisposable(() => { this.browser.window.close(); URL.revokeObjectURL = originalRevoke; resetNlsResolver(); }));
		this._register(installEditorTestDom(this.browser, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement'], { createImageBitmap: () => this.decode() }));
		Object.defineProperty(this.browser.window, 'ResizeObserver', { value: class { observe(): void {} disconnect(): void {} } });
		URL.revokeObjectURL = url => { this.revoked.push(url); originalRevoke(url); };
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
		this.services.registerInstance(IFileService, {
			onDidChangeFiles: this.changes.event,
			readFileBytes: async target => ({ resource: target, bytes: await this.read(), revision: 'image' }),
			stat: async target => ({ resource: target, kind: FileKind.File, sizeBytes: png.length, readonly: true, modifiedAtMillis: undefined }),
			readFile: unexpected, readDirectory: unexpected, writeFile: unexpected, writeFileBytes: unexpected,
			createFile: unexpected, createDirectory: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
		});
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IContextMenuService, { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => {}, hideContextMenu: () => {} });
		this.services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, dispose: () => {}, [Symbol.dispose]: () => {} });
		this.preview = this._register(EditorPanes.getEditorPane({ resource })!.create({ instantiationService: this.services }) as ImagePreview);
		this.preview.create(this.browser.window.document.body);
		const viewport = this.browser.window.document.querySelector('.ash-image-preview-viewport')!;
		Object.defineProperties(viewport, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
	}
}

test('Image preview matches supported image resources and requires production services', () => {
	assert.deepEqual([
		matchImagePreview({ resource: URI.file('/PRODUCT.PNG') }),
		matchImagePreview({ resource: URI.file('/asset'), contentType: 'image/webp; charset=binary' }),
		matchImagePreview({ resource: URI.file('/movie.mp4') }),
	], [EditorPaneMatch.Default, EditorPaneMatch.Default, EditorPaneMatch.None]);
	using services = new InstantiationService();
	assert.throws(() => EditorPanes.getEditorPane({ resource })!.create({ instantiationService: services }), /fileService/);
});

test('Image preview opens through the registered pane, zooms and releases its URL on closure', async () => {
	using fixture = new ImageFixture();
	await fixture.preview.setInput({ resource, label: 'Product' }, new AbortController().signal);
	const image = fixture.browser.window.document.querySelector('img')!;
	const url = image.src;
	assert.equal(fixture.preview.id, IMAGE_PREVIEW_ID);
	assert.deepEqual([image.style.width, image.style.height, image.alt, fixture.closedBitmaps], ['400px', '300px', 'Product', 1]);
	fixture.preview.focus();
	const viewport = fixture.browser.window.document.activeElement!;
	viewport.dispatchEvent(new fixture.browser.window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
	assert.equal(image.style.width, '800px');
	assert.match(fixture.preview.getAccessibleContent(), /800 × 600 pixels[\s\S]*100%/);
	viewport.dispatchEvent(new fixture.browser.window.KeyboardEvent('keydown', { key: '+', bubbles: true }));
	assert.equal(image.style.width, '1000px');
	fixture.preview.clearInput();
	assert.deepEqual([image.hasAttribute('src'), fixture.revoked], [false, [url]]);
});

test('Image preview cancellation cannot replace a newer image or retain a preview URL', async () => {
	using fixture = new ImageFixture();
	const first = new DeferredPromise<Uint8Array>();
	fixture.read = () => first.p;
	const opening = fixture.preview.setInput({ resource }, new AbortController().signal);
	const cancelled = assert.rejects(opening, /cancelled/);
	fixture.read = async () => png;
	await fixture.preview.setInput({ resource: URI.file('/images/new.png'), label: 'New' }, new AbortController().signal);
	await first.complete(png);
	await cancelled;
	assert.match(fixture.preview.getAccessibleContent(), /Image: New/);
	assert.equal(fixture.closedBitmaps, 1);
});

test('Image preview closes a decoder that finishes after disposal', async () => {
	const fixture = new ImageFixture();
	try {
		const decoding = new DeferredPromise<ImageBitmap>();
		const started = new DeferredPromise<void>();
		fixture.decode = () => { void started.complete(); return decoding.p; };
		const opening = fixture.preview.setInput({ resource }, new AbortController().signal);
		const cancelled = assert.rejects(opening, /cancelled/);
		await started.p;
		fixture.preview.dispose();
		await decoding.complete({ width: 800, height: 600, close: () => { fixture.closedBitmaps++; } } as ImageBitmap);
		await cancelled;
		assert.deepEqual([fixture.closedBitmaps, fixture.revoked.length, fixture.browser.window.document.querySelector('img')], [1, 0, null]);
	} finally {
		fixture.dispose();
	}
});

test('Image preview updates its visible and accessible text when Chinese is selected', async () => {
	using fixture = new ImageFixture();
	await fixture.preview.setInput({ resource }, new AbortController().signal);
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
	assert.match(fixture.browser.window.document.querySelector('.ash-image-preview-summary')!.textContent!, /像素.*适应窗口/);
	assert.match(fixture.preview.getAccessibleContent(), /图片：product.png[\s\S]*格式：image\/png/);
	assert.equal(fixture.browser.window.document.querySelector('button')!.textContent, '适应窗口');
});

test('Image preview refreshes a changed resource and revokes the previous URL', async () => {
	using fixture = new ImageFixture();
	await fixture.preview.setInput({ resource }, new AbortController().signal);
	const image = fixture.browser.window.document.querySelector('img')!;
	const original = image.src;
	fixture.decode = async () => ({ width: 320, height: 200, close: () => { fixture.closedBitmaps++; } }) as ImageBitmap;
	fixture.changes.fire({ resources: [URI.file('/other.png')] });
	await setImmediate();
	assert.equal(image.src, original);
	fixture.changes.fire({ resources: [resource] });
	await setImmediate();
	assert.deepEqual([image.style.width, image.style.height, fixture.revoked], ['320px', '200px', [original]]);
	assert.notEqual(image.src, original);
});

test('Image inspection rejects unsupported signatures and failed decoding before creating a URL', async () => {
	using fixture = new ImageFixture();
	await assert.rejects(inspectImage(new Uint8Array([137, 80, 78, 71])), /PNG, JPEG or WebP/);
	fixture.decode = async () => { throw new Error('Invalid encoded image'); };
	await assert.rejects(fixture.preview.setInput({ resource }, new AbortController().signal), /could not be decoded/);
	assert.deepEqual([fixture.revoked.length, fixture.browser.window.document.querySelector('img')!.hasAttribute('src')], [0, false]);
});

test('Image preview reports a failed refresh and loads the resource again on its next change', async () => {
	using fixture = new ImageFixture();
	await fixture.preview.setInput({ resource }, new AbortController().signal);
	const image = fixture.browser.window.document.querySelector('img')!;
	fixture.read = async () => { throw new Error('Removed file'); };
	fixture.changes.fire({ resources: [resource] });
	await setImmediate();
	assert.equal(image.hasAttribute('src'), false);
	assert.match(fixture.preview.getAccessibleContent(), /Could not load image: Removed file/);
	fixture.read = async () => png;
	fixture.changes.fire({ resources: [resource] });
	await setImmediate();
	assert.equal(image.hasAttribute('src'), true);
	assert.match(fixture.preview.getAccessibleContent(), /Image: product.png/);
});
