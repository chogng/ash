import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, noneDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { FileKind, IFileService, type IFileStat } from '../../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IFileTextModelService, ITextModelResourceService, type TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { createTestEditorServices, getWebviewHtml } from '../../../../test/common/testEditorServices.js';
import { WebviewEditor, type CustomTextEditorContent, type CustomTextEditorProvider } from '../../browser/webviewEditor.js';

function createEditor(store: DisposableStore, options: {
	acquire?: ITextModelResourceService['acquire'];
	stat?: IFileService['stat'];
	render?: CustomTextEditorProvider['render'];
} = {}): { pane: WebviewEditor; models: IFileTextModelService; container: HTMLDivElement; workingCopies: IWorkingCopyService; } {
	const parent = store.add(createTestEditorServices());
	const models = parent.get(IFileTextModelService);
	const services = store.add(parent.createChild());
	services.registerInstance(ITextModelResourceService, {
		...noneDisposable,
		acquire: options.acquire ?? ((input, signal) => models.acquire(input, signal)),
	});
	services.registerInstance(IFileService, {
		onDidChangeFiles: Event.None,
		stat: options.stat ?? (async resource => ({ resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined })),
	} as IFileService);
	services.registerInstance(IKeybindingService, { onDidUpdateKeybindings: Event.None } as IKeybindingService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Accessibility help' } as unknown as IAccessibleViewService);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(INotificationService, { error: () => { throw new Error('Unexpected notification'); } } as unknown as INotificationService);
	const pane = store.add(services.createInstance(WebviewEditor, {
		viewType: 'test.preview',
		displayName: 'Test preview',
		render: options.render ?? (async document => ({ html: `<h1>${document.text}</h1>` })),
	}, undefined));
	const container = document.createElement('div');
	document.body.append(container);
	store.add(toDisposable(() => container.remove()));
	pane.create(container);
	return { pane, models, container, workingCopies: services.get(IWorkingCopyService) };
}

const first = { resource: URI.parse('untitled:/first.md'), initialText: 'First' };
const second = { resource: URI.parse('untitled:/second.md'), initialText: 'Second' };
const abortSignal = (): AbortSignal => new AbortController().signal;
const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

suite('Webview editor input lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a late acquired reference is released without replacing the current document', async () => {
		using store = new DisposableStore();
		const acquired = new DeferredPromise<TextModelReference>();
		const release = new DeferredPromise<TextModelReference>();
		let firstSignal: AbortSignal | undefined;
		const editor = createEditor(store, {
			acquire: async (input, signal) => {
				const reference = await editor.models.acquire(input, signal);
				if (input === first) {
					firstSignal = signal;
					await acquired.complete(reference);
					return release.p;
				}
				return reference;
			},
		});
		const rejected = assert.rejects(editor.pane.setInput(first, abortSignal()), isAbortError);
		const reference = await acquired.p;
		await editor.pane.setInput(second, abortSignal());
		await release.complete(reference);
		await rejected;
		assert.equal(firstSignal?.aborted, true);
		assert.deepEqual(editor.workingCopies.getAll().map(copy => copy.backup()), ['Second']);
		assert.equal(editor.models.getModel(first.resource), null);
		assert.match(getWebviewHtml(editor.pane.getControl()!.element), /<h1>Second<\/h1>/u);
	});

	test('a late file stat cannot attach old listeners or render over the new input', async () => {
		using store = new DisposableStore();
		const started = new DeferredPromise<void>();
		const stat = new DeferredPromise<IFileStat>();
		const rendered: string[] = [];
		const file = { ...first, resource: URI.file('/first.md') };
		const editor = createEditor(store, {
			stat: async () => {
				await started.complete(undefined);
				return stat.p;
			},
			render: async document => {
				rendered.push(document.text);
				return { html: `<h1>${document.text}</h1>` };
			},
		});
		const rejected = assert.rejects(editor.pane.setInput(file, abortSignal()), isAbortError);
		await started.p;
		await editor.pane.setInput(second, abortSignal());
		await stat.complete({ resource: file.resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
		await rejected;
		assert.deepEqual(rendered, ['Second']);
		assert.equal(editor.models.getModel(file.resource), null);
		assert.deepEqual(editor.workingCopies.getAll().map(copy => copy.backup()), ['Second']);
	});

	for (const close of ['clear', 'dispose', 'abort'] as const) {
		test(`${close} cancels acquisition and releases a reference returned after closing`, async () => {
			using store = new DisposableStore();
			const acquired = new DeferredPromise<TextModelReference>();
			const release = new DeferredPromise<TextModelReference>();
			let acquisitionSignal: AbortSignal | undefined;
			const editor = createEditor(store, {
				acquire: async (input, signal) => {
					acquisitionSignal = signal;
					const reference = await editor.models.acquire(input, signal);
					await acquired.complete(reference);
					return release.p;
				},
			});
			const controller = new AbortController();
			const rejected = assert.rejects(editor.pane.setInput(first, controller.signal), isAbortError);
			const reference = await acquired.p;
			if (close === 'clear') {
				editor.pane.clearInput();
			} else if (close === 'dispose') {
				editor.pane.dispose();
			} else {
				controller.abort();
			}
			await release.complete(reference);
			await rejected;
			assert.equal(acquisitionSignal?.aborted, true);
			assert.equal(editor.models.getModel(first.resource), null);
			assert.deepEqual(editor.workingCopies.getAll(), []);
			assert.equal(editor.container.querySelector('iframe'), null);
		});
	}

	test('late rendering cannot replace a new webview or its working copy', async () => {
		using store = new DisposableStore();
		const started = new DeferredPromise<AbortSignal>();
		const content = new DeferredPromise<CustomTextEditorContent>();
		const editor = createEditor(store, {
			render: async (document, signal) => {
				if (document.text === 'First') {
					await started.complete(signal);
					return content.p;
				}
				return { html: '<h1>Second</h1>' };
			},
		});
		const rejected = assert.rejects(editor.pane.setInput(first, abortSignal()), isAbortError);
		const signal = await started.p;
		await editor.pane.setInput(second, abortSignal());
		const frame = editor.pane.getControl()!.element;
		await content.complete({ html: '<h1>Late first</h1>' });
		await rejected;
		assert.equal(signal.aborted, true);
		assert.equal(editor.pane.getControl()!.element, frame);
		assert.match(getWebviewHtml(frame), /<h1>Second<\/h1>/u);
		assert.deepEqual(editor.workingCopies.getAll().map(copy => copy.backup()), ['Second']);
	});

	test('provider failure releases the model and the next open succeeds', async () => {
		using store = new DisposableStore();
		const failure = new Error('Provider failed');
		const editor = createEditor(store, {
			render: async document => {
				if (document.text === 'First') {
					throw failure;
				}
				return { html: '<h1>Second</h1>' };
			},
		});
		await assert.rejects(editor.pane.setInput(first, abortSignal()), error => error === failure);
		assert.equal(editor.models.getModel(first.resource), null);
		assert.deepEqual(editor.workingCopies.getAll(), []);
		assert.equal(editor.pane.getControl(), undefined);
		await editor.pane.setInput(second, abortSignal());
		assert.match(getWebviewHtml(editor.pane.getControl()!.element), /<h1>Second<\/h1>/u);
	});
});
