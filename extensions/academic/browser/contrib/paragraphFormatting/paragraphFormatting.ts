import { localize } from '../../../../../src/ash/nls.js';
import type { SelectBox, SelectOption } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { type DocumentEditorContributionContext, type DocumentFormattingContribution, type DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import { createSetParagraphFormatCommand } from '../../../common/commands/documentParagraphCommands.js';
import { defaultDocumentParagraphAttributes, resolveDocumentParagraphAttributes, type DocumentParagraphAttributes } from '../../../common/model/documentParagraph.js';

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
		const fonts = [mixed, { value: 'sans', label: localize('document.style.fontSans', 'Sans serif') }, { value: 'serif', label: localize('document.style.fontSerif', 'Serif') }, { value: 'monospace', label: localize('document.style.fontMono', 'Monospace') }];
		this.controls.set('fontFamily', { options: fonts, control: this.addSelect(localize('document.style.font', 'Paragraph font'), fonts, value => context.runDocumentCommand((_schema, document, blockId, selection) => createSetParagraphFormatCommand(document, blockId, selection, { fontFamily: value as DocumentParagraphAttributes['fontFamily'] }))) });
		for (const [key, label, values] of [
			['fontSize', localize('document.style.fontSize', 'Paragraph font size'), [10, 12, 14, 16, 18, 24, 32]],
			['lineSpacing', localize('document.paragraphFormatting.lineSpacing', 'Line spacing'), [1, 1.15, 1.5, 1.6, 2, 2.5, 3]],
			['spaceBefore', localize('document.paragraphFormatting.before', 'Space before'), [0, 6, 12, 18, 24]],
			['indentStart', localize('document.paragraphFormatting.indentStart', 'Start indent'), [0, 18, 36, 54, 72]],
			['indentEnd', localize('document.paragraphFormatting.indentEnd', 'End indent'), [0, 18, 36, 54, 72]],
			['firstLineIndent', localize('document.paragraphFormatting.firstLineIndent', 'First line indent'), [-36, -18, 0, 18, 36]],
			['spaceAfter', localize('document.paragraphFormatting.after', 'Space after'), [0, 6, 12, 18, 24]],
		] as const) {
			const options = [mixed, ...values.map(value => ({ value: String(value), label: key === 'lineSpacing' || key === 'fontSize' ? String(value) : localize('document.paragraphFormatting.points', '{0} pt', value) }))];
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
			const fallback = key in defaultDocumentParagraphAttributes ? defaultDocumentParagraphAttributes[key as keyof typeof defaultDocumentParagraphAttributes] : undefined;
			const values = paragraphs.map(node => (state.document ? resolveDocumentParagraphAttributes(state.document, node)[key] : node.attrs[key]) ?? fallback);
			const value = values.length && values[0] !== undefined && values.every(value => value === values[0]) ? String(values[0]) : '';
			const displayedOptions = value && !options.some(option => option.value === value)
				? [...options, { value, label: key === 'lineSpacing' || key === 'textAlign' || key === 'fontFamily' || key === 'fontSize' ? value : localize('document.paragraphFormatting.points', '{0} pt', value) }]
				: options;
			// Rebuilding an unchanged popup would discard its active keyboard option.
			if (control.options.length !== displayedOptions.length || control.options.some((option, index) => option.value !== displayedOptions[index]?.value)) control.setOptions(displayedOptions);
			this.setSelectValue(control, value);
		}
	}
}
