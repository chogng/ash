import type { SelectBox } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { localize } from '../../../../../src/ash/nls.js';
import { DocumentTransaction } from '../../../common/model/documentTransaction.js';
import type { DocumentEditorContributionContext, DocumentFormattingContribution, DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';

export class PageLayoutContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly paper: SelectBox;
	private readonly margin: SelectBox;
	private readonly zoom: SelectBox;

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.page.group', 'Page layout'));
		this.paper = this.addSelect(localize('document.page.paper', 'Paper'), [
			{ value: 'continuous', label: localize('document.page.continuous', 'Continuous') },
			{ value: 'a4', label: 'A4' }, { value: 'letter', label: localize('document.page.letter', 'Letter') },
		], pageSize => context.runDocumentCommand((_schema, document, blockId) => ({
			transaction: new DocumentTransaction().setNodeAttributes(document.id, { ...document.attrs, pageSize }), focus: { blockId },
		})));
		this.margin = this.addSelect(localize('document.page.margin', 'Page margins'), [36, 54, 72, 108, 144].map(value => ({ value: String(value), label: localize('document.paragraphFormatting.points', '{0} pt', value) })), value => {
			context.runDocumentCommand((_schema, document, blockId) => ({
				transaction: new DocumentTransaction().setNodeAttributes(document.id, { ...document.attrs, pageMargin: Number(value) }), focus: { blockId },
			}));
		});
		this.zoom = this.addSelect(localize('document.page.zoom', 'Page zoom'), [50, 75, 100, 125, 150, 200].map(value => ({ value: String(value), label: localize('document.page.percent', '{0}%', value) })), value => context.setPageZoom(Number(value) / 100));
	}

	setState(state: DocumentFormattingState): void {
		this.element.hidden = !state.document;
		this.paper.enabled = !state.readOnly;
		const paged = state.document?.attrs.pageSize === 'a4' || state.document?.attrs.pageSize === 'letter';
		this.margin.enabled = !state.readOnly && paged;
		this.zoom.enabled = paged;
		this.setSelectValue(this.paper, String(state.document?.attrs.pageSize ?? 'continuous'));
		const margin = String(state.document?.attrs.pageMargin ?? 72);
		if (!this.margin.options.some(option => option.value === margin)) this.margin.setOptions([...this.margin.options, { value: margin, label: localize('document.paragraphFormatting.points', '{0} pt', margin) }]);
		this.setSelectValue(this.margin, margin);
		this.setSelectValue(this.zoom, String((state.pageZoom ?? 1) * 100));
	}
}
