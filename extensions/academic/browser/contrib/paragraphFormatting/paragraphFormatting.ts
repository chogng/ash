import { localize } from '../../../../../src/ash/nls.js';
import type { SelectBox, SelectOption } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { type DocumentEditorContributionContext, type DocumentFormattingContribution, type DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import { createSetParagraphFormatCommand } from '../../../common/commands/documentParagraphCommands.js';
import { defaultDocumentParagraphAttributes, type DocumentParagraphAttributes } from '../../../common/model/documentParagraph.js';

/** Controls project the selected paragraphs; measurements are committed through the Widget's current command port. */
export class ParagraphFormattingContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly controls = new Map<keyof DocumentParagraphAttributes, { control: SelectBox; options: readonly SelectOption[]; }>();

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.paragraphFormatting.group', 'Paragraph formatting'));
		this.element.classList.add('stanza-document-paragraph-formatting');
		const mixed = { value: '', label: localize('document.paragraph.mixed', 'Mixed') };
		const alignmentOptions = [mixed,
			{ value: 'start', label: localize('document.paragraphFormatting.start', 'Start') },
			{ value: 'center', label: localize('document.paragraphFormatting.center', 'Center') },
			{ value: 'end', label: localize('document.paragraphFormatting.end', 'End') },
			{ value: 'justify', label: localize('document.paragraphFormatting.justify', 'Justify') },
		];
		this.controls.set('textAlign', {
			options: alignmentOptions, control: this.addSelect(localize('document.paragraphFormatting.alignment', 'Alignment'), alignmentOptions,
				value => context.runDocumentCommand((_schema, document, blockId, selection) => createSetParagraphFormatCommand(document, blockId, selection, { textAlign: value as DocumentParagraphAttributes['textAlign'] })))
		});
		for (const [key, label, values] of [
			['lineSpacing', localize('document.paragraphFormatting.lineSpacing', 'Line spacing'), [1, 1.15, 1.5, 1.6, 2, 2.5, 3]],
			['spaceBefore', localize('document.paragraphFormatting.before', 'Space before'), [0, 6, 12, 18, 24]],
			['spaceAfter', localize('document.paragraphFormatting.after', 'Space after'), [0, 6, 12, 18, 24]],
		] as const) {
			const options = [mixed, ...values.map(value => ({ value: String(value), label: key === 'lineSpacing' ? String(value) : localize('document.paragraphFormatting.points', '{0} pt', value) }))];
			this.controls.set(key, {
				options, control: this.addSelect(label, options, value => {
					context.runDocumentCommand((_schema, document, blockId, selection) => createSetParagraphFormatCommand(document, blockId, selection, { [key]: Number(value) }));
				})
			});
		}
	}

	setState(state: DocumentFormattingState): void {
		const paragraphs = state.paragraphs ?? [];
		this.element.hidden = paragraphs.length === 0;
		for (const [key, { control, options }] of this.controls) {
			control.enabled = !state.readOnly && paragraphs.length > 0;
			// Unspecified values follow the writing surface's existing defaults.
			// Imported custom measurements are shown exactly, never rounded on focus.
			const fallback = defaultDocumentParagraphAttributes[key];
			const values = paragraphs.map(node => node.attrs[key] ?? fallback);
			const value = values.length && values.every(value => value === values[0]) ? String(values[0]) : '';
			const displayedOptions = value && !options.some(option => option.value === value)
				? [...options, { value, label: key === 'lineSpacing' || key === 'textAlign' ? value : localize('document.paragraphFormatting.points', '{0} pt', value) }]
				: options;
			// Rebuilding an unchanged popup would discard its active keyboard option.
			if (control.options.length !== displayedOptions.length || control.options.some((option, index) => option.value !== displayedOptions[index]?.value)) control.setOptions(displayedOptions);
			this.setSelectValue(control, value);
		}
	}
}
