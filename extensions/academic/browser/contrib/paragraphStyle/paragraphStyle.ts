import type { SelectBox } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { localize } from '../../../../../src/ash/nls.js';
import { type DocumentEditorContributionContext, type DocumentFormattingContribution, type DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import { createSetParagraphStyleCommand } from '../../../common/commands/documentParagraphCommands.js';

/** Built-in paragraph styles affect structure; direct paragraph and character formatting is retained. */
export class ParagraphStyleContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly style: SelectBox;

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.paragraphStyle.group', 'Paragraph styles'));
		this.element.classList.add('stanza-document-paragraph-style');
		this.style = this.addSelect(localize('document.paragraphStyle.label', 'Paragraph style'), [
			{ value: '', label: localize('document.paragraph.mixed', 'Mixed') },
			{ value: '0', label: localize('document.paragraphStyle.normal', 'Normal') },
			...[1, 2, 3, 4, 5, 6].map(level => ({ value: String(level), label: localize('document.paragraphStyle.heading', 'Heading {0}', level) })),
		], value => context.runDocumentCommand((schema, document, blockId, selection) => createSetParagraphStyleCommand(schema, document, blockId, selection, Number(value))));
	}

	setState(state: DocumentFormattingState): void {
		const paragraphs = state.paragraphs ?? [];
		this.element.hidden = paragraphs.length === 0;
		this.style.enabled = !state.readOnly && paragraphs.length > 0;
		const levels = paragraphs.map(node => node.type === 'heading' ? Number(node.attrs.level) : 0);
		this.setSelectValue(this.style, levels.length && levels.every(level => level === levels[0]) ? String(levels[0]) : '');
	}
}
