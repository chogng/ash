import { getActiveElement, h, addDisposableListener, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { PdfAnnotationEdit, PdfPage, PdfRect } from '../../../../platform/pdf/common/pdfService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../../workbench/browser/parts/editor/editorWithViewState.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { registerResourceEditorAccessibility } from '../../../../workbench/services/extensions/browser/resourceEditorAccessibility.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';
import { IPdfEditorService } from './pdfEditorService.js';
import './media/pdfPreview.css';

/** aspdf's Agent Window reader. Native PDF state is a derived snapshot of its working copy. */
export class PdfPreviewEditor extends EditorPane implements IEditorPaneWithViewState {
	public readonly viewStateTypeId = 'sessions.pdfPreview';
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly pageLifetime = this._register(new MutableDisposable<DisposableStore>());
	private element!: HTMLElement;
	private surface!: HTMLElement;
	private stage!: HTMLElement;
	private progress!: HTMLElement;
	private error!: HTMLElement;
	private annotations!: HTMLElement;
	private note!: HTMLTextAreaElement;
	private previous!: Button;
	private next!: Button;
	private saveButton!: Button;
	private undoButton!: Button;
	private redoButton!: Button;
	private highlightButton!: Button;
	private noteButton!: Button;
	private zoom!: HTMLSelectElement;
	private model: PdfDocumentModel | undefined;
	private pageNumber = 1;
	private busy = false;
	private savedPage = 1;
	private readonlyMode = true;
	public get workingCopy(): PdfDocumentModel | undefined { return this.model; }

	constructor(
		public readonly id: string,
		@IPdfEditorService private readonly editors: IPdfEditorService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(id, theme, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-sessions-pdf-preview' });
		const controls = h(document, 'div', { className: 'ash-sessions-pdf-controls', attributes: { role: 'group', 'aria-label': localize('sessions.pdfPreview.controls', 'PDF controls') } });
		controls.append(h(document, 'span', { className: 'ash-sessions-pdf-brand', properties: { textContent: localize('sessions.pdfPreview.title', 'aspdf') } }));
		this.previous = this.button(controls, localize('sessions.pdfPreview.previous', 'Previous page'), () => this.showPage(this.pageNumber - 1), Lxicon.chevronLeft);
		this.progress = h(document, 'span', { attributes: { role: 'status' } });
		controls.append(this.progress);
		this.next = this.button(controls, localize('sessions.pdfPreview.next', 'Next page'), () => this.showPage(this.pageNumber + 1), Lxicon.chevronRight);
		this.zoom = h(document, 'select', { attributes: { 'aria-label': localize('sessions.pdfPreview.zoom', 'PDF zoom') } });
		for (const [value, label] of [['fit', localize('sessions.pdfPreview.fitWidth', 'Fit width')], ['0.5', '50%'], ['1', '100%'], ['1.5', '150%'], ['2', '200%']]) {
			this.zoom.append(h(document, 'option', { properties: { value, textContent: label } }));
		}
		controls.append(this.zoom);
		this._register(addDisposableListener(this.zoom, 'change', () => this.updateZoom()));
		this.highlightButton = this.button(controls, localize('sessions.pdfPreview.highlight', 'Highlight selection'), () => this.highlight());
		this.noteButton = this.button(controls, localize('sessions.pdfPreview.addNote', 'Add note'), () => this.edit({ kind: 'note', bounds: { x: 0.05, y: 0.05, width: 0.04, height: 0.04 }, contents: this.note.value }));
		this.undoButton = this.button(controls, localize('sessions.pdfPreview.undo', 'Undo'), async () => { await this.model?.undo(); await this.paint(); });
		this.redoButton = this.button(controls, localize('sessions.pdfPreview.redo', 'Redo'), async () => { await this.model?.redo(); await this.paint(); });
		this.saveButton = this.button(controls, localize('sessions.pdfPreview.save', 'Save PDF'), () => this.save());
		this.error = h(document, 'p', { className: 'ash-sessions-pdf-error', attributes: { role: 'alert' } });
		const content = h(document, 'div', { className: 'ash-sessions-pdf-content' });
		this.surface = h(document, 'div', { className: 'ash-sessions-pdf-page', properties: { tabIndex: 0 } });
		this.stage = h(document, 'div', { className: 'ash-sessions-pdf-stage' });
		this.surface.append(this.stage);
		const sidebar = h(document, 'aside', { className: 'ash-sessions-pdf-annotations', attributes: { 'aria-label': localize('sessions.pdfPreview.annotations', 'PDF annotations') } });
		this.note = h(document, 'textarea', { properties: { maxLength: 8192, rows: 3 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
		sidebar.append(this.note);
		this.annotations = h(document, 'div');
		sidebar.append(this.annotations);
		content.append(this.surface, sidebar);
		this.element.append(controls, this.error, content);
		parent.append(this.element);
		super.create(this.element);
		this._register(registerResourceEditorAccessibility(this.element, this.configuration,
			() => this.accessibleContent(), () => localize('sessions.pdfPreview.help', 'aspdf displays one PDF page at a time. Use Previous page and Next page to navigate. Select text and choose Highlight selection. Enter annotation text and choose Add note to place a note near the top of the page. Existing annotations appear after the page, with Update and Delete controls. Undo and Redo change the annotation history. Save PDF writes standard annotations into the file. Read-only attachments cannot be changed.')));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void this.perform(() => this.save()); }
		}));
		this._register(toDisposable(() => { this.clearInput(); this.element.remove(); }));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.element.setAttribute('aria-label', localize('sessions.pdfPreview.reader', 'aspdf — {0}', input.label ?? basename(input.resource)));
		const store = new DisposableStore();
		this.inputLifetime.value = store;
		const lease = this.editors.acquire(input);
		store.add(lease.release);
		const model = lease.model;
		this.model = model;
		this.readonlyMode = model.readOnly;
		this.note.hidden = this.readonlyMode;
		this.element.classList.toggle('read-only', this.readonlyMode);
		store.add(model.onDidChangeContent(() => {
			this.updateControls();
			if (model.recoveryError) { this.showError(model.recoveryError); }
			else if (!this.busy) { void this.perform(() => this.paint()); }
		}));
		const abort = () => { if (this.inputLifetime.value === store) { this.clearInput(); } };
		signal.addEventListener('abort', abort, { once: true });
		store.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		this.progress.textContent = localize('sessions.pdfPreview.loading', 'Loading PDF…');
		try {
			signal.throwIfAborted();
			await lease.ready;
			if (this.model !== model) { return; }
			await this.showPage(this.savedPage);
		} catch (error) {
			signal.throwIfAborted();
			if (this.model === model) { this.showError(error); }
		}
	}

	private button(parent: HTMLElement, label: string, run: () => Promise<unknown>, icon?: ThemeIcon): Button {
		return this._register(new Button(parent, {
			...defaultButtonStyles, label, icon, iconOnly: !!icon,
			onClick: () => { void this.perform(run); }
		}));
	}

	private async perform(run: () => Promise<unknown>): Promise<void> {
		if (this.busy) { return; }
		this.busy = true; this.error.textContent = ''; this.updateControls();
		try { await run(); }
		catch (error) { this.showError(error); }
		finally { this.busy = false; this.updateControls(); }
	}

	private async showPage(number: number): Promise<void> {
		const model = this.model;
		if (!model || number < 1 || model.current && number > model.current.pageCount) { return; }
		const previous = this.pageNumber;
		this.pageNumber = number;
		try { await this.paint(); }
		catch (error) { this.pageNumber = previous; throw error; }
	}

	private async edit(edit: PdfAnnotationEdit): Promise<void> {
		if (!this.model || this.readonlyMode) { return; }
		await this.paint(edit);
	}

	private async highlight(): Promise<void> {
		const selection = this.element.ownerDocument.getSelection();
		if (!selection?.rangeCount || !selection.toString().trim()) {
			throw new Error(localize('sessions.pdfPreview.selectText', 'Select text on the page first.'));
		}
		const range = selection.getRangeAt(0);
		if (!this.stage.contains(range.commonAncestorContainer)) { return; }
		const page = this.stage.getBoundingClientRect();
		const rectangles = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
		if (!rectangles.length) { return; }
		// Selection geometry is normalized before crossing the native boundary.
		const left = Math.max(page.left, Math.min(...rectangles.map(rect => rect.left)));
		const top = Math.max(page.top, Math.min(...rectangles.map(rect => rect.top)));
		const right = Math.min(page.right, Math.max(...rectangles.map(rect => rect.right)));
		const bottom = Math.min(page.bottom, Math.max(...rectangles.map(rect => rect.bottom)));
		await this.edit({ kind: 'highlight', bounds: { x: (left - page.left) / page.width, y: (top - page.top) / page.height, width: (right - left) / page.width, height: (bottom - top) / page.height }, contents: this.note.value || selection.toString().slice(0, 8192) });
	}

	private async paint(edit?: PdfAnnotationEdit): Promise<void> {
		const model = this.model;
		if (!model) { return; }
		const { page, bytes } = await model.render(this.pageNumber, edit);
		if (this.model !== model) { return; }
		const store = new DisposableStore();
		this.pageLifetime.value = store;
		const document = this.element.ownerDocument;
		const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
		store.add(toDisposable(() => URL.revokeObjectURL(url)));
		const image = h(document, 'img', { properties: { src: url, draggable: false }, attributes: { alt: '', 'aria-hidden': 'true' } });
		const text = h(document, 'div', { className: 'ash-sessions-pdf-text' });
		for (const character of page.characters) {
			const span = h(document, 'span', { properties: { textContent: character.text } });
			this.position(span, character.bounds);
			span.style.fontSize = `${character.bounds.height * page.height / page.width * 100}cqw`;
			text.append(span);
		}
		this.stage.replaceChildren(image, text);
		this.stage.style.aspectRatio = `${page.width} / ${page.height}`;
		this.annotations.replaceChildren();
		for (const annotation of page.annotations) {
			const item = h(document, 'div', { className: 'ash-sessions-pdf-annotation' });
			item.append(h(document, 'p', { properties: { textContent: `${annotation.kind}${annotation.author ? ` · ${annotation.author}` : ''}` } }));
			const contents = h(document, 'textarea', { properties: { value: annotation.contents, readOnly: this.readonlyMode, maxLength: 8192, rows: 2 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
			item.append(contents);
			if (!this.readonlyMode) {
				for (const [label, edit] of [
					[localize('sessions.pdfPreview.updateAnnotation', 'Update'), () => ({ kind: 'update' as const, index: annotation.index, contents: contents.value })],
					[localize('sessions.pdfPreview.deleteAnnotation', 'Delete'), () => ({ kind: 'delete' as const, index: annotation.index })],
				] as const) {
					store.add(new Button(item, { ...defaultButtonStyles, label, onClick: () => { void this.perform(() => this.edit(edit())); } }));
				}
			}
			this.annotations.append(item);
		}
		this.progress.textContent = localize('sessions.pdfPreview.page', 'Page {0} of {1}', page.page, page.pageCount);
		this.updateZoom(); this.updateControls();
		const focused = getActiveElement(document);
		if (focused === this.previous.domNode && !this.previous.enabled || focused === this.next.domNode && !this.next.enabled) { this.surface.focus(); }
	}

	private position(element: HTMLElement, bounds: PdfRect): void {
		element.style.left = `${bounds.x * 100}%`; element.style.top = `${bounds.y * 100}%`;
		element.style.width = `${bounds.width * 100}%`; element.style.height = `${bounds.height * 100}%`;
	}

	private updateZoom(): void {
		const width = (this.model?.current?.widthPoints ?? 600) * 96 / 72;
		this.stage.style.width = this.zoom.value === 'fit' ? '100%' : `${width * Number(this.zoom.value)}px`;
		this.stage.classList.toggle('fit-width', this.zoom.value === 'fit');
	}

	private updateControls(): void {
		if (!this.previous) { return; }
		const page = this.model?.current;
		this.previous.enabled = !this.busy && !!page && page.page > 1;
		this.next.enabled = !this.busy && !!page && page.page < page.pageCount;
		this.saveButton.enabled = !this.busy && !this.readonlyMode && !!this.model?.isDirty;
		this.undoButton.enabled = !this.busy && !this.readonlyMode && !!this.model?.canUndo;
		this.redoButton.enabled = !this.busy && !this.readonlyMode && !!this.model?.canRedo;
		this.highlightButton.enabled = this.noteButton.enabled = !this.busy && !this.readonlyMode && !!page;
		this.zoom.disabled = !page;
		this.element.setAttribute('aria-busy', String(this.busy));
	}

	private showError(error: unknown): void {
		this.error.textContent = localize('sessions.pdfPreview.operationFailed', 'Could not complete the PDF operation: {0}', error instanceof Error ? error.message : String(error));
	}

	private accessibleContent(): string {
		const page = this.model?.current;
		if (!page) { return this.progress.textContent ?? ''; }
		return [this.progress.textContent, page.text || localize('sessions.pdfPreview.noText', 'This page has no extractable text.'),
		...page.annotations.map(annotation => `${annotation.kind}: ${annotation.contents}`),
		page.textTruncated || page.annotationsTruncated ? localize('sessions.pdfPreview.truncated', 'Some page content exceeds the reading limit.') : ''].filter(Boolean).join('\n\n');
	}

	public override async save(): Promise<void> { await this.model?.save(new AbortController().signal); }
	public override clearInput(): void {
		this.pageLifetime.clear(); this.inputLifetime.clear(); this.model = undefined; this.pageNumber = 1;
		this.stage?.replaceChildren(); this.annotations?.replaceChildren();
		if (this.progress) { this.progress.textContent = ''; this.error.textContent = ''; }
		this.updateControls();
	}
	public override focus(): void { this.surface.focus(); }
	public override layout(dimension: IDimension): void { this.element.classList.toggle('narrow', dimension.width < 640); }
	public saveViewState(): unknown { return this.pageNumber; }
	public restoreViewState(state: unknown): void {
		if (typeof state === 'number' && Number.isSafeInteger(state) && state > 0) {
			this.savedPage = state;
			if (this.model?.current && state !== this.pageNumber) { void this.perform(() => this.showPage(state)); }
		}
	}
}
