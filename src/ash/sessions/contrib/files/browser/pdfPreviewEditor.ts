import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import './media/pdfPreview.css';

const maxFileBytes = 64 * 1024 * 1024;
const maxPagePixels = 4 * 1024 * 1024;
GlobalWorkerOptions.workerSrc = workerUrl;

/** A read-only PDF fallback for Files. Only the active page owns a canvas. */
export class PdfPreviewEditor extends EditorPane implements IEditorPaneWithViewState {
	readonly viewStateTypeId = 'sessions.pdfPreview';
	private readonly input = this._register(new MutableDisposable<DisposableStore>());
	private readonly painting = this._register(new MutableDisposable<DisposableStore>());
	private element!: HTMLElement;
	private surface!: HTMLElement;
	private progress!: HTMLElement;
	private error!: HTMLElement;
	private previous!: Button;
	private next!: Button;
	private pdf: PDFDocumentProxy | undefined;
	private pageNumber = 1;

	constructor(
		readonly id: string,
		@IFileService private readonly files: IFileService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(id, theme, storage);
	}

	override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-sessions-pdf-preview' });
		const controls = h(document, 'div', { className: 'ash-sessions-pdf-controls' });
		this.progress = h(document, 'span', { attributes: { role: 'status' } });
		this.previous = this._register(new Button(controls, {
			...defaultButtonStyles,
			icon: Lxicon.chevronLeft,
			iconOnly: true,
			label: localize('sessions.pdfPreview.previous', 'Previous page'),
			onClick: () => void this.showPage(this.pageNumber - 1),
		}));
		controls.append(this.progress);
		this.next = this._register(new Button(controls, {
			...defaultButtonStyles,
			icon: Lxicon.chevronRight,
			iconOnly: true,
			label: localize('sessions.pdfPreview.next', 'Next page'),
			onClick: () => void this.showPage(this.pageNumber + 1),
		}));
		this.surface = h(document, 'div', { className: 'ash-sessions-pdf-page', properties: { tabIndex: 0 } });
		this.error = h(document, 'p', { className: 'ash-sessions-pdf-error', attributes: { role: 'alert' } });
		this.element.append(controls, this.error, this.surface);
		parent.append(this.element);
		super.create(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.element.setAttribute('aria-label', input.label ?? basename(input.resource));
		this.progress.textContent = localize('sessions.pdfPreview.loading', 'Loading PDF…');
		const store = new DisposableStore();
		this.input.value = store;
		const cancellation = new CancellationTokenSource();
		store.add(toDisposable(() => cancellation.dispose(true)));
		const abort = () => { if (this.input.value === store) this.clearInput(); };
		signal.addEventListener('abort', abort, { once: true });
		store.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		try {
			throwIfCancelled(signal);
			const data = input.initialBytes ?? (await streamToBuffer((await this.files.readFileStream(
				input.resource, { limits: { size: maxFileBytes } }, cancellation.token,
			)).value)).buffer;
			throwIfCancelled(cancellation.token);
			if (data.byteLength > maxFileBytes) throw new Error('PDF exceeds preview size limit');
			const task = getDocument({ data: data.slice(), useWasm: false, maxImageSize: maxPagePixels });
			store.add(toDisposable(() => {
				void task.destroy().catch(() => undefined);
			}));
			const pdf = await raceCancellationError(task.promise, cancellation.token);
			throwIfCancelled(cancellation.token);
			this.pdf = pdf;
			await this.showPage(1);
			throwIfCancelled(cancellation.token);
		} catch (error) {
			throwIfCancelled(signal);
			if (this.input.value !== store) return;
			this.clearInput();
			this.error.textContent = localize('sessions.pdfPreview.openFailed', 'Could not preview this PDF. Check that the file is available and can be read.');
		}
	}

	private async showPage(number: number): Promise<void> {
		const pdf = this.pdf;
		if (!pdf || number < 1 || number > pdf.numPages) return;
		const store = new DisposableStore();
		this.painting.value = store;
		this.pageNumber = number;
		this.progress.textContent = localize('sessions.pdfPreview.page', 'Page {0} of {1}', number, pdf.numPages);
		const focused = getActiveElement(this.element.ownerDocument);
		this.previous.enabled = number > 1;
		this.next.enabled = number < pdf.numPages;
		if (focused === this.previous.domNode && !this.previous.enabled || focused === this.next.domNode && !this.next.enabled) {
			this.surface.focus();
		}
		this.error.textContent = '';
		this.surface.setAttribute('aria-busy', 'true');
		try {
			const page = await pdf.getPage(number);
			if (store.isDisposed) return;
			const size = page.getViewport({ scale: 1 });
			const scale = Math.min(2, 4096 / size.width, 4096 / size.height, Math.sqrt(maxPagePixels / (size.width * size.height)));
			const viewport = page.getViewport({ scale });
			const canvas = h(this.element.ownerDocument, 'canvas', {
				properties: { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) },
				attributes: { 'aria-hidden': 'true' },
			});
			canvas.style.inlineSize = `${size.width}px`;
			const paint = page.render({ canvas, viewport });
			const cancel = store.add(toDisposable(() => paint.cancel()));
			await paint.promise;
			store.delete(cancel);
			if (store.isDisposed) return;
			this.surface.replaceChildren(canvas);
			this.surface.scrollTop = 0;
			const { items } = await page.getTextContent();
			if (store.isDisposed) return;
			const text = items.map(item => 'str' in item ? item.str : '').join(' ').trim();
			if (text) this.surface.append(h(this.element.ownerDocument, 'p', { className: 'ash-aria-live' }, text));
		} catch {
			if (store.isDisposed) return;
			this.surface.replaceChildren();
			this.error.textContent = localize('sessions.pdfPreview.pageFailed', 'Could not display this PDF page.');
		} finally {
			if (!store.isDisposed) this.surface.removeAttribute('aria-busy');
		}
	}

	override clearInput(): void {
		this.painting.clear();
		this.input.clear();
		this.pdf = undefined;
		this.pageNumber = 1;
		this.previous.enabled = false;
		this.next.enabled = false;
		this.progress.textContent = '';
		this.error.textContent = '';
		this.surface.removeAttribute('aria-busy');
		this.surface.replaceChildren();
	}

	override focus(): void { this.surface.focus(); }
	override layout(): void { }

	saveViewState(): unknown { return this.pageNumber; }
	restoreViewState(state: unknown): void {
		if (typeof state === 'number' && Number.isSafeInteger(state) && state !== this.pageNumber) void this.showPage(state);
	}
}
