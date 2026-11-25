import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { PdfAnnotation, PdfAnnotationEdit } from '../../../../../platform/pdf/common/pdfService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import './media/pdfAnnotations.css';

export function isReviewAnnotation(annotation: PdfAnnotation): boolean {
	// PDFium includes document navigation links in the page's annotation array.
	return annotation.kind !== 'Link';
}

export class PdfAnnotations extends Disposable {
	private readonly note: HTMLTextAreaElement;
	private readonly annotations: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly rows = this._register(new DisposableStore());

	constructor(container: HTMLElement, private readonly applyEdit: (edit: PdfAnnotationEdit) => void) {
		super();
		const document = container.ownerDocument;
		this.note = h(document, 'textarea', {
			properties: { maxLength: 8192, rows: 3 },
			attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') },
		});
		this.annotations = h(document, 'div');
		this.scrollable = this._register(new ScrollableElement(container, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		this.scrollable.contentElement.classList.add('ash-sessions-pdf-annotations');
		this.scrollable.append(this.note);
		this.scrollable.append(this.annotations);
	}

	get noteText(): string { return this.note.value; }

	setNoteEnabled(enabled: boolean): void {
		this.note.disabled = !enabled;
	}

	layout(): void {
		this.scrollable.layout();
	}

	clear(): void {
		this.rows.clear();
		this.annotations.replaceChildren();
		this.note.value = '';
	}

	setAnnotations(annotations: readonly PdfAnnotation[]): void {
		const document = this.annotations.ownerDocument;
		this.rows.clear();
		this.annotations.replaceChildren();
		for (const annotation of annotations.filter(isReviewAnnotation)) {
			const item = h(document, 'div', { className: 'ash-sessions-pdf-annotation' });
			item.append(h(document, 'p', { properties: { textContent: `${annotation.kind}${annotation.author ? ` · ${annotation.author}` : ''}` } }));
			const contents = h(document, 'textarea', { properties: { value: annotation.contents, maxLength: 8192, rows: 2 }, attributes: { 'aria-label': localize('sessions.pdfPreview.noteText', 'Annotation text') } });
			item.append(contents);
			for (const [label, edit] of [
				[localize('sessions.pdfPreview.updateAnnotation', 'Update'), () => ({ kind: 'update' as const, index: annotation.index, contents: contents.value })],
				[localize('sessions.pdfPreview.deleteAnnotation', 'Delete'), () => ({ kind: 'delete' as const, index: annotation.index })],
			] as const) {
				this.rows.add(new Button(item, { ...defaultButtonStyles, label, onClick: () => this.applyEdit(edit()) }));
			}
			this.annotations.append(item);
		}
	}
}
