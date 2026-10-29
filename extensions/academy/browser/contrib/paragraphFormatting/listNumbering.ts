import { localize } from 'ash:editor/nls.js';
import type { SelectBox } from 'ash:editor/base/browser/ui/selectbox/selectbox.js';
import type { InputBox } from 'ash:editor/base/browser/ui/inputbox/inputbox.js';
import type {
	DocumentEditorContributionContext,
	DocumentFormattingContribution,
	DocumentFormattingState,
} from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import { createSetListNumberingCommand, getDocumentList } from '../../../common/commands/documentParagraphCommands.js';

/** List values belong to the innermost list, including nested lists inside table cells. */
export class ListNumberingContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly order: InputBox;
	private readonly numbering: SelectBox;

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.list.group', 'List numbering'));
		this.order = this.addInput(localize('document.list.start', 'Start numbering at'), 'number');
		this.order.inputElement.min = '1';
		this.order.inputElement.max = '2147483647';
		this.order.inputElement.step = '1';
		this.onInputCommit(this.order, value => {
			const order = Number(value);
			if (!Number.isSafeInteger(order) || order < 1 || order > 2_147_483_647) {
				this.order.showValidation(
					localize('document.list.invalidStart', 'Enter a whole number from 1 to 2147483647.'),
				);
				return;
			}
			this.order.showValidation('');
			context.runDocumentCommand((_schema, document, blockId) =>
				createSetListNumberingCommand(document, blockId, { order }),
			);
		});
		this.numbering = this.addSelect(
			localize('document.list.format', 'Number format'),
			[
				{ value: 'decimal', label: '1, 2, 3' },
				{ value: 'lower-alpha', label: 'a, b, c' },
				{ value: 'upper-alpha', label: 'A, B, C' },
				{ value: 'lower-roman', label: 'i, ii, iii' },
				{ value: 'upper-roman', label: 'I, II, III' },
			],
			numbering =>
				context.runDocumentCommand((_schema, document, blockId) =>
					createSetListNumberingCommand(document, blockId, { numbering }),
				),
		);
	}

	setState(state: DocumentFormattingState): void {
		const list = state.document && state.blockId ? getDocumentList(state.document, state.blockId) : undefined;
		this.element.hidden = list?.type !== 'orderedList';
		this.order.enabled = this.numbering.enabled = !state.readOnly && list?.type === 'orderedList';
		if (list?.type !== 'orderedList') return;
		this.order.value = String(list.attrs.order ?? 1);
		this.setSelectValue(this.numbering, String(list.attrs.numbering ?? 'decimal'));
	}
}
