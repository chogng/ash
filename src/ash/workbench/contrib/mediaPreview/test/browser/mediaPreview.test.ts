import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'mocha';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { FileKind, IFileService, type IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { EditorPanes, getBuiltinEditorPaneFactory } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { AppServerExtensionService } from '../../../../services/extensions/browser/appServerExtensionService.js';
import type { ITextMateService } from '../../../../services/textMate/common/textMateService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { AUDIO_PREVIEW_ID, VIDEO_PREVIEW_ID, MediaPreview } from '../../browser/mediaPreview.js';
import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
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
			readResource: async request => {
				assert.equal(request.extensionId, descriptor.id);
				assert.equal(request.generation, generation);
				if (fail) { throw new Error('Editor labels unavailable'); }
				return readFile('extensions/media-preview/' + request.path);
			},
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
	public readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly services = this._register(new InstantiationService());
	public readonly revoked: string[] = [];
	public readonly preview: MediaPreview;
	public readonly player: HTMLMediaElement;
	public read = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]);
	public pauseCount = 0;
	public playing = false;

	constructor(kind: 'audio' | 'video' = 'audio') {
		super();
		const originalRevoke = URL.revokeObjectURL;
		this._register(toDisposable(() => { this.browser.window.close(); URL.revokeObjectURL = originalRevoke; resetNlsResolver(); }));
		this._register(installEditorTestDom(this.browser, ['Node', 'Element', 'HTMLElement']));
		URL.revokeObjectURL = url => { this.revoked.push(url); originalRevoke(url); };
		const unexpected = async (): Promise<never> => { throw new Error('Unexpected file operation'); };
		this.services.registerInstance(IFileService, {
			onDidChangeFiles: this.changes.event,
			readFileBytes: async target => ({ resource: target, bytes: await this.read(), revision: 'media' }),
			stat: async target => ({ resource: target, kind: FileKind.File, sizeBytes: 3, readonly: true, modifiedAtMillis: undefined }),
			readFile: unexpected, readDirectory: unexpected, writeFile: unexpected, writeFileBytes: unexpected,
			createFile: unexpected, createDirectory: unexpected, copy: unexpected, rename: unexpected, delete: unexpected,
		});
		registerTestComponentServices(this.services, this.browser.window.document);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, ...toDisposable(() => { }) });
		const id = kind === 'audio' ? AUDIO_PREVIEW_ID : VIDEO_PREVIEW_ID;
		this.preview = this._register(getBuiltinEditorPaneFactory('ash.media-preview', id)!({ instantiationService: this.services }, kind === 'audio' ? 'Audio preview' : 'Video preview') as MediaPreview);
		this.preview.create(this.browser.window.document.body);
		this.player = this.browser.window.document.querySelector(kind)!;
		Object.defineProperties(this.player, { paused: { get: () => !this.playing }, duration: { value: 2 } });
		this.player.play = async () => { this.playing = true; };
		this.player.pause = () => { this.pauseCount++; this.playing = false; };
		this.player.load = () => { };
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
		fixture.preview.clearInput();
		assert.deepEqual([fixture.player.hasAttribute('src'), fixture.revoked], [false, [url]]);
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
	await pending.complete(new Uint8Array([4]));
	await cancelled;
	assert.match(fixture.preview.getAccessibleContent(), /New song/);
	assert.equal(fixture.revoked.length, 0);
});

test('Playback failure and accessible metadata are translated into Chinese', async () => {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages('zh-CN', catalog.bundles);
	using fixture = new MediaFixture();
	await fixture.preview.setInput({ resource: URI.file('/song.wav') }, new AbortController().signal);
	assert.match(fixture.preview.getAccessibleContent(), /文件大小：3 字节[\s\S]*时长：2 秒[\s\S]*已暂停/);
	fixture.player.dispatchEvent(new fixture.browser.window.Event('error'));
	assert.match(fixture.browser.window.document.querySelector('[role="alert"]')!.textContent!, /无法播放此媒体文件/);
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
