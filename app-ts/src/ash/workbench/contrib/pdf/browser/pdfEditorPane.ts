import { addDisposableListener, h, svg as createSvgElement } from "../../../../base/browser/dom.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { IAction } from "../../../../base/common/actions.js";
import { Separator } from "../../../../base/common/actions.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { clamp } from "../../../../base/common/numbers.js";
import { assertDefined } from "../../../../base/common/types.js";
import { ToolBar } from "../../../../base/browser/ui/toolbar/toolbar.js";
import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { EditorPaneMatch, EditorPaneVisibility, type IEditorPane } from "../../../browser/parts/editor/editorPane.js";
import type { PdfAnnotationPoint, PdfAnnotationRect, PdfNoteAnnotation } from "../common/pdfAnnotations.js";
import { PdfAnnotationModel } from "./pdfAnnotationModel.js";
import type { IPdfAnnotationStore } from "./pdfAnnotationStore.js";
import type { IPdfDocumentLoader } from "./pdfDocumentLoader.js";
import type { IPdfRenderResult, IPdfRenderer, PdfRenderedPage } from "./pdfRenderer.js";
import { matchPdfEditor, PDF_EDITOR_ID } from "./pdfEditorInput.js";

const defaultAnnotationColor = "#f6c945";
const defaultNoteText = "New note";

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
export class PdfEditorPane extends Disposable implements IEditorPane {
	readonly id = PDF_EDITOR_ID;

	private readonly annotationModel = this._register(new PdfAnnotationModel());
	private readonly annotationInteractions = this._register(new DisposableStore());
	private readonly sidebarInteractions = this._register(new DisposableStore());
	private container: HTMLDivElement | undefined;
	private toolbar: ToolBar | undefined;
	private pages: HTMLDivElement | undefined;
	private sidebar: HTMLElement | undefined;
	private annotationList: HTMLDivElement | undefined;
	private annotationText: HTMLTextAreaElement | undefined;
	private annotationTextLabel: HTMLLabelElement | undefined;
	private colorInput: HTMLInputElement | undefined;
	private statusElement: HTMLDivElement | undefined;
	private renderResult: IPdfRenderResult | undefined;
	private input: EditorInput | undefined;
	private mode: PdfAnnotationMode = "select";
	private color = defaultAnnotationColor;
	private noteDraft = defaultNoteText;
	private selectedAnnotationId: string | undefined;
	private activeAnnotation: ActiveAnnotation | undefined;
	private saveOperation: Promise<void> | undefined;
	private statusMessage: string | undefined;

	constructor(
		private readonly documentLoader: IPdfDocumentLoader,
		private readonly annotationStore: IPdfAnnotationStore,
		private readonly renderer: IPdfRenderer,
	) {
		super();
		this._register(this.annotationModel.onDidChange(() => this.onAnnotationsChanged()));
		this._register(toDisposable(() => {
			this.clearInput();
			this.container?.remove();
			this.container = undefined;
			this.toolbar = undefined;
			this.pages = undefined;
			this.sidebar = undefined;
			this.annotationList = undefined;
			this.annotationText = undefined;
			this.annotationTextLabel = undefined;
			this.colorInput = undefined;
			this.statusElement = undefined;
		}));
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("PDF editor pane has already been created");
		const ownerDocument = parent.ownerDocument;
		const container = h(ownerDocument, "div");
		container.className = "ash-pdf-editor";
		container.setAttribute("role", "region");
		container.setAttribute("aria-label", "PDF reader");

		const toolbar = this._register(new ToolBar(container, {
			ariaLabel: "PDF annotation actions",
			contextMenuProvider: noSecondaryContextMenuProvider,
			highlightToggledItems: true,
		}));
		toolbar.element.classList.add("ash-pdf-editor-toolbar");

		const content = h(ownerDocument, "div");
		content.className = "ash-pdf-editor-content";
		const pages = h(ownerDocument, "div");
		pages.className = "ash-pdf-pages";
		pages.tabIndex = 0;
		pages.setAttribute("aria-label", "PDF pages");
		const sidebar = h(ownerDocument, "aside");
		sidebar.className = "ash-pdf-annotation-sidebar";
		sidebar.setAttribute("aria-label", "PDF annotations");

		const heading = h(ownerDocument, "h2");
		heading.className = "ash-pdf-annotation-heading";
		heading.textContent = "Annotations";
		const colorLabel = h(ownerDocument, "label");
		colorLabel.className = "ash-pdf-annotation-field";
		colorLabel.textContent = "Color";
		const colorInput = h(ownerDocument, "input");
		colorInput.className = "ash-pdf-annotation-color";
		colorInput.type = "color";
		colorInput.value = this.color;
		colorInput.setAttribute("aria-label", "Annotation color");
		colorLabel.append(colorInput);

		const annotationTextLabel = h(ownerDocument, "label");
		annotationTextLabel.className = "ash-pdf-annotation-field";
		annotationTextLabel.textContent = "New note";
		const annotationText = h(ownerDocument, "textarea");
		annotationText.className = "ash-pdf-annotation-text";
		annotationText.rows = 4;
		annotationText.maxLength = 10_000;
		annotationText.value = this.noteDraft;
		annotationText.setAttribute("aria-label", "Annotation note");
		annotationTextLabel.append(annotationText);

		const annotationList = h(ownerDocument, "div");
		annotationList.className = "ash-pdf-annotation-list";
		annotationList.setAttribute("role", "listbox");
		annotationList.setAttribute("aria-label", "Saved annotations");
		const status = h(ownerDocument, "div");
		status.className = "ash-pdf-annotation-status";
		status.setAttribute("role", "status");
		sidebar.append(heading, colorLabel, annotationTextLabel, annotationList, status);
		content.append(pages, sidebar);
		container.append(toolbar.element, content);
		parent.append(container);

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
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (matchPdfEditor(input) === EditorPaneMatch.None) {
			throw new RangeError(`PDF editor cannot open ${input.resource}`);
		}
		const pages = this.requirePages();
		this.clearInput();
		this.input = input;
		this.statusMessage = "Loading PDF and annotations…";
		this.renderToolbar();
		this.renderSidebar();
		try {
			const [bytes, snapshot] = await Promise.all([
				this.documentLoader.load(input, signal),
				this.annotationStore.load(input.resource, signal),
			]);
			throwIfCancelled(signal, "PDF document loading was cancelled");
			const renderResult = await this.renderer.render({ bytes, container: pages, scale: 1.25, signal });
			if (signal.aborted) {
				renderResult.dispose();
				throwIfCancelled(signal, "PDF document loading was cancelled");
			}
			this.renderResult = renderResult;
			this.annotationModel.restore(snapshot);
			this.statusMessage = undefined;
			this.renderAnnotations();
			this.renderToolbar();
			this.renderSidebar();
		} catch (error) {
			this.clearInput();
			throw error;
		}
	}

	clearInput(): void {
		this.activeAnnotation?.preview.remove();
		this.activeAnnotation = undefined;
		this.annotationInteractions.clear();
		this.sidebarInteractions.clear();
		this.renderResult?.dispose();
		this.renderResult = undefined;
		this.pages?.replaceChildren();
		this.input = undefined;
		this.selectedAnnotationId = undefined;
		this.statusMessage = undefined;
		this.annotationModel.restore({ document: { version: 1, annotations: [] }, revision: undefined });
		this.renderToolbar();
		this.renderSidebar();
	}

	layout(_dimension: IDimension): void {}

	setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) this.container.hidden = visibility === EditorPaneVisibility.Hidden;
	}

	focus(): void {
		this.requirePages().focus();
	}

	async save(): Promise<void> {
		if (!this.input || !this.annotationModel.isDirty) return;
		if (this.saveOperation) return this.saveOperation;
		const input = this.input;
		this.statusMessage = "Saving annotations…";
		this.renderToolbar();
		this.renderSidebar();
		this.saveOperation = this.persistAnnotations(input).finally(() => {
			this.saveOperation = undefined;
			this.renderToolbar();
			this.renderSidebar();
		});
		return this.saveOperation;
	}

	private async persistAnnotations(input: EditorInput): Promise<void> {
		try {
			const controller = new AbortController();
			const snapshot = await this.annotationStore.save(input.resource, this.annotationModel.snapshot, this.annotationModel.revision, controller.signal);
			if (this.input !== input) return;
			this.annotationModel.markSaved(snapshot);
			this.statusMessage = "Annotations saved";
		} catch (error) {
			this.statusMessage = error instanceof Error ? `Could not save annotations: ${error.message}` : "Could not save annotations";
			throw error;
		}
	}

	private onAnnotationsChanged(): void {
		if (this.statusMessage === "Annotations saved" || this.statusMessage?.startsWith("Could not save")) {
			this.statusMessage = undefined;
		}
		this.renderAnnotations();
		this.renderToolbar();
		this.renderSidebar();
	}

	private renderToolbar(): void {
		const available = this.input !== undefined;
		this.toolbar?.setActions([
			action("ash.pdf.annotations.select", "Select", "Select annotations", lxiconsLibrary.check, available, this.mode === "select", () => this.setMode("select")),
			action("ash.pdf.annotations.highlight", "Highlight", "Draw a highlight", lxiconsLibrary.bold, available, this.mode === "highlight", () => this.setMode("highlight")),
			action("ash.pdf.annotations.ink", "Draw", "Draw freehand ink", lxiconsLibrary.italics, available, this.mode === "ink", () => this.setMode("ink")),
			action("ash.pdf.annotations.note", "Note", "Place a note", lxiconsLibrary.chat, available, this.mode === "note", () => this.setMode("note")),
			new Separator(),
			action("ash.pdf.annotations.undo", "Undo", "Undo annotation change", lxiconsLibrary.history, available && this.annotationModel.canUndo, false, () => this.annotationModel.undo()),
			action("ash.pdf.annotations.redo", "Redo", "Redo annotation change", lxiconsLibrary.history, available && this.annotationModel.canRedo, false, () => this.annotationModel.redo()),
			action("ash.pdf.annotations.delete", "Delete", "Delete selected annotation", lxiconsLibrary.trash, available && this.selectedAnnotationId !== undefined, false, () => this.deleteSelectedAnnotation()),
			new Separator(),
			action("ash.pdf.annotations.save", "Save", "Save annotations", lxiconsLibrary.check, available && this.annotationModel.isDirty && !this.saveOperation, false, () => this.save().catch(() => undefined)),
		]);
	}

	private renderSidebar(): void {
		const annotationList = this.annotationList;
		const annotationText = this.annotationText;
		const annotationTextLabel = this.annotationTextLabel;
		const status = this.statusElement;
		if (!annotationList || !annotationText || !annotationTextLabel || !status) return;
		const selectedNote = this.selectedAnnotation();
		annotationTextLabel.firstChild!.textContent = selectedNote ? "Selected note" : "New note";
		annotationText.disabled = this.input === undefined;
		if (annotationText.ownerDocument.activeElement !== annotationText) {
			annotationText.value = selectedNote?.text ?? this.noteDraft;
		}
		annotationList.replaceChildren(...this.annotationModel.annotations.map((annotation, index) => {
			const item = h(annotationList.ownerDocument, "button");
			item.className = "ash-pdf-annotation-list-item";
			item.type = "button";
			item.setAttribute("role", "option");
			item.classList.toggle("selected", annotation.id === this.selectedAnnotationId);
			item.setAttribute("aria-selected", String(annotation.id === this.selectedAnnotationId));
			item.textContent = annotation.kind === "note" ? `Note ${index + 1}: ${annotation.text || "(empty)"}` : `${annotation.kind === "highlight" ? "Highlight" : "Ink"} ${index + 1} · page ${annotation.page}`;
			this.sidebarInteractions.add(addDisposableListener(item, "click", () => this.selectAnnotation(annotation.id)));
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
			layer.dataset.annotationMode = this.mode;
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
					marker.title = annotation.text || "Note";
					marker.setAttribute("aria-label", `Note: ${annotation.text || "empty"}`);
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
		if (!this.input || event.button !== 0 || this.activeAnnotation || this.mode === "select") return;
		const point = annotationPoint(layer, event);
		if (this.mode === "note") {
			const note = this.annotationModel.addNote(page.pageNumber, point, this.noteDraft || defaultNoteText, this.color);
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
		layer.setPointerCapture?.(event.pointerId);
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
		if (isAnnotationLayer(layer)) layer.releasePointerCapture?.(event.pointerId);
		this.renderAnnotations();
		this.renderToolbar();
		this.renderSidebar();
	}

	private setMode(mode: PdfAnnotationMode): void {
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
		const id = this.selectedAnnotationId;
		if (!id) return;
		this.selectedAnnotationId = undefined;
		this.annotationModel.remove(id);
	}

	private commitSelectedNote(): void {
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
		if (!this.input) return "No PDF selected";
		if (this.annotationModel.isDirty) return "Unsaved annotations";
		const count = this.annotationModel.annotations.length;
		return `${count} annotation${count === 1 ? "" : "s"} saved`;
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
