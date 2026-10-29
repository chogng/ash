import { localize } from 'ash:editor/nls.js';

/** Package-specific instructions accompany the view whose controls they describe. */
export function getDocumentAccessibilityHelp(documentType: string): readonly string[] {
	return [
		localize(
			'document.accessibility.overview',
			'You are editing a structured document. Tab and Shift+Tab move between text blocks and formatting controls. Use the arrow keys inside a text block and the standard undo and redo commands to edit.',
		),
		localize(
			'document.accessibility.paragraph',
			'Paragraph style controls select Normal, Heading 1 through 6, or a custom document style. Enter a style name and choose Create style to capture paragraph formatting. Update style from paragraph updates its references; Delete style retains their appearance. Reset paragraph overrides restores inherited paragraph formatting and keeps character marks. Paragraph controls set fonts, alignment, spacing, start and end indents, and first line or hanging indents. List numbering controls set the start and number format of the active ordered list. These actions support standard undo.',
		),
		localize(
			'document.accessibility.pages',
			'Paper selects Continuous, A4 or Letter. Paged documents stack single-column pages vertically. Page margins change the saved document and support undo; Page zoom changes only this view. Arrow keys and selection continue through page boundaries in the same paragraph. Copy, cut and paste use document positions across pages. Expand Pagination options to change orientation, page break before, keep with next, keep paragraph together, and widow and orphan control. Header and footer text, page numbers, different first page and different even pages are saved with the document. Escape closes these options and returns to the document.',
		),
		localize(
			'document.accessibility.find',
			'Use Ctrl+F or Command+F to open Find and replace. Search crosses character formatting within a block and supports Match case and Whole word. Enter and Shift+Enter move between matches. Replace all is one undo step and preserves other formatting and objects. Escape closes search and returns to the current match. Read-only documents allow search and navigation.',
		),
		localize(
			'document.accessibility.review',
			'Select text, enter Comment text, and choose Add comment. Review author identifies subsequent revisions. Track block revisions saves the original block baseline; Accept keeps current content and Reject restores the entire block. Comments can be located, resolved, reopened or deleted. These actions support undo.',
		),
		...(documentType === 'academy'
			? [
					localize(
						'document.accessibility.references',
						'Academy documents provide Citation and Reference actions. Leave the citation label empty for automatic bibliography numbering. Edit reference changes a key and all its citations in one undo step. Delete reference keeps citations as unresolved items. Duplicate keys are rejected. Tab reaches citations; Enter or Space selects one. These actions are unavailable in read-only documents.',
					),
				]
			: []),
		localize(
			'document.accessibility.artifacts',
			'Start section here gives the current block and following content separate page settings; Remove section break merges into the previous section. Import Document File converts DOCX into a new draft; Export Document File writes a separate DOCX or page-image PDF. PDF text is not searchable, and output retains the content version at the start of export.',
		),
	];
}
