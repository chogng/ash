import { getActiveElement, getWindow, h, addDisposableListener, runWhenWindowIdle, scheduleAtNextAnimationFrame, type IDimension } from '../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { ZoomAnchor } from '../../../../base/browser/ui/zoom/zoomAnchor.js';
import { clamp } from '../../../../base/common/numbers.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Action } from '../../../../base/common/actions.js';
import { Delayer, RunOnceScheduler } from '../../../../base/common/async.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { Icon } from '../../../../base/common/icon.js';
import { basename } from '../../../../base/common/resources.js';
import { UndoCommand, RedoCommand } from '../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { PdfAnnotationEdit, PdfPage, PdfPoint, PdfRect } from '../../../../platform/pdf/common/pdfService.js';
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

type PdfTool = 'ink' | 'eraser' | 'text';
type PdfZoom = 'page' | 'width' | number;

const pdfEditorFocus = new RawContextKey<boolean>('sessions.pdfEditorFocus', false);
const initialRasterDimension = 1600;
const maximumRasterDimension = 2048;

/** aspdf's Agent Window reader. Native PDF state is a derived snapshot of its working copy. */
export class PdfPreviewEditor extends EditorPane implements IEditorPaneWithViewState {
	public readonly viewStateTypeId = 'sessions.pdfPreview';
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly pageLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly imageLifetime = this._register(new MutableDisposable<IDisposable>());
	private element!: HTMLElement;
	private surface!: HTMLElement;
	private pageScroll!: ScrollableElement;
	private annotationScroll!: ScrollableElement;
	private annotationPanel!: HTMLElement;
	private stage!: HTMLElement;
	private selectionLayer: HTMLElement | undefined;
	private progress!: HTMLElement;
	private pageInput!: HTMLInputElement;
	private pageCount!: HTMLElement;
	private error!: HTMLElement;
	private annotations!: HTMLElement;
	private note!: HTMLTextAreaElement;
	private previous!: Action;
	private next!: Action;
	private saveAction!: Action;
	private highlightAction!: Action;
	private noteAction!: Action;
	private inkAction!: Action;
	private eraserAction!: Action;
	private textAction!: Action;
	private fitAction!: Action;
	private zoom: PdfZoom = 'page';
	private wheelZoomFrame!: AnimationFrameScheduler;
	private wheelZoom: { scale: number; readonly x: ZoomAnchor; readonly y: ZoomAnchor; } | undefined;
	private tool: PdfTool | undefined;
	private stroke: PdfPoint[] | undefined;
	private strokePreview: SVGPolylineElement | undefined;
	private pointerId: number | undefined;
	private keyboardPoint: PdfPoint = { x: 0.5, y: 0.5 };
	private readonly eraseLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly textLifetime = this._register(new MutableDisposable<DisposableStore>());
	private model: PdfDocumentModel | undefined;
	private displayedPage: PdfPage | undefined;
	private renderedDimension = initialRasterDimension;
	private pageRender: { readonly controller: AbortController; readonly refinement: boolean; } | undefined;
	private pagePaint: Promise<void> | undefined;
	private readonly pageTurnDelay = this._register(new Delayer<void>(90));
	private readonly zoomRefinement = this._register(new RunOnceScheduler(() => this.refineZoom(), 160));
	private pageNumber = 1;
	private busy = false;
	private savedPage = 1;
	private readonlyMode = true;
	public get workingCopy(): PdfDocumentModel | undefined { return this.model; }

	constructor(
		public readonly id: string,
		@IPdfEditorService private readonly editors: IPdfEditorService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(id, theme, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-sessions-pdf-preview' });
		const controls = h(document, 'div', { className: 'ash-sessions-pdf-controls', attributes: { role: 'group', 'aria-label': localize('sessions.pdfPreview.controls', 'PDF controls') } });
		const navigation = h(document, 'div', { className: 'ash-sessions-pdf-navigation' });
		controls.append(navigation);
		this.previous = this.action('previous', localize('sessions.pdfPreview.previous', 'Previous page'), Lxicon.chevronLeft, () => this.showPage(this.pageNumber - 1), false);
		this.toolbar(navigation, [this.previous], localize('sessions.pdfPreview.previous', 'Previous page'));
		const pages = h(document, 'div', { className: 'ash-sessions-pdf-pagination' });
		this.pageInput = h(document, 'input', { className: 'ash-sessions-pdf-page-number', properties: { type: 'text', inputMode: 'numeric', value: '1' }, attributes: { 'aria-label': localize('sessions.pdfPreview.pageNumber', 'Page number') } });
		this.pageCount = h(document, 'span', { properties: { textContent: '/–' }, attributes: { 'aria-hidden': 'true' } });
		pages.append(this.pageInput, this.pageCount);
		navigation.append(pages);
		const commitPage = () => {
			const value = this.pageInput.value.trim();
			const number = Number(value);
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > (this.displayedPage?.pageCount ?? 0)) {
				this.pageInput.value = String(this.pageNumber);
				status(localize('sessions.pdfPreview.invalidPage', 'Enter a page number between 1 and {0}.', this.displayedPage?.pageCount ?? 1));
				return;
			}
			if (number !== this.pageNumber) { void this.showPage(number); }
		};
		this._register(addDisposableListener(this.pageInput, 'change', commitPage));
		this._register(addDisposableListener(this.pageInput, 'keydown', event => {
			if (event.key === 'Enter') { event.preventDefault(); commitPage(); }
			if (event.key === 'Escape') { event.preventDefault(); this.pageInput.value = String(this.pageNumber); this.pageInput.select(); }
		}));
		this.next = this.action('next', localize('sessions.pdfPreview.next', 'Next page'), Lxicon.chevronRight, () => this.showPage(this.pageNumber + 1), false);
		this.toolbar(navigation, [this.next], localize('sessions.pdfPreview.next', 'Next page'));
		this.highlightAction = this.action('highlight', localize('sessions.pdfPreview.highlight', 'Highlight selection'), Lxicon.editLine, () => this.highlight());
		this.noteAction = this.action('note', localize('sessions.pdfPreview.addNote', 'Add note'), Lxicon.note, () => this.edit({ kind: 'note', bounds: { x: 0.05, y: 0.05, width: 0.04, height: 0.04 }, contents: this.note.value }));
		this.inkAction = this.action('ink', localize('sessions.pdfPreview.draw', 'Draw'), Lxicon.editWrite, () => this.selectTool('ink'));
		this.eraserAction = this.action('eraser', localize('sessions.pdfPreview.erase', 'Erase highlights and drawings'), Lxicon.eraser, () => this.selectTool('eraser'));
		this.textAction = this.action('text', localize('sessions.pdfPreview.addText', 'Add text box'), Lxicon.text, () => this.selectTool('text'));
		this.toolbar(controls, [this.noteAction, this.highlightAction, this.inkAction, this.eraserAction, this.textAction], localize('sessions.pdfPreview.annotations', 'PDF annotations'));
		this.fitAction = this.action('fit', localize('sessions.pdfPreview.fitPage', 'Fit page'), Lxicon.screenNormal, () => this.setZoom(this.zoom === 'page' ? 'width' : 'page'), false);
		this.saveAction = this.action('save', localize('sessions.pdfPreview.save', 'Save changes'), Lxicon.save, () => this.save());
		this.toolbar(controls, [this.fitAction, this.saveAction], localize('sessions.pdfPreview.documentActions', 'PDF document actions'));
		this.progress = h(document, 'span', { className: 'ash-sessions-pdf-status', attributes: { role: 'status' } });
		controls.append(this.progress);
		this.error = h(document, 'p', { className: 'ash-sessions-pdf-error', attributes: { role: 'alert' } });
		const content = h(document, 'div', { className: 'ash-sessions-pdf-content' });
		this.pageScroll = this._register(new ScrollableElement(content, {
			direction: 'both', vertical: 'auto', horizontal: 'auto',
			ariaLabel: localize('sessions.pdfPreview.documentPage', 'PDF page'),
			mouseWheelSmoothScroll: true,
		}));
		this.surface = this.pageScroll.element;
		this.surface.classList.add('ash-sessions-pdf-page');
		pdfEditorFocus.bindTo(this._register(this.contextKeys.createScoped(this.element))).set(true);
		for (const key of [KeyCode.Equal, KeyMod.Shift | KeyCode.Equal, KeyCode.Minus, KeyCode.NumpadAdd, KeyCode.NumpadSubtract, KeyCode.Digit0]) {
			for (const modifier of [KeyMod.CtrlCmd, KeyMod.WinCtrl]) {
				this._register(KeybindingsRegistry.registerKeybindingPassThrough({ keybinding: modifier | key, when: pdfEditorFocus.isEqualTo(true), priority: KeybindingWeight.WorkbenchContrib + 10 }));
			}
		}
		this.wheelZoomFrame = this._register(new AnimationFrameScheduler(getWindow(this.surface), () => this.flushWheelZoom()));
		// Consume modified input before the shared scroll owner or Chromium handles it.
		this._register(addDisposableListener(this.surface, 'wheel', event => {
			if (!event.ctrlKey && !event.metaKey) { this.flushWheelZoom(); return; }
			const wheel = new StandardWheelEvent(event, { pageWidth: this.pageScroll.scrollableElement.clientWidth, pageHeight: this.pageScroll.scrollableElement.clientHeight });
			wheel.stop();
			if (!this.busy && !this.stroke && wheel.deltaY !== 0) { this.queueWheelZoom(wheel); }
		}, { capture: true, passive: false }));
		this._register(addDisposableListener(this.surface, 'pointerdown', () => this.flushWheelZoom(), true));
		this._register(this.pageScroll.onDidScroll(() => this.flushWheelZoom()));
		this.pageScroll.contentElement.classList.add('ash-sessions-pdf-sheet');
		this.stage = h(document, 'div', { className: 'ash-sessions-pdf-stage' });
		this._register(addDisposableListener(this.stage, 'pointerdown', event => this.handlePointerDown(event)));
		this._register(addDisposableListener(this.stage, 'pointermove', event => this.handlePointerMove(event)));
		this._register(addDisposableListener(this.stage, 'pointerup', event => {
			if (event.pointerId === this.pointerId) { void this.perform(() => this.finishStroke()); }
		}));
		this._register(addDisposableListener(this.stage, 'pointercancel', () => this.cancelStroke()));
		this._register(addDisposableListener(this.surface, 'keydown', event => this.handlePageKeydown(event), true));
		const observer = new ResizeObserver(() => { this.flushWheelZoom(); this.updateZoom(); });
		observer.observe(this.pageScroll.scrollableElement);
		this._register(toDisposable(() => observer.disconnect()));
		this.pageScroll.append(this.stage);
		const sidebar = this.annotationPanel = h(document, 'aside', { className: 'ash-sessions-pdf-annotation-panel', attributes: { 'aria-label': localize('sessions.pdfPreview.annotations', 'PDF annotations') } });
		sidebar.hidden = true;
		this.note = h(document, 'textarea', { properties: { maxLength: 8192, rows: 3 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
		this.annotationScroll = this._register(new ScrollableElement(sidebar, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		this.annotationScroll.contentElement.classList.add('ash-sessions-pdf-annotations');
		this.annotationScroll.append(this.note);
		this.annotations = h(document, 'div');
		this.annotationScroll.append(this.annotations);
		content.append(sidebar);
		this.element.append(controls, this.error, content);
		parent.append(this.element);
		super.create(this.element);
		this._register(registerResourceEditorAccessibility(this.element, this.configuration,
			() => this.accessibleContent(), () => localize('sessions.pdfPreview.help', 'The page opens centered and fitted to the reading area. Use the arrow keys, Page Up and Page Down to scroll. Hold Control or Command and use the mouse wheel to zoom around the pointer. With the page focused, Control or Command plus + or - zooms in or out; Control or Command plus 0 restores 100 percent. Enter a page number and press Enter to navigate, or use Previous page and Next page. Select text and choose Highlight selection. Enter annotation text and choose Add note. Choose Draw and drag on the page; with the page focused, press Space to start a stroke, use arrow keys to draw and press Enter to finish. Choose Erase highlights and drawings, then click a mark or focus its erase button and press Enter. Choose Add text box, then click the page or press Enter with the page focused; enter text and press Control+Enter or Command+Enter to apply. Escape cancels the current tool or text box. Fit page and Fit width switch the page size. Save changes writes annotations into the PDF file. Control+Z or Command+Z undoes an edit; add Shift to redo. Existing annotations have Update and Delete controls. Read-only attachments cannot be changed.')));
		// Workbench dispatches edit commands before bubbling DOM key events.
		for (const [command, operation] of [[UndoCommand, 'undo'], [RedoCommand, 'redo']] as const) {
			this._register(command.addImplementation(120, 'pdf-editor', () => {
				const target = getActiveElement(document);
				if (!target || !this.element.contains(target) || ['INPUT', 'TEXTAREA'].includes(target.tagName) || this.readonlyMode) { return false; }
				return this.perform(async () => { await this.model?.[operation](); await this.paint(); });
			}));
		}
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) {
				event.preventDefault(); event.stopImmediatePropagation();
				if (!this.busy && !this.stroke && this.displayedPage) {
					if (event.key === '0') { this.setZoom(1); }
					else { this.zoomBy(event.key === '-' ? 1 / 1.2 : 1.2); }
					status(localize('sessions.pdfPreview.zoomLevel', 'PDF zoom: {0}%', Math.round(this.currentScale() * 100)));
				}
				return;
			}
			if (event.key === 'Escape' && !this.textLifetime.value) { this.selectTool(undefined); }
			const target = event.target as HTMLElement;
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !this.readonlyMode && !['INPUT', 'TEXTAREA'].includes(target.tagName)) {
				event.preventDefault(); event.stopPropagation();
				void this.perform(async () => { if (event.shiftKey) { await this.model?.redo(); } else { await this.model?.undo(); } await this.paint(); });
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void this.perform(() => this.save()); }
		}));
		this._register(toDisposable(() => { this.clearInput(); this.element.remove(); }));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.element.setAttribute('aria-label', localize('sessions.pdfPreview.reader', 'PDF — {0}', input.label ?? basename(input.resource)));
		const store = new DisposableStore();
		this.inputLifetime.value = store;
		const lease = this.editors.acquire(input);
		store.add(lease.release);
		const model = lease.model;
		this.model = model;
		this.readonlyMode = model.readOnly;
		this.note.hidden = this.readonlyMode;
		this.element.classList.toggle('read-only', this.readonlyMode);
		this.updateAnnotationPanel();
		store.add(model.onDidChangeContent(() => {
			this.updateControls();
			if (model.recoveryError) { this.showError(model.recoveryError); }
			else if (!this.busy) { void this.showPage(this.pageNumber, this.renderedDimension); }
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

	private action(id: string, label: string, icon: Icon, run: () => Promise<unknown> | void, serialize = true): Action {
		const action = this._register(new Action(`sessions.pdfPreview.${id}`, label, '', true, async () => {
			if (serialize) { return this.perform(async () => run()); }
			await run();
		}));
		action.icon = icon;
		action.tooltip = label;
		return action;
	}

	private toolbar(parent: HTMLElement, actions: readonly Action[], label: string): void {
		const toolbar = this._register(new WorkbenchToolBar(parent, this.contextMenus, { ariaLabel: label, highlightToggledItems: true, actionViewItemProvider: (action, options) => new ButtonActionViewItem(action, { ...options, iconOnly: true }) }));
		toolbar.setActions(actions);
	}

	private async perform(run: () => Promise<unknown>): Promise<void> {
		if (this.busy || this.isNavigating()) { return; }
		this.flushWheelZoom();
		this.zoomRefinement.cancel();
		this.pageRender?.controller.abort();
		this.pageTurnDelay.cancel();
		this.busy = true; this.error.textContent = ''; this.updateControls();
		try { await run(); }
		catch (error) { this.showError(error); }
		finally { this.busy = false; this.updateControls(); }
	}

	private isNavigating(): boolean {
		return this.pageRender !== undefined && this.displayedPage?.page !== this.pageNumber;
	}

	private async showPage(number: number, dimension = initialRasterDimension, refinement = false): Promise<void> {
		if (!this.model || (this.busy && this.displayedPage) || !Number.isSafeInteger(number) || number < 1 || number > (this.displayedPage?.pageCount ?? Infinity)) { return; }
		const previous = this.displayedPage?.page ?? 1;
		const replacesPageTurn = this.pageRender && !this.pageRender.refinement && !refinement;
		this.pageRender?.controller.abort();
		const request = { controller: new AbortController(), refinement };
		this.pageRender = request;
		const signal = request.controller.signal;
		if (number !== previous) {
			this.zoomRefinement.cancel();
			this.textLifetime.clear(); this.cancelStroke();
		}
		this.pageNumber = number;
		this.pageInput.value = String(number);
		this.error.textContent = '';
		this.updateControls();
		try {
			// A first turn starts immediately. A burst replaces its pending turn before
			// starting another PDFium helper that the next key press would cancel.
			if (replacesPageTurn) { await this.pageTurnDelay.trigger(() => undefined); }
			// Only the latest request may start once the previous render has released its buffer.
			await this.pagePaint;
			if (signal.aborted) { return; }
			const paint = this.paint(undefined, number, dimension, signal);
			this.pagePaint = paint.catch(() => undefined);
			await paint;
			if (signal.aborted) { return; }
			if (number !== previous) { this.pageScroll.scrollTo(0, 0); }
			if (!refinement && typeof this.zoom === 'number') { this.zoomRefinement.schedule(); }
		} catch (error) {
			if (signal.aborted) { return; }
			this.pageNumber = previous;
			this.pageInput.value = String(previous);
			this.showError(error);
		} finally {
			if (this.pageRender === request) {
				this.pageRender = undefined;
				this.pagePaint = undefined;
				this.updateControls();
			}
		}
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

	private async paint(edit?: PdfAnnotationEdit, number = this.pageNumber, dimension = this.renderedDimension, signal?: AbortSignal): Promise<void> {
		const model = this.model;
		if (!model) { return; }
		const input = this.inputLifetime.value;
		const { page, bytes } = await model.render(number, edit, { dimension, signal });
		if (signal?.aborted || this.inputLifetime.value !== input) { return; }
		const document = this.element.ownerDocument;
		const imageBytes = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
		const url = URL.createObjectURL(new Blob([imageBytes], { type: 'image/png' }));
		const image = h(document, 'img', { properties: { src: url, draggable: false }, attributes: { alt: '', 'aria-hidden': 'true' } });
		const raster = toDisposable(() => {
			image.removeAttribute('src');
			URL.revokeObjectURL(url);
		});
		const abortDecode = () => raster.dispose();
		signal?.addEventListener('abort', abortDecode, { once: true });
		try {
			// Keep the previous page visible until the new raster is ready to swap.
			await image.decode();
		} catch (error) {
			raster.dispose();
			throw error;
		} finally {
			signal?.removeEventListener('abort', abortDecode);
		}
		if (signal?.aborted || this.inputLifetime.value !== input) { raster.dispose(); return; }
		const previousImage = this.stage.querySelector(':scope > img');
		if (previousImage && !edit && dimension > this.renderedDimension
			&& this.displayedPage?.page === page.page && this.displayedPage.revision === page.revision) {
			// Sharpening the same page leaves its text selection, search geometry
			// and annotation controls on the existing page coordinate system.
			previousImage.replaceWith(image);
			this.imageLifetime.value = raster;
			this.renderedDimension = dimension;
			return;
		}
		const store = new DisposableStore();
		this.pageLifetime.value = store;
		this.displayedPage = page;
		this.renderedDimension = dimension;
		this.selectionLayer = undefined;
		this.textLifetime.clear(); this.cancelStroke();
		this.stage.replaceChildren(image);
		this.imageLifetime.value = raster;
		this.paintTextLayer(page, store);
		this.renderEraseTargets();
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
		this.pageInput.style.width = `${Math.max(2, String(page.pageCount).length)}ch`;
		this.pageCount.textContent = `/${page.pageCount}`;
		const progress = localize('sessions.pdfPreview.page', 'Page {0} of {1}', page.page, page.pageCount);
		if (this.progress.textContent !== progress) { this.progress.textContent = progress; }
		this.updateAnnotationPanel();
		this.updateZoom(); this.updateControls();
	}

	private paintTextLayer(page: PdfPage, store: DisposableStore): void {
		if (page.characters.length === 0) { return; }
		const document = this.stage.ownerDocument;
		const window = getWindow(this.stage);
		const text = h(document, 'div', { className: 'ash-sessions-pdf-text' });
		const selection = h(document, 'div', { className: 'ash-sessions-pdf-text-content' });
		selection.style.width = `${page.width}px`;
		selection.style.height = `${page.height}px`;
		text.append(selection);
		const pending = store.add(new MutableDisposable<IDisposable>());
		let index = 0;
		const build = (idle: IdleDeadline): void => {
			const stop = window.performance.now() + (idle.didTimeout ? 4 : Math.min(4, idle.timeRemaining()));
			do {
				const character = page.characters[index++];
				const span = document.createElement('span');
				span.textContent = character.text;
				this.position(span, character.bounds);
				span.style.fontSize = `${character.bounds.height * page.height}px`;
				selection.append(span);
			} while (index < page.characters.length && window.performance.now() < stop);
			if (index < page.characters.length) {
				pending.value = runWhenWindowIdle(window, build, 100);
				return;
			}
			pending.clear();
			// The selection layer stays in raster coordinates so zoom changes one transform.
			selection.style.transform = `scale(${parseFloat(this.stage.style.width) / page.width})`;
			this.selectionLayer = selection;
			this.stage.querySelector(':scope > img')?.after(text);
			this.updateControls();
		};
		// Give the decoded raster a frame before creating potentially thousands of text runs.
		pending.value = scheduleAtNextAnimationFrame(window, () => {
			pending.value = runWhenWindowIdle(window, build, 100);
		});
	}

	private selectTool(tool: PdfTool | undefined): void {
		this.cancelStroke();
		this.textLifetime.clear();
		this.tool = tool === this.tool ? undefined : tool;
		if (!this.stage) { return; }
		this.inkAction.checked = this.tool === 'ink';
		this.eraserAction.checked = this.tool === 'eraser';
		this.textAction.checked = this.tool === 'text';
		this.stage.classList.toggle('drawing', this.tool === 'ink');
		this.stage.classList.toggle('erasing', this.tool === 'eraser');
		this.stage.classList.toggle('adding-text', this.tool === 'text');
		this.renderEraseTargets();
		if (this.tool) { this.surface.focus(); }
	}

	private pagePoint(event: PointerEvent): PdfPoint {
		const rect = this.stage.getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !event.isPrimary || this.busy || this.isNavigating() || this.readonlyMode || !this.displayedPage || this.textLifetime.value) { return; }
		if (this.tool === 'text') {
			event.preventDefault();
			this.openTextBox(this.pagePoint(event));
		} else if (this.tool === 'ink') {
			event.preventDefault();
			this.surface.focus();
			this.startStroke(this.pagePoint(event));
			this.pointerId = event.pointerId;
			this.stage.setPointerCapture(event.pointerId);
		}
	}

	private handlePointerMove(event: PointerEvent): void {
		if (event.pointerId !== this.pointerId || !this.stroke) { return; }
		this.extendStroke(this.pagePoint(event));
	}

	private startStroke(point: PdfPoint): void {
		this.cancelStroke();
		this.stroke = [point];
		const svg = this.element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.classList.add('ash-sessions-pdf-stroke');
		svg.setAttribute('viewBox', '0 0 1 1');
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('aria-hidden', 'true');
		this.strokePreview = this.element.ownerDocument.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
		this.strokePreview.setAttribute('vector-effect', 'non-scaling-stroke');
		svg.append(this.strokePreview);
		this.stage.append(svg);
	}

	private extendStroke(point: PdfPoint): void {
		if (!this.stroke) { return; }
		// Bound one stroke to the native operation budget, retaining the final pointer position.
		if (this.stroke.length === 1024) { this.stroke[this.stroke.length - 1] = point; }
		else { this.stroke.push(point); }
		this.strokePreview?.setAttribute('points', this.stroke.map(point => `${point.x.toFixed(5)},${point.y.toFixed(5)}`).join(' '));
	}

	private async finishStroke(): Promise<void> {
		const points = this.stroke;
		this.cancelStroke();
		if (points && points.length > 1) { await this.edit({ kind: 'ink', points }); }
	}

	private cancelStroke(): void {
		if (this.pointerId !== undefined && this.stage.hasPointerCapture(this.pointerId)) { this.stage.releasePointerCapture(this.pointerId); }
		this.pointerId = undefined;
		this.stroke = undefined;
		this.strokePreview?.parentElement?.remove();
		this.strokePreview = undefined;
	}

	private handlePageKeydown(event: KeyboardEvent): void {
		if (event.target !== this.surface || this.busy || this.isNavigating() || this.readonlyMode) { return; }
		if (this.tool === 'text' && event.key === 'Enter') {
			event.preventDefault(); event.stopImmediatePropagation();
			this.openTextBox(this.keyboardPoint);
		} else if (this.tool === 'ink') {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault(); event.stopImmediatePropagation();
				if (this.stroke) { void this.perform(() => this.finishStroke()); }
				else { this.startStroke(this.keyboardPoint); }
			} else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
				event.preventDefault(); event.stopImmediatePropagation();
				const step = event.shiftKey ? 0.05 : 0.01;
				this.keyboardPoint = {
					x: Math.max(0, Math.min(1, this.keyboardPoint.x + (event.key === 'ArrowRight' ? step : 0) - (event.key === 'ArrowLeft' ? step : 0))),
					y: Math.max(0, Math.min(1, this.keyboardPoint.y + (event.key === 'ArrowDown' ? step : 0) - (event.key === 'ArrowUp' ? step : 0))),
				};
				this.extendStroke(this.keyboardPoint);
			}
		}
	}

	private renderEraseTargets(): void {
		this.eraseLifetime.clear();
		if (this.tool !== 'eraser' || this.readonlyMode) { return; }
		const store = new DisposableStore();
		this.eraseLifetime.value = store;
		for (const annotation of this.displayedPage?.annotations ?? []) {
			if (annotation.kind !== 'Highlight' && annotation.kind !== 'Ink') { continue; }
			const label = annotation.kind === 'Ink' ? localize('sessions.pdfPreview.eraseDrawing', 'Erase drawing') : localize('sessions.pdfPreview.eraseHighlight', 'Erase highlight');
			const target = h(this.element.ownerDocument, 'button', { className: 'ash-sessions-pdf-erase-target', properties: { type: 'button' }, attributes: { 'aria-label': label } });
			this.position(target, annotation.bounds);
			store.add(addDisposableListener(target, 'click', () => { void this.perform(() => this.edit({ kind: 'delete', index: annotation.index })); }));
			this.stage.append(target);
			store.add(toDisposable(() => target.remove()));
		}
	}

	private openTextBox(point: PdfPoint): void {
		this.textLifetime.clear();
		const store = new DisposableStore();
		this.textLifetime.value = store;
		const document = this.element.ownerDocument;
		const bounds = { x: Math.min(point.x, 0.65), y: Math.min(point.y, 0.84), width: 0.35, height: 0.16 };
		const editor = h(document, 'div', { className: 'ash-sessions-pdf-text-editor' });
		this.position(editor, bounds);
		const input = h(document, 'textarea', { properties: { maxLength: 8192, rows: 3 }, attributes: { 'aria-label': localize('sessions.pdfPreview.textBox', 'Text box') } });
		const actions = h(document, 'div', { className: 'ash-sessions-pdf-text-actions' });
		const cancel = () => { this.textLifetime.clear(); this.surface.focus(); };
		const apply = async () => {
			if (!input.value.trim()) { cancel(); return; }
			await this.edit({ kind: 'text', bounds, contents: input.value });
			cancel();
		};
		store.add(new Button(actions, { ...defaultButtonStyles, label: localize('sessions.pdfPreview.applyText', 'Apply text'), icon: Lxicon.check, iconOnly: true, onClick: () => { void this.perform(apply); } }));
		store.add(new Button(actions, { ...defaultButtonStyles, label: localize('sessions.pdfPreview.cancelText', 'Cancel text'), icon: Lxicon.close, iconOnly: true, onClick: cancel }));
		store.add(addDisposableListener(editor, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void this.perform(apply); }
		}));
		editor.append(input, actions);
		this.stage.append(editor);
		store.add(toDisposable(() => editor.remove()));
		input.focus();
	}

	private position(element: HTMLElement, bounds: PdfRect): void {
		element.style.left = `${bounds.x * 100}%`; element.style.top = `${bounds.y * 100}%`;
		element.style.width = `${bounds.width * 100}%`; element.style.height = `${bounds.height * 100}%`;
	}

	private updateAnnotationPanel(): void {
		const visible = !this.readonlyMode || !!this.displayedPage?.annotations.length;
		this.annotationPanel.hidden = !visible;
		this.element.classList.toggle('has-annotation-panel', visible);
		this.annotationScroll.layout();
	}

	private currentScale(): number {
		const page = this.displayedPage;
		return page ? this.stage.getBoundingClientRect().width / (page.widthPoints * 96 / 72) : 1;
	}

	private zoomBy(factor: number): void {
		this.flushWheelZoom();
		const current = this.currentScale();
		if (current <= 0) { return; }
		const scale = clamp(current * factor, 0.1, 8);
		// A fitted page can lie outside the manual range. Keep gesture direction consistent at that boundary.
		if (factor > 1 ? scale <= current : scale >= current) { return; }
		this.setZoom(scale);
	}

	private zoomAnchors(): { readonly x: ZoomAnchor; readonly y: ZoomAnchor; } {
		const viewport = this.pageScroll.scrollableElement;
		const style = getWindow(viewport).getComputedStyle(this.pageScroll.contentElement);
		const size = this.stage.getBoundingClientRect();
		return {
			x: new ZoomAnchor({ viewport: viewport.clientWidth, scroll: viewport.scrollLeft, size: size.width, insetStart: parseFloat(style.paddingLeft), insetEnd: parseFloat(style.paddingRight) }),
			y: new ZoomAnchor({ viewport: viewport.clientHeight, scroll: viewport.scrollTop, size: size.height, insetStart: parseFloat(style.paddingTop), insetEnd: parseFloat(style.paddingBottom) }),
		};
	}

	private queueWheelZoom(wheel: StandardWheelEvent): void {
		const page = this.displayedPage;
		if (!page) { return; }
		const current = this.wheelZoom?.scale ?? this.currentScale();
		if (current <= 0) { return; }
		const delta = clamp(wheel.deltaY, -240, 240);
		const scale = clamp(current * Math.exp(-delta * 0.002), 0.1, 8);
		if (delta < 0 ? scale <= current : scale >= current) { return; }
		const zoom = this.wheelZoom ??= { scale: current, ...this.zoomAnchors() };
		const viewport = this.pageScroll.scrollableElement.getBoundingClientRect();
		const width = page.widthPoints * 96 / 72 * scale;
		zoom.x.zoomAround(wheel.browserEvent.clientX - viewport.left, width);
		zoom.y.zoomAround(wheel.browserEvent.clientY - viewport.top, width * page.height / page.width);
		zoom.scale = scale;
		this.wheelZoomFrame.schedule();
		this.queueZoomRefinement();
	}

	private flushWheelZoom(): void {
		const zoom = this.wheelZoom;
		if (!zoom) { return; }
		this.cancelWheelZoom();
		const viewport = this.pageScroll.scrollableElement;
		const left = zoom.x.scrollPosition + viewport.scrollLeft - zoom.x.scroll;
		const top = zoom.y.scrollPosition + viewport.scrollTop - zoom.y.scroll;
		this.zoom = zoom.scale;
		this.updateZoom();
		this.pageScroll.scrollTo(left, top);
	}

	private cancelWheelZoom(): void {
		this.wheelZoomFrame?.cancel();
		this.wheelZoom = undefined;
	}

	private setZoom(zoom: PdfZoom): void {
		this.cancelWheelZoom();
		const page = this.displayedPage;
		if (!page || this.busy || this.stroke || this.currentScale() <= 0) { return; }
		const anchor = this.zoomAnchors();
		this.zoom = zoom;
		this.updateZoom();
		this.queueZoomRefinement();
		if (typeof zoom !== 'number') { this.pageScroll.scrollTo(0, 0); return; }
		const width = page.widthPoints * 96 / 72 * zoom;
		anchor.x.zoomAround(anchor.x.viewport / 2, width);
		anchor.y.zoomAround(anchor.y.viewport / 2, width * page.height / page.width);
		this.pageScroll.scrollTo(anchor.x.scrollPosition, anchor.y.scrollPosition);
	}

	private queueZoomRefinement(): void {
		if (this.pageRender?.refinement) {
			this.pageRender.controller.abort();
		}
		this.zoomRefinement.schedule();
	}

	private refineZoom(): void {
		if (!this.displayedPage || this.busy || this.stroke || this.isNavigating()) { return; }
		this.flushWheelZoom();
		const size = this.stage.getBoundingClientRect();
		const physicalEdge = Math.max(size.width, size.height) * getWindow(this.stage).devicePixelRatio;
		const dimension = Math.min(maximumRasterDimension, Math.ceil(physicalEdge / 256) * 256);
		if (dimension > this.renderedDimension) { void this.showPage(this.pageNumber, dimension, true); }
	}

	private updateZoom(): void {
		if (!this.pageScroll || !this.fitAction) { return; }
		const page = this.displayedPage;
		if (!page) { return; }
		const viewport = this.pageScroll.scrollableElement;
		const style = viewport.ownerDocument.defaultView!.getComputedStyle(this.pageScroll.contentElement);
		const width = Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
		const height = Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
		let pageWidth = width;
		if (typeof this.zoom === 'number') { pageWidth = page.widthPoints * 96 / 72 * this.zoom; }
		else if (this.zoom === 'page') { pageWidth = Math.min(width, height * page.width / page.height); }
		this.stage.style.width = `${pageWidth}px`;
		this.stage.style.height = `${pageWidth * page.height / page.width}px`;
		if (this.selectionLayer) { this.selectionLayer.style.transform = `scale(${pageWidth / page.width})`; }
		this.pageScroll.layout();
		this.fitAction.label = this.fitAction.tooltip = this.zoom === 'page' ? localize('sessions.pdfPreview.fitWidth', 'Fit width') : localize('sessions.pdfPreview.fitPage', 'Fit page');
		this.fitAction.icon = this.zoom === 'page' ? Lxicon.screenFull : Lxicon.screenNormal;
	}

	private updateControls(): void {
		if (!this.previous) { return; }
		const page = this.displayedPage;
		const navigating = this.isNavigating();
		this.previous.enabled = !this.busy && !!page && this.pageNumber > 1;
		this.next.enabled = !this.busy && !!page && this.pageNumber < page.pageCount;
		this.saveAction.enabled = !this.busy && !navigating && !this.readonlyMode && !!this.model?.isDirty;
		this.highlightAction.enabled = !this.busy && !navigating && !this.readonlyMode && !!this.selectionLayer;
		for (const action of [this.noteAction, this.inkAction, this.eraserAction, this.textAction]) {
			action.enabled = !this.busy && !navigating && !this.readonlyMode && !!page;
		}
		this.fitAction.enabled = !!page;
		this.pageInput.disabled = this.busy || !page;
		this.note.disabled = this.busy || this.readonlyMode;
		this.element.setAttribute('aria-busy', String(this.busy || navigating));
	}

	private showError(error: unknown): void {
		this.error.textContent = localize('sessions.pdfPreview.operationFailed', 'Could not complete the PDF operation: {0}', error instanceof Error ? error.message : String(error));
	}

	private accessibleContent(): string {
		const page = this.displayedPage;
		if (!page) { return this.progress.textContent ?? ''; }
		return [this.progress.textContent, page.text || localize('sessions.pdfPreview.noText', 'This page has no extractable text.'),
		...page.annotations.map(annotation => `${annotation.kind}: ${annotation.contents}`),
		page.textTruncated || page.annotationsTruncated ? localize('sessions.pdfPreview.truncated', 'Some page content exceeds the reading limit.') : ''].filter(Boolean).join('\n\n');
	}

	public override async save(): Promise<void> { await this.model?.save(new AbortController().signal); }
	public override clearInput(): void {
		this.cancelWheelZoom();
		this.zoomRefinement.cancel();
		this.pageRender?.controller.abort();
		this.pageTurnDelay.cancel();
		this.pageRender = undefined;
		this.pagePaint = undefined;
		this.displayedPage = undefined;
		this.renderedDimension = initialRasterDimension;
		this.textLifetime.clear(); this.cancelStroke(); this.selectTool(undefined);
		this.imageLifetime.clear(); this.pageLifetime.clear(); this.inputLifetime.clear(); this.model = undefined; this.pageNumber = 1;
		this.selectionLayer = undefined;
		this.stage?.replaceChildren(); this.annotations?.replaceChildren();
		this.pageScroll?.scrollTo(0, 0);
		if (this.progress) { this.progress.textContent = ''; this.error.textContent = ''; this.pageInput.value = '1'; this.pageCount.textContent = '/–'; this.note.value = ''; }
		this.updateControls();
	}
	public override focus(): void { this.surface.focus(); }
	public override layout(dimension: IDimension): void {
		this.flushWheelZoom();
		this.element.classList.toggle('narrow', dimension.width < 640);
		this.updateZoom();
		this.annotationScroll.layout();
	}
	public saveViewState(): unknown { return this.pageNumber; }
	public restoreViewState(state: unknown): void {
		if (typeof state === 'number' && Number.isSafeInteger(state) && state > 0) {
			this.savedPage = state;
			if (this.displayedPage && state !== this.pageNumber) { void this.showPage(state); }
		}
	}
}
