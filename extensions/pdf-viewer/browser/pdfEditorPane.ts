import { localize } from '../../../src/ash/nls.js';
import { defaultButtonStyles } from '../../../src/ash/platform/theme/browser/defaultStyles.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../src/ash/workbench/common/editor.js';
import { addDisposableListener, h, svg as createSvgElement } from "../../../src/ash/base/browser/dom.js";
import type { IDimension } from "../../../src/ash/base/browser/dom.js";
import type { IContextMenuProvider } from "../../../src/ash/base/browser/contextmenu.js";
import type { IAction } from "../../../src/ash/base/common/actions.js";
import { Separator } from "../../../src/ash/base/common/actions.js";
import { throwIfCancelled } from "../../../src/ash/base/common/cancellation.js";
import { DisposableStore, toDisposable } from "../../../src/ash/base/common/lifecycle.js";
import { Lxicon } from "../../../src/ash/base/common/lxicons.js";
import { clamp } from "../../../src/ash/base/common/numbers.js";
import { assertDefined } from "../../../src/ash/base/common/types.js";
import { Button } from '../../../src/ash/base/browser/ui/button/button.js';
import { PdfFindWidget } from './pdfFindWidget.js';
import { ToolBar } from "../../../src/ash/base/browser/ui/toolbar/toolbar.js";
import { EditorPaneMatch, EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import type { PdfAnnotationPoint, PdfAnnotationRect, PdfNoteAnnotation } from "../common/pdfAnnotations.js";
import { PdfAnnotationModel } from "./pdfAnnotationModel.js";
import type { IPdfAnnotationStore } from "./pdfAnnotationStore.js";
import type { IPdfDocumentLoader } from "./pdfDocumentLoader.js";
import type { IPdfRenderResult, IPdfRenderer, PdfRenderedPage } from "./pdfRenderer.js";
import { matchPdfEditor, PDF_EDITOR_ID } from "./pdfEditorInput.js";

const defaultAnnotationColor = "#f6c945";
const defaultNoteText = () => localize('pdf.viewer.newNote', "New note");

type PdfAnnotationMode = "select" | "highlight" | "ink" | "note";

interface ActiveHighlight {
	readonly kind: "highlight";
	readonly pointerId: number;
	readonly page: PdfRenderedPage;
	readonly start: PdfAnnotationPoint;
	readonly preview: HTMLDivElement;
}

interface ActiveInk {
	readonly kind: "ink";
	readonly pointerId: number;
	readonly page: PdfRenderedPage;
	readonly points: PdfAnnotationPoint[];
	readonly preview: SVGSVGElement;
}

type ActiveAnnotation = ActiveHighlight | ActiveInk;

/**
 * Workbench pane for reading PDF pages and maintaining application-owned review annotations.
 *
 * The PDF itself stays immutable. Annotations persist in a versioned companion file through
 * {@link IPdfAnnotationStore}, so document loading and review metadata remain independently owned.
 */
export class PdfEditorPane extends EditorPane implements IEditorPane {
	readonly id = PDF_EDITOR_ID;

	private readonly annotationModel = this._register(new PdfAnnotationModel());
	private readonly annotationInteractions = this._register(new DisposableStore());
	private readonly sidebarInteractions = this._register(new DisposableStore());
	private container: HTMLDivElement | undefined;
	private toolbar: ToolBar | undefined;
	private pages: HTMLDivElement | undefined;
	private findWidget: PdfFindWidget | undefined;
	private zoomSelect: HTMLSelectElement | undefined;
	private zoomOut: Button | undefined;
	private zoomIn: Button | undefined;
	private fitWidthButton: Button | undefined;
	private findButton: Button | undefined;
	private zoomLevel = 1.25;
	private zoomController: AbortController | undefined;
	private zoomOperation: Promise<void> = Promise.resolve();
	private sidebar: HTMLElement | undefined;
	private annotationList: HTMLDivElement | undefined;
	private annotationText: HTMLTextAreaElement | undefined;
	private annotationTextLabel: HTMLLabelElement | undefined;
	private colorInput: HTMLInputElement | undefined;
	private statusElement: HTMLDivElement | undefined;
	private renderResult: IPdfRenderResult | undefined;
	private input: IResourceEditorInput | undefined;
	private mode: PdfAnnotationMode = "select";
	private color = defaultAnnotationColor;
	private noteDraft = defaultNoteText();
	private selectedAnnotationId: string | undefined;
	private activeAnnotation: ActiveAnnotation | undefined;
	private inputController: AbortController | undefined;
	private providerSignal: AbortSignal | undefined;
	private saveOperation: Promise<void> | undefined;
	private statusMessage: string | undefined;

	constructor(
		private readonly documentLoader: IPdfDocumentLoader,
		private readonly annotationStore: IPdfAnnotationStore,
		private readonly renderer: IPdfRenderer,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(PDF_EDITOR_ID, themeService, storageService);
		this._register(this.annotationModel.onDidChange(() => this.onAnnotationsChanged()));
		this._register(toDisposable(() => {
			this.clearInput();
			this.container?.remove();
			this.container = undefined;
			this.toolbar = undefined;
			this.findWidget = undefined;
			this.zoomSelect = undefined;
			this.zoomOut = this.zoomIn = this.fitWidthButton = this.findButton = undefined;
			this.pages = undefined;
			this.sidebar = undefined;
			this.annotationList = undefined;
			this.annotationText = undefined;
			this.annotationTextLabel = undefined;
			this.colorInput = undefined;
			this.statusElement = undefined;
		}));
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("PDF editor pane has already been created");
		const ownerDocument = parent.ownerDocument;
		const container = h(ownerDocument, "div");
		container.className = "ash-pdf-editor";
		container.setAttribute("role", "region");
		container.setAttribute("aria-label", localize('pdf.viewer.reader', "PDF reader"));

		const readingTools = h(ownerDocument, 'div');
		readingTools.className = 'ash-pdf-reading-tools';
		readingTools.setAttribute('role', 'group');
		readingTools.setAttribute('aria-label', localize('pdf.viewer.readingTools', 'PDF reading tools'));
		this.zoomOut = this._register(new Button(readingTools, {
			...defaultButtonStyles, label: localize('pdf.viewer.zoomOut', 'Zoom out'), icon: Lxicon.remove,
			iconOnly: true, size: 'small', onClick: () => this.changeZoom(-0.25),
		}));
		const zoomSelect = this.zoomSelect = h(ownerDocument, 'select');
		zoomSelect.className = 'ash-pdf-zoom';
		zoomSelect.setAttribute('aria-label', localize('pdf.viewer.zoom', 'PDF zoom'));
		readingTools.append(zoomSelect);
		this.zoomIn = this._register(new Button(readingTools, {
			...defaultButtonStyles, label: localize('pdf.viewer.zoomIn', 'Zoom in'), icon: Lxicon.add,
			iconOnly: true, size: 'small', onClick: () => this.changeZoom(0.25),
		}));
		this.fitWidthButton = this._register(new Button(readingTools, {
			...defaultButtonStyles, label: localize('pdf.viewer.fitWidth', 'Fit width'), size: 'small',
			onClick: () => this.fitWidth(),
		}));
		this.findButton = this._register(new Button(readingTools, {
			...defaultButtonStyles, label: localize('pdf.viewer.find', 'Find in PDF'), icon: Lxicon.search,
			size: 'small', onClick: () => this.findWidget?.open(),
		}));
		container.append(readingTools);
		this.findWidget = this._register(new PdfFindWidget(container, () => this.focus()));
		this._register(addDisposableListener(zoomSelect, 'change', () => this.setZoom(Number(zoomSelect.value))));
		// The Workbench handles keys at document capture. A focus-scoped window listener lets
		// this resource pane consume its reading shortcuts before those global commands.
		this._register(addDisposableListener(ownerDocument.defaultView!, 'keydown', event => {
			if (container.contains(event.target as Node)) this.onReadingKeyDown(event);
		}, true));

		const toolbar = this._register(new ToolBar(container, {
			buttonStyles: defaultButtonStyles,
			ariaLabel: localize('pdf.viewer.actions', "PDF annotation actions"),
			contextMenuProvider: noSecondaryContextMenuProvider,
			highlightToggledItems: true,
		}));
		toolbar.element.classList.add("ash-pdf-editor-toolbar");

		const content = h(ownerDocument, "div");
		content.className = "ash-pdf-editor-content";
		const pages = h(ownerDocument, "div");
		pages.className = "ash-pdf-pages";
		pages.tabIndex = 0;
		pages.setAttribute("aria-label", localize('pdf.viewer.pages', "PDF pages"));
		const sidebar = h(ownerDocument, "aside");
		sidebar.className = "ash-pdf-annotation-sidebar";
		sidebar.setAttribute("aria-label", localize('pdf.viewer.annotationsAria', "PDF annotations"));

		const heading = h(ownerDocument, "h2");
		heading.className = "ash-pdf-annotation-heading";
		heading.textContent = localize('pdf.viewer.annotations', "Annotations");
		const colorLabel = h(ownerDocument, "label");
		colorLabel.className = "ash-pdf-annotation-field";
		colorLabel.textContent = localize('pdf.viewer.color', "Color");
		const colorInput = h(ownerDocument, "input");
		colorInput.className = "ash-pdf-annotation-color";
		colorInput.type = "color";
		colorInput.value = this.color;
		colorInput.setAttribute("aria-label", localize('pdf.viewer.annotationColor', "Annotation color"));
		colorLabel.append(colorInput);

		const annotationTextLabel = h(ownerDocument, "label");
		annotationTextLabel.className = "ash-pdf-annotation-field";
		annotationTextLabel.textContent = localize('pdf.viewer.newNote', "New note");
		const annotationText = h(ownerDocument, "textarea");
		annotationText.className = "ash-pdf-annotation-text";
		annotationText.rows = 4;
		annotationText.maxLength = 10_000;
		annotationText.value = this.noteDraft;
		annotationText.setAttribute("aria-label", localize('pdf.viewer.annotationNote', "Annotation note"));
		annotationTextLabel.append(annotationText);

		const annotationList = h(ownerDocument, "div");
		annotationList.className = "ash-pdf-annotation-list";
		annotationList.setAttribute("role", "listbox");
		annotationList.setAttribute("aria-label", localize('pdf.viewer.savedList', "Saved annotations"));
		const status = h(ownerDocument, "div");
		status.className = "ash-pdf-annotation-status";
		status.setAttribute("role", "status");
		sidebar.append(heading, colorLabel, annotationTextLabel, annotationList, status);
		content.append(pages, sidebar);
		container.append(toolbar.element, content);
		parent.append(container);
		super.create(container);

		this.container = container;
		this.toolbar = toolbar;
		this.pages = pages;
		this.sidebar = sidebar;
		this.annotationList = annotationList;
		this.annotationText = annotationText;
		this.annotationTextLabel = annotationTextLabel;
		this.colorInput = colorInput;
		this.statusElement = status;
		this._register(addDisposableListener(colorInput, "input", () => {
			this.color = colorInput.value.toLowerCase();
		}));
		this._register(addDisposableListener(annotationText, "input", () => {
			this.noteDraft = annotationText.value;
		}));
		this._register(addDisposableListener(annotationText, "change", () => this.commitSelectedNote()));
		this.renderToolbar();
		this.renderSidebar();
		this.updateStyles();
	}

	public override updateStyles(): void {
		// Package styles cannot select Workbench ancestors outside their isolated scope.
		this.container?.classList.toggle('high-contrast', this.theme.colorScheme === 'hcDark' || this.theme.colorScheme === 'hcLight');
	}

	/** Retirement freezes an existing view and its draft; a replacement provider opens a new pane. */
	bindProvider(signal: AbortSignal): void {
		if (this.providerSignal) throw new ReferenceError('PDF provider is already bound');
		this.providerSignal = signal;
		const retire = () => {
			this.inputController?.abort();
			this.activeAnnotation?.preview.remove();
			this.activeAnnotation = undefined;
			this.zoomController?.abort();
			this.container?.removeAttribute('aria-busy');
			this.renderResult?.freeze?.();
			this.updateReadingTools();
			this.statusMessage = undefined;
			this.renderToolbar();
			this.renderSidebar();
		};
		this._register(addDisposableListener(signal, 'abort', retire, { once: true }));
		if (signal.aborted) retire();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (matchPdfEditor(input) === EditorPaneMatch.None) {
			throw new RangeError(`PDF editor cannot open ${input.resource}`);
		}
		const pages = this.requirePages();
		this.clearInput();
		const controller = new AbortController();
		this.inputController = controller;
		signal = AbortSignal.any([signal, controller.signal, ...(this.providerSignal ? [this.providerSignal] : [])]);
		throwIfCancelled(signal, "PDF document loading was cancelled");
		this.input = input;
		this.statusMessage = localize('pdf.viewer.loading', "Loading PDF and annotations…");
		this.renderToolbar();
		this.renderSidebar();
		try {
			const [bytes, snapshot] = await Promise.all([
				this.documentLoader.load(input, signal),
				input.readOnly ? Promise.resolve({ document: { version: 1 as const, annotations: [] }, revision: undefined }) : this.annotationStore.load(input.resource, signal),
			]);
			throwIfCancelled(signal, "PDF document loading was cancelled");
			const renderResult = await this.renderer.render({ bytes, container: pages, scale: this.zoomLevel, signal });
			if (signal.aborted) {
				renderResult.dispose();
				throwIfCancelled(signal, "PDF document loading was cancelled");
			}
			this.renderResult = renderResult;
			this.findWidget?.setPages(renderResult.pages);
			this.updateReadingTools();
			this.annotationModel.restore(snapshot);
			this.statusMessage = undefined;
			this.renderAnnotations();
			this.renderToolbar();
			this.renderSidebar();
		} catch (error) {
			if (this.inputController === controller) this.clearInput();
			throw error;
		}
	}

	public override clearInput(): void {
		this.inputController?.abort();
		this.inputController = undefined;
		this.zoomController?.abort();
		this.zoomController = undefined;
		this.container?.removeAttribute('aria-busy');
		this.findWidget?.setPages([]);
		this.activeAnnotation?.preview.remove();
		this.activeAnnotation = undefined;
		this.annotationInteractions.clear();
		this.sidebarInteractions.clear();
		this.renderResult?.dispose();
		this.renderResult = undefined;
		this.updateReadingTools();
		this.pages?.replaceChildren();
		this.input = undefined;
		this.selectedAnnotationId = undefined;
		this.statusMessage = undefined;
		this.annotationModel.restore({ document: { version: 1, annotations: [] }, revision: undefined });
		this.renderToolbar();
		this.renderSidebar();
	}

	public override layout(_dimension: IDimension): void { }

	public override focus(): void {
		this.requirePages().focus();
	}

	async save(): Promise<void> {
		if (!this.canAnnotate() || !this.input || !this.annotationModel.isDirty) return;
		if (this.saveOperation) return this.saveOperation;
		const input = this.input;
		this.statusMessage = localize('pdf.viewer.saving', "Saving annotations…");
		this.renderToolbar();
		this.renderSidebar();
		this.saveOperation = this.persistAnnotations(input).finally(() => {
			this.saveOperation = undefined;
			this.renderToolbar();
			this.renderSidebar();
		});
		return this.saveOperation;
	}

	private async persistAnnotations(input: IResourceEditorInput): Promise<void> {
		try {
			const signal = AbortSignal.any([this.inputController!.signal, ...(this.providerSignal ? [this.providerSignal] : [])]);
			throwIfCancelled(signal, "PDF document loading was cancelled");
			const snapshot = await this.annotationStore.save(input.resource, this.annotationModel.snapshot, this.annotationModel.revision, signal);
			throwIfCancelled(signal, "PDF document loading was cancelled");
			if (this.input !== input) return;
			this.annotationModel.markSaved(snapshot);
			this.statusMessage = localize('pdf.viewer.saved', "Annotations saved");
		} catch (error) {
			if (this.input !== input || this.providerSignal?.aborted) throw error;
			this.statusMessage = error instanceof Error ? localize('pdf.viewer.saveError', 'Could not save annotations: {0}', error.message) : localize('pdf.viewer.saveFailed', "Could not save annotations");
			throw error;
		}
	}

	private onAnnotationsChanged(): void {
		this.statusMessage = undefined;
		this.renderAnnotations();
		this.renderToolbar();
		this.renderSidebar();
	}

	private renderToolbar(): void {
		const available = this.canAnnotate();
		this.toolbar?.setActions([
			action("ash.pdf.annotations.select", localize('pdf.viewer.select', "Select"), localize('pdf.viewer.selectHint', "Select text or annotations"), Lxicon.check, available, this.mode === "select", () => this.setMode("select")),
			action("ash.pdf.annotations.highlight", localize('pdf.viewer.highlight', "Highlight"), localize('pdf.viewer.highlightHint', "Draw a highlight"), Lxicon.bold, available, this.mode === "highlight", () => this.setMode("highlight")),
			action("ash.pdf.annotations.ink", localize('pdf.viewer.draw', "Draw"), localize('pdf.viewer.drawHint', "Draw freehand ink"), Lxicon.italics, available, this.mode === "ink", () => this.setMode("ink")),
			action("ash.pdf.annotations.note", localize('pdf.viewer.note', "Note"), localize('pdf.viewer.noteHint', "Place a note"), Lxicon.chat4, available, this.mode === "note", () => this.setMode("note")),
			new Separator(),
			action("ash.pdf.annotations.undo", localize('pdf.viewer.undo', "Undo"), localize('pdf.viewer.undoHint', "Undo annotation change"), Lxicon.history, available && this.annotationModel.canUndo, false, () => { if (this.canAnnotate()) this.annotationModel.undo(); }),
			action("ash.pdf.annotations.redo", localize('pdf.viewer.redo', "Redo"), localize('pdf.viewer.redoHint', "Redo annotation change"), Lxicon.history, available && this.annotationModel.canRedo, false, () => { if (this.canAnnotate()) this.annotationModel.redo(); }),
			action("ash.pdf.annotations.delete", localize('pdf.viewer.delete', "Delete"), localize('pdf.viewer.deleteHint', "Delete selected annotation"), Lxicon.trash, available && this.selectedAnnotationId !== undefined, false, () => this.deleteSelectedAnnotation()),
			new Separator(),
			action("ash.pdf.annotations.save", localize('pdf.viewer.save', "Save"), localize('pdf.viewer.saveHint', "Save annotations"), Lxicon.check, available && this.annotationModel.isDirty && !this.saveOperation, false, () => this.save().catch(() => undefined)),
		]);
	}

	private renderSidebar(): void {
		const annotationList = this.annotationList;
		const annotationText = this.annotationText;
		const annotationTextLabel = this.annotationTextLabel;
		const status = this.statusElement;
		if (!annotationList || !annotationText || !annotationTextLabel || !status) return;
		const selectedNote = this.selectedAnnotation();
		annotationTextLabel.firstChild!.textContent = selectedNote ? localize('pdf.viewer.selectedNote', "Selected note") : localize('pdf.viewer.newNote', "New note");
		annotationText.disabled = !this.canAnnotate();
		if (this.colorInput) this.colorInput.disabled = !this.canAnnotate();
		if (annotationText.ownerDocument.activeElement !== annotationText) {
			annotationText.value = selectedNote?.text ?? this.noteDraft;
		}
		this.sidebarInteractions.clear();
		annotationList.replaceChildren(...this.annotationModel.annotations.map((annotation, index) => {
			const item = h(annotationList.ownerDocument, "button");
			item.className = "ash-pdf-annotation-list-item";
			item.type = "button";
			item.setAttribute("role", "option");
			item.classList.toggle("selected", annotation.id === this.selectedAnnotationId);
			item.setAttribute("aria-selected", String(annotation.id === this.selectedAnnotationId));
			item.textContent = annotation.kind === "note" ? localize('pdf.viewer.noteItem', 'Note {0}: {1}', index + 1, annotation.text || localize('pdf.viewer.empty', '(empty)')) : localize('pdf.viewer.markItem', '{0} {1} · page {2}', annotation.kind === 'highlight' ? localize('pdf.viewer.highlight', 'Highlight') : localize('pdf.viewer.ink', 'Ink'), index + 1, annotation.page);
			this.sidebarInteractions.add(addDisposableListener(item, "click", () => this.selectAnnotation(annotation.id)));
			this.sidebarInteractions.add(addDisposableListener(item, 'keydown', event => {
				const target = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? this.annotationModel.annotations.length - 1 : -1;
				if (target < 0 || target >= this.annotationModel.annotations.length) return;
				event.preventDefault();
				this.selectAnnotation(this.annotationModel.annotations[target].id);
				annotationList.querySelectorAll<HTMLElement>('button')[target]?.focus();
			}));
			return item;
		}));
		status.textContent = this.statusMessage ?? this.annotationStatus();
	}

	private renderAnnotations(): void {
		this.annotationInteractions.clear();
		const renderResult = this.renderResult;
		if (!renderResult) return;
		for (const page of renderResult.pages) {
			page.element.querySelector(".ash-pdf-annotation-layer")?.remove();
			const layer = h(page.element.ownerDocument, "div");
			layer.className = "ash-pdf-annotation-layer";
			layer.dataset.annotationMode = this.canAnnotate() ? this.mode : "select";
			layer.tabIndex = 0;
			layer.setAttribute('role', 'group');
			layer.setAttribute('aria-label', localize('pdf.viewer.page', 'Page {0} annotations', page.pageNumber));
			const cursorElement = h(layer.ownerDocument, 'span');
			cursorElement.className = 'ash-pdf-annotation-cursor';
			cursorElement.setAttribute('aria-hidden', 'true');
			layer.append(cursorElement);
			let cursor = { x: 0.5, y: 0.5 };
			const pointer = () => {
				const bounds = layer.getBoundingClientRect();
				return new PointerEvent('pointermove', { pointerId: -1, button: 0, clientX: bounds.left + cursor.x * bounds.width, clientY: bounds.top + cursor.y * bounds.height });
			};
			this.annotationInteractions.add(addDisposableListener(layer, 'keydown', event => {
				if (event.target !== layer || !this.canAnnotate()) return;
				if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
					cursor = { x: clamp(cursor.x + (event.key === 'ArrowRight' ? 0.02 : event.key === 'ArrowLeft' ? -0.02 : 0), 0, 1), y: clamp(cursor.y + (event.key === 'ArrowDown' ? 0.02 : event.key === 'ArrowUp' ? -0.02 : 0), 0, 1) };
					cursorElement.style.left = `${cursor.x * 100}%`;
					cursorElement.style.top = `${cursor.y * 100}%`;
					this.updateAnnotation(pointer());
				} else if (event.key === 'Enter' || event.key === 'Escape') {
					if (this.activeAnnotation?.pointerId === -1) this.finishAnnotation(pointer(), event.key === 'Enter');
					else if (event.key === 'Enter') this.beginAnnotation(page, layer, pointer());
					page.element.querySelector<HTMLElement>('.ash-pdf-annotation-layer')?.focus();
				} else return;
				event.preventDefault();
			}));
			for (const annotation of this.annotationModel.annotations) {
				if (annotation.page !== page.pageNumber) continue;
				if (annotation.kind === "highlight") {
					const element = h(page.element.ownerDocument, "div");
					element.className = "ash-pdf-annotation-highlight";
					element.classList.toggle("selected", annotation.id === this.selectedAnnotationId);
					positionRect(element, annotation.rect);
					element.style.backgroundColor = withAlpha(annotation.color, 0.38);
					layer.append(element);
				} else if (annotation.kind === "ink") {
					const element = createInk(page.element.ownerDocument, annotation.points, annotation.color, annotation.id === this.selectedAnnotationId);
					layer.append(element);
				} else {
					const marker = h(page.element.ownerDocument, "button");
					marker.className = "ash-pdf-annotation-note";
					marker.type = "button";
					marker.title = annotation.text || localize('pdf.viewer.note', "Note");
					marker.setAttribute("aria-label", localize('pdf.viewer.noteAccessible', 'Note: {0}', annotation.text || localize('pdf.viewer.empty', '(empty)')));
					marker.classList.toggle("selected", annotation.id === this.selectedAnnotationId);
					marker.style.left = `${annotation.point.x * 100}%`;
					marker.style.top = `${annotation.point.y * 100}%`;
					marker.style.backgroundColor = annotation.color;
					this.annotationInteractions.add(addDisposableListener(marker, "click", (event) => {
						event.stopPropagation();
						this.selectAnnotation(annotation.id);
					}));
					layer.append(marker);
				}
			}
			this.annotationInteractions.add(addDisposableListener(layer, "pointerdown", (event: PointerEvent) => this.beginAnnotation(page, layer, event)));
			this.annotationInteractions.add(addDisposableListener(layer, "pointermove", (event: PointerEvent) => this.updateAnnotation(event)));
			this.annotationInteractions.add(addDisposableListener(layer, "pointerup", (event: PointerEvent) => this.finishAnnotation(event, true)));
			this.annotationInteractions.add(addDisposableListener(layer, "pointercancel", (event: PointerEvent) => this.finishAnnotation(event, false)));
			page.element.append(layer);
		}
	}

	private beginAnnotation(page: PdfRenderedPage, layer: HTMLDivElement, event: PointerEvent): void {
		if (!this.canAnnotate() || event.button !== 0 || this.activeAnnotation || this.mode === "select") return;
		const point = annotationPoint(layer, event);
		if (this.mode === "note") {
			const note = this.annotationModel.addNote(page.pageNumber, point, this.noteDraft || defaultNoteText(), this.color);
			this.selectedAnnotationId = note.id;
			this.renderAnnotations();
			this.renderToolbar();
			this.renderSidebar();
			return;
		}
		if (this.mode === "highlight") {
			const preview = h(layer.ownerDocument, "div");
			preview.className = "ash-pdf-annotation-highlight ash-pdf-annotation-preview";
			preview.style.backgroundColor = withAlpha(this.color, 0.38);
			positionRect(preview, { ...point, width: 0.001, height: 0.001 });
			layer.append(preview);
			this.activeAnnotation = { kind: "highlight", pointerId: event.pointerId, page, start: point, preview };
		} else {
			const preview = createInk(layer.ownerDocument, [point, point], this.color, false);
			preview.classList.add("ash-pdf-annotation-preview");
			layer.append(preview);
			this.activeAnnotation = { kind: "ink", pointerId: event.pointerId, page, points: [point], preview };
		}
		if (event.pointerId >= 0) layer.setPointerCapture?.(event.pointerId);
		event.preventDefault();
	}

	private updateAnnotation(event: PointerEvent): void {
		const active = this.activeAnnotation;
		if (!active || active.pointerId !== event.pointerId) return;
		const layer = active.preview.parentElement;
		if (!isAnnotationLayer(layer)) return;
		const point = annotationPoint(layer, event);
		if (active.kind === "highlight") {
			positionRect(active.preview, annotationRect(active.start, point));
		} else if (!samePoint(active.points.at(-1), point)) {
			active.points.push(point);
			updateInk(active.preview, active.points);
		}
		event.preventDefault();
	}

	private finishAnnotation(event: PointerEvent, commit: boolean): void {
		const active = this.activeAnnotation;
		if (!active || active.pointerId !== event.pointerId) return;
		this.activeAnnotation = undefined;
		const layer = active.preview.parentElement;
		if (isAnnotationLayer(layer) && commit) {
			const point = annotationPoint(layer, event);
			if (active.kind === "highlight") {
				const rect = annotationRect(active.start, point);
				if (rect.width >= 0.003 && rect.height >= 0.003) {
					const annotation = this.annotationModel.addHighlight(active.page.pageNumber, rect, this.color);
					this.selectedAnnotationId = annotation.id;
				}
			} else {
				if (!samePoint(active.points.at(-1), point)) active.points.push(point);
				if (active.points.length >= 2) {
					const annotation = this.annotationModel.addInk(active.page.pageNumber, active.points, this.color);
					this.selectedAnnotationId = annotation.id;
				}
			}
		}
		active.preview.remove();
		if (isAnnotationLayer(layer) && event.pointerId >= 0) layer.releasePointerCapture?.(event.pointerId);
		this.renderAnnotations();
		this.renderToolbar();
		this.renderSidebar();
	}

	private setMode(mode: PdfAnnotationMode): void {
		if (!this.canAnnotate()) return;
		this.mode = mode;
		this.renderAnnotations();
		this.renderToolbar();
	}

	private selectAnnotation(id: string): void {
		if (!this.annotationModel.annotations.some((annotation) => annotation.id === id)) return;
		this.selectedAnnotationId = id;
		this.renderAnnotations();
		this.renderToolbar();
		this.renderSidebar();
	}

	private deleteSelectedAnnotation(): void {
		if (!this.canAnnotate()) return;
		const id = this.selectedAnnotationId;
		if (!id) return;
		this.selectedAnnotationId = undefined;
		this.annotationModel.remove(id);
	}

	private commitSelectedNote(): void {
		if (!this.canAnnotate()) return;
		const selected = this.selectedAnnotation();
		const annotationText = this.annotationText;
		if (!selected || !annotationText) return;
		this.annotationModel.updateNote(selected.id, annotationText.value);
	}

	private selectedAnnotation(): PdfNoteAnnotation | undefined {
		const annotation = this.annotationModel.annotations.find((candidate) => candidate.id === this.selectedAnnotationId);
		return annotation?.kind === "note" ? annotation : undefined;
	}

	private annotationStatus(): string {
		if (this.providerSignal?.aborted) return localize('pdf.viewer.retired', 'PDF Viewer is unavailable. This view and its unsaved annotations are preserved. Re-enable the extension and reopen the file.');
		if (!this.input) return localize('pdf.viewer.none', "No PDF selected");
		if (this.annotationModel.isDirty) return localize('pdf.viewer.unsaved', "Unsaved annotations");
		const count = this.annotationModel.annotations.length;
		return localize('pdf.viewer.count', '{0} annotations saved', count);
	}

	getAccessibleContent(): string {
		return [this.renderResult?.text || localize('pdf.viewer.noText', 'This PDF has no extractable text.'), this.annotationList?.textContent ?? '', this.annotationStatus()].join('\n\n');
	}

	getAccessibilityHelp(): string {
		return localize('pdf.viewer.help', 'PDF Viewer keeps the original PDF unchanged. Use the zoom controls or Ctrl/Cmd plus +, - or 0 to zoom in, out or reset to 100%; Fit width fits pages to the reading area. In Select mode, drag over text to select it and use Ctrl/Cmd+C to copy; Ctrl/Cmd+A in the pages selects all text. Ctrl/Cmd+F opens PDF search. Search ignores case; Enter and Shift+Enter move between matches, and Escape closes search and returns to the pages. Tab moves between tools, page annotation surfaces, and annotation controls. Select a tool, focus a page, and use arrow keys to position the annotation cursor. Enter places a note, or starts and finishes a highlight or ink stroke; Escape cancels it. The annotation list supports arrow keys, Home and End. Select a note to edit its text, then leave the field to apply it. Undo, Redo, Delete and Save are toolbar actions. Save writes a companion annotations file. Open Accessible View reads extracted PDF text and annotations. Scanned pages without text need a separate OCR capability. Disabling the extension freezes this view; save annotations before disabling or closing it.');
	}

	private updateReadingTools(): void {
		const enabled = !!this.renderResult && !this.providerSignal?.aborted;
		if (this.zoomSelect) {
			const values = [...new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, this.zoomLevel])].sort((a, b) => a - b);
			this.zoomSelect.replaceChildren(...values.map(value => {
				const option = h(this.zoomSelect!.ownerDocument, 'option');
				option.value = String(value);
				option.textContent = `${Math.round(value * 100)}%`;
				option.selected = value === this.zoomLevel;
				return option;
			}));
			this.zoomSelect.disabled = !enabled;
		}
		if (this.zoomOut) this.zoomOut.enabled = enabled && this.zoomLevel > 0.25;
		if (this.zoomIn) this.zoomIn.enabled = enabled && this.zoomLevel < 4;
		if (this.fitWidthButton) this.fitWidthButton.enabled = enabled;
		if (this.findButton) this.findButton.enabled = enabled;
		this.findWidget?.setEnabled(enabled);
		this.container?.classList.toggle('retired', !!this.providerSignal?.aborted);
	}

	private changeZoom(delta: number): void {
		this.setZoom(this.zoomLevel + delta);
	}

	private fitWidth(): void {
		const result = this.renderResult;
		const pages = this.pages;
		if (!result?.pages.length || !pages) return;
		const style = pages.ownerDocument.defaultView!.getComputedStyle(pages);
		const available = pages.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
		const widest = Math.max(...result.pages.map(page => page.width / result.scale));
		this.setZoom(Math.floor(available / widest * 100) / 100);
	}

	private setZoom(scale: number): void {
		const result = this.renderResult;
		const pages = this.pages;
		if (!result || !pages || this.providerSignal?.aborted || !Number.isFinite(scale)) return;
		scale = Math.round(clamp(scale, 0.25, 4) * 100) / 100;
		if (scale === this.zoomLevel) return;
		this.zoomLevel = scale;
		this.zoomController?.abort();
		const controller = this.zoomController = new AbortController();
		const signal = AbortSignal.any([controller.signal, this.inputController!.signal]);
		this.updateReadingTools();
		// Serialize canvas work, cancelling superseded paints without replacing pages or annotation history.
		this.zoomOperation = this.zoomOperation.then(async () => {
			if (signal.aborted || this.renderResult !== result) return;
			const viewport = pages.getBoundingClientRect();
			const centerY = viewport.top + pages.clientHeight / 2;
			const anchor = result.pages.find(page => page.element.getBoundingClientRect().bottom > centerY) ?? result.pages.at(-1);
			const before = anchor?.element.getBoundingClientRect();
			const point = before ? { x: (viewport.left + pages.clientWidth / 2 - before.left) / before.width, y: (centerY - before.top) / before.height } : undefined;
			this.activeAnnotation?.preview.remove();
			this.activeAnnotation = undefined;
			this.container?.setAttribute('aria-busy', 'true');
			try {
				const painting = result.setScale(scale, signal);
				// Geometry changes synchronously; preserve the same point in the reading viewport.
				if (anchor && point) {
					const after = anchor.element.getBoundingClientRect();
					pages.scrollTop += after.top + point.y * after.height - centerY;
					pages.scrollLeft += after.left + point.x * after.width - viewport.left - pages.clientWidth / 2;
				}
				await painting;
				this.findWidget?.layout();
			} catch (error) {
				if (!signal.aborted) {
					this.statusMessage = localize('pdf.viewer.zoomFailed', 'Could not redraw PDF: {0}', error instanceof Error ? error.message : String(error));
					this.renderSidebar();
				}
			} finally {
				if (this.zoomController === controller) this.container?.removeAttribute('aria-busy');
			}
		});
	}

	private onReadingKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || !this.renderResult || this.providerSignal?.aborted || !(event.ctrlKey || event.metaKey) || event.altKey) return;
		const key = event.key.toLowerCase();
		const target = event.target as HTMLElement;
		if (key === 'f') this.findWidget?.open();
		else if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
		else if (key === '+' || key === '=') this.changeZoom(0.25);
		else if (key === '-') this.changeZoom(-0.25);
		else if (key === '0') this.setZoom(1);
		else if (key === 'a' && this.mode === 'select' && this.pages?.contains(target)) {
			const text = this.renderResult.pages.flatMap(page => page.textRuns).filter(run => run.end > run.start);
			if (!text.length) return;
			const range = target.ownerDocument.createRange();
			range.setStartBefore(text[0].element);
			range.setEndAfter(text.at(-1)!.element);
			const selection = target.ownerDocument.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		} else return;
		event.preventDefault();
		event.stopPropagation();
	}

	private canAnnotate(): boolean {
		return this.input !== undefined && !this.input.readOnly && !this.providerSignal?.aborted;
	}

	private requirePages(): HTMLDivElement {
		const pages = this.pages;
		assertDefined(pages, new ReferenceError("PDF editor pane has not been created"));
		return pages;
	}
}

const noSecondaryContextMenuProvider: IContextMenuProvider = {
	showContextMenu(): never {
		throw new Error("PDF annotation toolbar has no secondary actions");
	},
};

function action(id: string, label: string, tooltip: string, icon: IAction["icon"], enabled: boolean, checked: boolean, run: () => unknown): IAction {
	return { id, label, tooltip, icon, enabled, checked, run };
}

function annotationPoint(layer: HTMLElement, event: PointerEvent): PdfAnnotationPoint {
	const bounds = layer.getBoundingClientRect();
	return {
		x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
		y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
	};
}

function annotationRect(start: PdfAnnotationPoint, end: PdfAnnotationPoint): PdfAnnotationRect {
	return {
		x: Math.min(start.x, end.x),
		y: Math.min(start.y, end.y),
		width: Math.abs(end.x - start.x),
		height: Math.abs(end.y - start.y),
	};
}

function positionRect(element: HTMLElement, rect: PdfAnnotationRect): void {
	element.style.left = `${rect.x * 100}%`;
	element.style.top = `${rect.y * 100}%`;
	element.style.width = `${rect.width * 100}%`;
	element.style.height = `${rect.height * 100}%`;
}

function createInk(ownerDocument: Document, points: readonly PdfAnnotationPoint[], color: string, selected: boolean): SVGSVGElement {
	const ink = createSvgElement(ownerDocument, "svg");
	ink.classList.add("ash-pdf-annotation-ink");
	ink.classList.toggle("selected", selected);
	ink.setAttribute("viewBox", "0 0 1 1");
	ink.setAttribute("preserveAspectRatio", "none");
	const path = createSvgElement(ownerDocument, "polyline");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", color);
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	path.setAttribute("stroke-width", "0.006");
	ink.append(path);
	updateInk(ink, points);
	return ink;
}

function updateInk(ink: SVGSVGElement, points: readonly PdfAnnotationPoint[]): void {
	ink.querySelector("polyline")?.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
}

function withAlpha(color: string, opacity: number): string {
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	return `rgb(${red} ${green} ${blue} / ${opacity})`;
}

function samePoint(left: PdfAnnotationPoint | undefined, right: PdfAnnotationPoint): boolean {
	return left?.x === right.x && left.y === right.y;
}

function isAnnotationLayer(value: Element | null): value is HTMLDivElement {
	return value?.classList.contains("ash-pdf-annotation-layer") === true;
}
