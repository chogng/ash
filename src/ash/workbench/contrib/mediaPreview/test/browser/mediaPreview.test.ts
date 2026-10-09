import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'mocha';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { FileKind, IFileService, type IFileChangeEvent, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { EditorPanes, getBuiltinEditorPaneFactory } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { AppServerExtensionService } from '../../../../services/extensions/browser/appServerExtensionService.js';
import type { ITextMateService } from '../../../../services/textMate/common/textMateService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { AUDIO_PREVIEW_ID, VIDEO_PREVIEW_ID, MediaPreview } from '../../browser/mediaPreview.js';
import { createTestFileService, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import '../../browser/mediaPreview.contribution.js';

test('Built-in media declarations activate from the package catalog, localize, refresh and revoke', async () => {
	const manifestJson = await readFile('extensions/media-preview/package.json', 'utf8');
	const descriptor = {
		id: 'ash.media-preview', name: 'media-preview', publisher: 'ash', version: '1.0.0', displayName: 'Media Preview', sourceKind: 'builtIn' as const,
		manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: `sha256:${'b'.repeat(64)}`,
	};
	let included = true;
	let sourceKind: 'builtIn' | 'user' = 'builtIn';
	let fail = false;
	let generation = 1;
	const grammars = {
		registerGrammars: () => ({ replace: () => { }, ...toDisposable(() => { }) }),
		prepareGrammars: async () => ({ commit: () => ({}) }),
		whenReady: async () => ({}),
	};
	using service = new AppServerExtensionService({
		api: {
			list: async () => ({ generation, extensions: included ? [{ ...descriptor, sourceKind }] : [], diagnostics: [] }),
			resources: new ExtensionResourceLoaderService(async request => {
				assert.equal(request.extensionId, descriptor.id);
				assert.equal(request.generation, generation);
				if (fail) { throw new Error('Editor labels unavailable'); }
				return readFile('extensions/media-preview/' + request.path);
			}),
		},
		textMateService: { grammars } as unknown as ITextMateService,
	});
	try {
		await service.start();
		const choices = ['PRODUCT.PNG', 'song.mp3', 'song.wav', 'song.ogg', 'movie.mp4', 'movie.webm'].map(name => EditorPanes.getEditorPane({ resource: URI.file('/media/' + name) })?.id);
		assert.deepEqual(choices, ['ash.imagePreview', AUDIO_PREVIEW_ID, AUDIO_PREVIEW_ID, AUDIO_PREVIEW_ID, VIDEO_PREVIEW_ID, VIDEO_PREVIEW_ID]);
		assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/asset'), contentType: 'image/webp; charset=binary' })?.id, 'ash.imagePreview');
		assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/asset'), contentType: 'audio/wav' })?.canOpen({ resource: URI.file('/asset'), contentType: 'audio/wav' }), EditorPaneMatch.Default);
		assert.equal(EditorPanes.getEditorPanesForInput({ resource: URI.file('/source.rs') }).some(pane => pane.id === AUDIO_PREVIEW_ID), false);
		const oldAudio = EditorPanes.getEditorPane({ resource: URI.file('/song.mp3') });
		generation++;
		fail = true;
		await assert.rejects(service.reload(), /Editor labels unavailable/);
		assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/song.mp3') }), oldAudio);
		fail = false;
		setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
		await service.reload();
		assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/movie.mp4') })?.name, '视频预览');
		sourceKind = 'user';
		generation++;
		await service.reload();
		assert.equal(EditorPanes.getEditorPanes().some(pane => pane.id === AUDIO_PREVIEW_ID), false);
		included = false;
		generation++;
		await service.reload();
		assert.equal(EditorPanes.getEditorPanes().some(pane => pane.id === AUDIO_PREVIEW_ID), false);
	} finally {
		resetNlsResolver();
	}
});

class MediaFixture extends Disposable {
	public readonly browser = new JSDOM('<!doctype html><body></body>');
	public readonly kind: 'audio' | 'video';
	public readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly services = this._register(new InstantiationService());
	public readonly revoked: string[] = [];
	public readonly operations: string[] = [];
	public readonly preview: MediaPreview;
	public read = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]);
	public pauseCount = 0;
	public playing = false;
	public get player(): HTMLMediaElement { return this.browser.window.document.querySelector(this.kind)!; }

	constructor(kind: 'audio' | 'video' = 'audio') {
		super();
		this.kind = kind;
		const originalRevoke = URL.revokeObjectURL;
		this._register(toDisposable(() => { this.browser.window.close(); URL.revokeObjectURL = originalRevoke; resetNlsResolver(); }));
		this._register(installEditorTestDom(this.browser, ['Node', 'Element', 'HTMLElement']));
		URL.revokeObjectURL = url => { this.operations.push('revoke'); this.revoked.push(url); originalRevoke(url); };
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
		this.services.registerSingleton(IFileService, () => createTestFileService({
			capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
			onDidChangeCapabilities: Event.None,
			watch: (): IDisposable => Disposable.None,

			onDidChangeFiles: this.changes.event,
			readFile: async target => ({ resource: target, bytes: await this.read(), revision: 'media' }),
			stat: async target => ({ resource: target, kind: FileKind.File, sizeBytes: 3, readonly: true, modifiedAtMillis: undefined }), readDirectory: unexpected, writeFile: unexpected,
			createFile: unexpected, createDirectory: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
		}));
		registerTestComponentServices(this.services, this.browser.window.document);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, ...toDisposable(() => { }) });
		const id = kind === 'audio' ? AUDIO_PREVIEW_ID : VIDEO_PREVIEW_ID;
		this.preview = this._register(getBuiltinEditorPaneFactory('ash.media-preview', id)!({ instantiationService: this.services }, kind === 'audio' ? 'Audio preview' : 'Video preview') as MediaPreview);
		this.preview.create(this.browser.window.document.body);
		const mediaPrototype = this.browser.window.HTMLMediaElement.prototype;
		const fixture = this;
		Object.defineProperties(mediaPrototype, { paused: { get: () => !this.playing }, duration: { get: () => 2 } });
		mediaPrototype.play = async () => { this.playing = true; };
		mediaPrototype.pause = () => { this.operations.push('pause'); this.pauseCount++; this.playing = false; };
		mediaPrototype.load = function (this: HTMLMediaElement): void { fixture.operations.push(this.hasAttribute('src') ? 'load-with-source' : 'load-cleared'); };
	}
}

test('Audio and video use the registered renderer, keyboard playback and stop before releasing their URLs', async () => {
	for (const kind of ['audio', 'video'] as const) {
		using fixture = new MediaFixture(kind);
		await fixture.preview.setInput({ resource: URI.file('/media/sample'), label: 'Sample' }, new AbortController().signal);
		const url = fixture.player.src;
		assert.deepEqual([fixture.player.controls, fixture.player.autoplay, fixture.player.preload], [true, false, 'metadata']);
		fixture.preview.focus();
		assert.equal(fixture.browser.window.document.activeElement, fixture.player);
		fixture.browser.window.document.querySelector('.ash-media-preview')!.dispatchEvent(new fixture.browser.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		assert.equal(fixture.playing, true);
		assert.match(fixture.preview.getAccessibleContent(), /Sample[\s\S]*3 bytes[\s\S]*2 seconds[\s\S]*Playing/);
		fixture.preview.setVisible(false);
		assert.equal(fixture.playing, false);
		fixture.operations.length = 0;
		fixture.preview.clearInput();
		assert.deepEqual([fixture.player.hasAttribute('src'), fixture.revoked, fixture.operations], [false, [url], ['pause', 'load-cleared', 'revoke']]);
	}
});

test('Audio and video keep first-open read failures in the pane and retry them', async () => {
	for (const kind of ['audio', 'video'] as const) {
		using fixture = new MediaFixture(kind);
		let reads = 0;
		fixture.read = async () => {
			if (++reads === 1) { throw new Error('Read denied'); }
			if (reads === 2) { throw new Error('Still unavailable'); }
			return new Uint8Array([1, 2, 3]);
		};
		await fixture.preview.setInput({ resource: URI.file('/media/retry'), label: 'Retry sample' }, new AbortController().signal);

		const failure = fixture.browser.window.document.querySelector<HTMLElement>('[role="alert"]')!;
		assert.match(failure.textContent!, /Could not load media: Error: Read denied/);
		const retry = fixture.browser.window.document.querySelector('button');
		assert.ok(retry, 'failed media load should expose a Retry button');
		assert.equal(retry.textContent?.trim(), 'Retry');
		assert.equal(fixture.player.hasAttribute('src'), false);

		retry.click();
		await setImmediate();
		assert.deepEqual([failure.hidden, failure.textContent, retry.hidden, fixture.player.hasAttribute('src')], [false, 'Could not load media: Error: Still unavailable', false, false]);
		retry.click();
		await setImmediate();
		const url = fixture.player.src;
		assert.deepEqual([failure.hidden, fixture.player.hasAttribute('src'), fixture.revoked], [true, true, []]);
		fixture.preview.clearInput();
		assert.deepEqual([fixture.player.hasAttribute('src'), fixture.revoked], [false, [url]]);
	}
});

test('A late media error from the previous player cannot replace a newer preview state', async () => {
	using fixture = new MediaFixture();
	await fixture.preview.setInput({ resource: URI.file('/media/old.mp3'), label: 'Old song' }, new AbortController().signal);
	const oldPlayer = fixture.player;
	const oldURL = oldPlayer.src;
	await fixture.preview.setInput({ resource: URI.file('/media/new.mp3'), label: 'New song' }, new AbortController().signal);
	const newPlayer = fixture.player;
	const newURL = newPlayer.src;

	oldPlayer.dispatchEvent(new fixture.browser.window.Event('error'));
	assert.deepEqual([
		oldPlayer === newPlayer,
		fixture.browser.window.document.querySelector<HTMLElement>('[role="alert"]')!.hidden,
		fixture.preview.getAccessibleContent().includes('New song'),
		fixture.revoked,
	], [false, true, true, [oldURL]]);
	fixture.preview.clearInput();
	assert.deepEqual(fixture.revoked, [oldURL, newURL]);
});

test('Closing while a media read is pending ignores its late failure and leaves no URL', async () => {
	const fixture = new MediaFixture();
	try {
		const pending = new DeferredPromise<Uint8Array>();
		fixture.read = () => pending.p;
		const opening = fixture.preview.setInput({ resource: URI.file('/media/closing.mp3') }, new AbortController().signal);
		const cancelled = assert.rejects(opening, /cancelled/);
		const player = fixture.player;
		fixture.preview.dispose();
		await pending.error(new Error('Late read failure'));
		await cancelled;
		assert.deepEqual([fixture.revoked, player.hasAttribute('src')], [[], false]);
	} finally {
		fixture.dispose();
	}
});

test('Cancelling a media load cannot replace a newer resource or allocate a URL', async () => {
	using fixture = new MediaFixture();
	const pending = new DeferredPromise<Uint8Array>();
	fixture.read = () => pending.p;
	const opening = fixture.preview.setInput({ resource: URI.file('/old.mp3') }, new AbortController().signal);
	const cancelled = assert.rejects(opening, /cancelled/);
	fixture.read = async () => new Uint8Array([1, 2, 3]);
	await fixture.preview.setInput({ resource: URI.file('/new.mp3'), label: 'New song' }, new AbortController().signal);
	await pending.error(new Error('Old media read failed'));
	await cancelled;
	assert.match(fixture.preview.getAccessibleContent(), /New song/);
	assert.deepEqual([
		fixture.preview.getAccessibleContent().includes('Old media read failed'),
		fixture.browser.window.document.querySelector<HTMLElement>('[role="alert"]')!.hidden,
		fixture.browser.window.document.querySelector<HTMLButtonElement>('button')!.hidden,
		fixture.revoked.length,
	], [false, true, true, 0]);
});

test('Playback failure and accessible metadata are translated into Chinese', async () => {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', catalog.bundles);
	using fixture = new MediaFixture();
	await fixture.preview.setInput({ resource: URI.file('/song.wav') }, new AbortController().signal);
	assert.match(fixture.preview.getAccessibleContent(), /文件大小：3 字节[\s\S]*时长：2 秒[\s\S]*已暂停/);
	fixture.player.dispatchEvent(new fixture.browser.window.Event('error'));
	assert.match(fixture.browser.window.document.querySelector('[role="alert"]')!.textContent!, /无法播放此媒体文件/);
	assert.equal(fixture.browser.window.document.querySelector('button')!.textContent, '重试');
	fixture.read = async () => { throw new Error('Read denied'); };
	await fixture.preview.setInput({ resource: URI.file('/song.wav') }, new AbortController().signal);
	assert.match(fixture.preview.getAccessibleContent(), /无法加载媒体：Error: Read denied/);
	assert.equal(fixture.browser.window.document.querySelector('button')!.textContent, '重试');
});


test('Media file changes stop playback, replace the URL and recover from a failed read', async () => {
	using fixture = new MediaFixture();
	const resource = URI.file('/song.wav');
	await fixture.preview.setInput({ resource }, new AbortController().signal);
	const firstURL = fixture.player.src;
	await fixture.player.play();
	fixture.read = async () => { throw new Error('Read denied'); };
	fixture.changes.fire({ resources: [resource] });
	await setImmediate();
	assert.deepEqual([fixture.playing, fixture.revoked], [false, [firstURL]]);
	assert.match(fixture.preview.getAccessibleContent(), /Could not load media: Error: Read denied/);
	fixture.read = async () => new Uint8Array([4, 5]);
	fixture.changes.fire({ resources: [resource] });
	await setImmediate();
	assert.match(fixture.preview.getAccessibleContent(), /2 bytes/);
	assert.ok(fixture.player.src);
	assert.notEqual(fixture.player.src, firstURL);
});
