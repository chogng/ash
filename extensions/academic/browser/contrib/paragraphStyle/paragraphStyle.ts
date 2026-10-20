import type { SelectBox } from '../../../../../src/ash/base/browser/ui/selectbox/selectbox.js';
import { localize } from '../../../../../src/ash/nls.js';
import { type DocumentEditorContributionContext, type DocumentFormattingContribution, type DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import type { InputBox } from '../../../../../src/ash/base/browser/ui/inputbox/inputbox.js';
import type { Button } from '../../../../../src/ash/base/browser/ui/button/button.js';
import { getDocumentParagraphStyles } from '../../../common/model/documentParagraph.js';
import { createApplyParagraphStyleCommand, createClearParagraphOverridesCommand, createDefineParagraphStyleCommand, createDeleteParagraphStyleCommand, createSetParagraphStyleCommand } from '../../../common/commands/documentParagraphCommands.js';

/** Built-in paragraph styles affect structure; direct paragraph and character formatting is retained. */
export class ParagraphStyleContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly style: SelectBox;
	private readonly name: InputBox;
	private readonly createStyle: Button;
	private readonly updateStyle: Button;
	private readonly deleteStyle: Button;
	private readonly clearOverrides: Button;
	private currentStyleId: string | undefined;
	private definitions = '';

	constructor(context: DocumentEditorContributionContext) {
		super(context.container, localize('document.paragraphStyle.group', 'Paragraph styles'));
		this.element.classList.add('stanza-document-paragraph-style');
		this.style = this.addSelect(localize('document.paragraphStyle.label', 'Paragraph style'), [
			{ value: '', label: localize('document.paragraph.mixed', 'Mixed') },
			{ value: '0', label: localize('document.paragraphStyle.normal', 'Normal') },
			...[1, 2, 3, 4, 5, 6].map(level => ({ value: String(level), label: localize('document.paragraphStyle.heading', 'Heading {0}', level) })),
		], value => context.runDocumentCommand((schema, document, blockId, selection) => value.startsWith('style:')
			? createApplyParagraphStyleCommand(schema, document, blockId, selection, value.slice(6))
			: createSetParagraphStyleCommand(schema, document, blockId, selection, Number(value))));
		this.name = this.addInput(localize('document.style.name', 'Style name'));
		this.name.inputElement.maxLength = 80;
		this.createStyle = this.addButton(localize('document.style.create', 'Create style'), () => context.runDocumentCommand((_schema, document, blockId) => createDefineParagraphStyleCommand(document, blockId, this.name.value)));
		this.updateStyle = this.addButton(localize('document.style.update', 'Update style from paragraph'), () => {
			const id = this.currentStyleId;
			if (!id) return;
			context.runDocumentCommand((_schema, document, blockId) => {
				const name = this.name.value.trim() || getDocumentParagraphStyles(document).find(style => style.id === id)?.name || '';
				return createDefineParagraphStyleCommand(document, blockId, name, id);
			});
		});
		this.deleteStyle = this.addButton(localize('document.style.delete', 'Delete style'), () => {
			const id = this.currentStyleId;
			if (id) context.runDocumentCommand((_schema, document, blockId) => createDeleteParagraphStyleCommand(document, blockId, id));
		});
		this._register(this.name.onDidChange(() => { this.createStyle.enabled = this.name.enabled && this.name.value.trim().length > 0; }));
		this.clearOverrides = this.addButton(localize('document.style.clearOverrides', 'Reset paragraph overrides'), () => context.runDocumentCommand((_schema, document, blockId, selection) => createClearParagraphOverridesCommand(document, blockId, selection)));
	}

	setState(state: DocumentFormattingState): void {
		const paragraphs = state.paragraphs ?? [];
		this.element.hidden = paragraphs.length === 0;
		this.style.enabled = !state.readOnly && paragraphs.length > 0;
		const encoded = String(state.document?.attrs.paragraphStyles ?? '');
		if (encoded !== this.definitions) {
			this.definitions = encoded;
			this.style.setOptions([
				...this.style.options.filter(option => !option.value.startsWith('style:')),
				...(state.document ? getDocumentParagraphStyles(state.document).map(style => ({ value: `style:${style.id}`, label: style.name })) : []),
			]);
		}
		this.currentStyleId = paragraphs.length && paragraphs.every(node => node.attrs.styleId === paragraphs[0]!.attrs.styleId) ? paragraphs[0]!.attrs.styleId as string | undefined : undefined;
		this.name.enabled = this.clearOverrides.enabled = !state.readOnly && paragraphs.length > 0;
		this.createStyle.enabled = this.name.enabled && this.name.value.trim().length > 0 && (state.document ? getDocumentParagraphStyles(state.document).length < 100 : false);
		this.updateStyle.enabled = this.deleteStyle.enabled = !state.readOnly && this.currentStyleId !== undefined;
		const levels = paragraphs.map(node => node.type === 'heading' ? Number(node.attrs.level) : 0);
		this.setSelectValue(this.style, levels.length && levels.every(level => level === levels[0]) ? (this.currentStyleId ? `style:${this.currentStyleId}` : paragraphs.some(node => node.attrs.styleId) ? '' : String(levels[0])) : '');
	}
}
