import type { Button } from '../../../../../src/ash/base/browser/ui/button/button.js';
import { getDocumentPageOwner, createDocumentSectionCommand, createRemoveSectionCommand } from '../../../common/model/documentSections.js';
import { resolveDocumentParagraphAttributes } from '../../../common/model/documentParagraph.js';
import { addDisposableListener, h } from '../../../../../src/ash/base/browser/dom.js';
import type { InputBox } from '../../../../../src/ash/base/browser/ui/inputbox/inputbox.js';
import { createSetParagraphFormatCommand } from '../../../common/commands/documentParagraphCommands.js';
import type { SelectBox } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { localize } from '../../../../../src/ash/nls.js';
import { DocumentTransaction } from '../../../common/model/documentTransaction.js';
import type { DocumentEditorContributionContext, DocumentFormattingContribution, DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';

export class PageLayoutContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly startSection: Button;
	private readonly removeSection: Button;
	private readonly paper: SelectBox;
	private readonly margin: SelectBox;
	private readonly zoom: SelectBox;
	private readonly orientation: SelectBox;
	private readonly rules = new Map<'pageBreakBefore' | 'keepWithNext' | 'keepTogether' | 'widowControl', SelectBox>();
	private readonly running = new Map<string, InputBox>();
	private readonly options = new Map<string, SelectBox>();

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.page.group', 'Page layout'));
		this.paper = this.addSelect(localize('document.page.paper', 'Paper'), [
			{ value: 'continuous', label: localize('document.page.continuous', 'Continuous') },
			{ value: 'a4', label: 'A4' }, { value: 'letter', label: localize('document.page.letter', 'Letter') },
		], pageSize => context.runDocumentCommand((_schema, document, blockId) => ({
			transaction: new DocumentTransaction().setNodeAttributes(getDocumentPageOwner(document, blockId).id, { ...getDocumentPageOwner(document, blockId).attrs, pageSize }), focus: { blockId },
		})));
		this.margin = this.addSelect(localize('document.page.margin', 'Page margins'), [36, 54, 72, 108, 144].map(value => ({ value: String(value), label: localize('document.paragraphFormatting.points', '{0} pt', value) })), value => {
			context.runDocumentCommand((_schema, document, blockId) => ({
				transaction: new DocumentTransaction().setNodeAttributes(getDocumentPageOwner(document, blockId).id, { ...getDocumentPageOwner(document, blockId).attrs, pageMargin: Number(value) }), focus: { blockId },
			}));
		});
		this.zoom = this.addSelect(localize('document.page.zoom', 'Page zoom'), [50, 75, 100, 125, 150, 200].map(value => ({ value: String(value), label: localize('document.page.percent', '{0}%', value) })), value => context.setPageZoom(Number(value) / 100));
		this.startSection = this.addButton(localize('document.section.start', 'Start section here'), () => context.runDocumentCommand((schema, document, blockId) => createDocumentSectionCommand(schema, document, blockId)));
		this.removeSection = this.addButton(localize('document.section.remove', 'Remove section break'), () => context.runDocumentCommand((_schema, document, blockId) => createRemoveSectionCommand(document, blockId)));
		const details = h(this.element.ownerDocument, 'details');
		details.className = 'ash-document-page-options';
		const summary = h(this.element.ownerDocument, 'summary');
		summary.textContent = localize('document.page.options', 'Pagination options');
		details.append(summary);
		const existing = new Set(this.element.children);
		this.orientation = this.addSelect(localize('document.page.orientation', 'Orientation'), [
			{ value: 'portrait', label: localize('document.page.portrait', 'Portrait') },
			{ value: 'landscape', label: localize('document.page.landscape', 'Landscape') },
		], pageOrientation => context.runDocumentCommand((_schema, document, blockId) => ({
			transaction: new DocumentTransaction().setNodeAttributes(getDocumentPageOwner(document, blockId).id, { ...getDocumentPageOwner(document, blockId).attrs, pageOrientation }), focus: { blockId },
		})));
		const booleanOptions = [
			{ value: 'true', label: localize('document.page.on', 'On') },
			{ value: 'false', label: localize('document.page.off', 'Off') },
		];
		for (const [key, label] of [
			['pageBreakBefore', localize('document.page.breakBefore', 'Page break before')],
			['keepWithNext', localize('document.page.keepNext', 'Keep with next')],
			['keepTogether', localize('document.page.keepTogether', 'Keep paragraph together')],
			['widowControl', localize('document.page.widows', 'Widow and orphan control')],
		] as const) {
			this.rules.set(key, this.addSelect(label, [{ value: '', label: localize('document.paragraph.mixed', 'Mixed') }, ...booleanOptions], value => {
				context.runDocumentCommand((_schema, document, blockId, selection) => createSetParagraphFormatCommand(document, blockId, selection, { [key]: value === 'true' }));
			}));
		}
		for (const [key, label] of [
			['pageHeader', localize('document.page.header', 'Page header')],
			['pageFooter', localize('document.page.footer', 'Page footer')],
			['pageEvenHeader', localize('document.page.evenHeader', 'Even page header')],
			['pageEvenFooter', localize('document.page.evenFooter', 'Even page footer')],
		] as const) {
			const input = this.addInput(label);
			input.inputElement.maxLength = 500;
			this.running.set(key, input);
			this.onInputCommit(input, value => context.runDocumentCommand((_schema, document, blockId) => ({
				transaction: new DocumentTransaction().setNodeAttributes(getDocumentPageOwner(document, blockId).id, { ...getDocumentPageOwner(document, blockId).attrs, [key]: value }), focus: { blockId },
			})));
		}
		for (const [key, label] of [
			['pageNumbers', localize('document.page.numbers', 'Page numbers')],
			['pageDifferentFirst', localize('document.page.first', 'Different first page')],
			['pageDifferentEven', localize('document.page.even', 'Different even pages')],
		] as const) {
			this.options.set(key, this.addSelect(label, booleanOptions, value => context.runDocumentCommand((_schema, document, blockId) => ({
				transaction: new DocumentTransaction().setNodeAttributes(getDocumentPageOwner(document, blockId).id, { ...getDocumentPageOwner(document, blockId).attrs, [key]: value === 'true' }), focus: { blockId },
			}))));
		}
		for (const control of [...this.element.children]) if (!existing.has(control)) details.append(control);
		this.element.append(details);
		this._register(addDisposableListener(details, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			details.open = false;
			context.focusEditor();
		}));

	}

	setState(state: DocumentFormattingState): void {
		this.element.hidden = !state.document;
		const owner = state.document ? getDocumentPageOwner(state.document, state.blockId) : undefined;
		const attrs = { ...state.document?.attrs, ...owner?.attrs };
		this.startSection.enabled = !state.readOnly && !!state.blockId;
		this.removeSection.enabled = !state.readOnly && owner?.type === 'documentSection';
		this.paper.enabled = !state.readOnly;
		const paged = attrs.pageSize === 'a4' || attrs.pageSize === 'letter';
		this.margin.enabled = !state.readOnly && paged;
		this.zoom.enabled = paged;
		this.orientation.enabled = !state.readOnly && paged;
		this.setSelectValue(this.orientation, String(attrs.pageOrientation ?? 'portrait'));
		for (const [key, control] of this.rules) {
			control.enabled = !state.readOnly && paged && !!state.paragraphs?.length;
			const values = new Set(state.paragraphs?.map(paragraph => resolveDocumentParagraphAttributes(state.document!, paragraph)[key]));
			this.setSelectValue(control, values.size === 1 ? String([...values][0]) : '');
		}
		for (const [key, input] of this.running) {
			input.enabled = !state.readOnly && paged;
			const value = String(attrs[key] ?? '');
			if (input.inputElement !== input.inputElement.ownerDocument.activeElement && input.value !== value) input.value = value;
		}
		for (const [key, control] of this.options) {
			control.enabled = !state.readOnly && paged;
			this.setSelectValue(control, String(attrs[key] ?? false));
		}

		this.setSelectValue(this.paper, String(attrs.pageSize ?? 'continuous'));
		const margin = String(attrs.pageMargin ?? 72);
		if (!this.margin.options.some(option => option.value === margin)) this.margin.setOptions([...this.margin.options, { value: margin, label: localize('document.paragraphFormatting.points', '{0} pt', margin) }]);
		this.setSelectValue(this.margin, margin);
		this.setSelectValue(this.zoom, String((state.pageZoom ?? 1) * 100));
	}
}
