import './documentReview.css';
import { h } from 'ash:editor/base/browser/dom.js';
import { DisposableStore } from 'ash:editor/base/common/lifecycle.js';
import { Button } from 'ash:editor/base/browser/ui/button/button.js';
import { defaultButtonStyles } from 'ash:editor/platform/theme/browser/defaultStyles.js';
import { localize } from 'ash:editor/nls.js';
import { createCommentCommand, createResolveRevisionCommand } from '../../../common/model/documentReview.js';
import { DocumentTransaction } from '../../../common/model/documentTransaction.js';
import { findDocumentNode, type DocumentNode } from '../../../common/model/document.js';
import type { DocumentEditorContributionContext, DocumentFormattingContribution, DocumentFormattingState } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';

export class DocumentReviewContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly rows = this._register(new DisposableStore());
	private readonly author = this.addInput(localize('document.review.author', 'Review author'));
	private readonly comment = this.addInput(localize('document.review.comment', 'Comment text'));
	private readonly add = this.addButton(localize('document.review.add', 'Add comment'), () => this.context.runDocumentCommand((schema, document, blockId, selection) => createCommentCommand(schema, document, blockId, selection, this.comment.value, this.author.value)));
	private readonly track = this.addSelect(localize('document.review.track', 'Track block revisions'), [
		{ value: 'false', label: localize('document.page.off', 'Off') }, { value: 'true', label: localize('document.page.on', 'On') },
	], value => this.context.runDocumentCommand((_schema, document, blockId) => ({ transaction: new DocumentTransaction().withMeta('review.control', true).setNodeAttributes(document.id, { ...document.attrs, trackChanges: value === 'true' }), focus: { blockId } })));
	private readonly list: HTMLElement;
	constructor(private readonly context: DocumentEditorContributionContext) {
		super(context.container, localize('document.review.group', 'Review'));
		this.author.value = localize('document.review.authorDefault', 'Author');
		this.author.inputElement.maxLength = 80;
		this.comment.inputElement.maxLength = 10_000;
		this.onInputCommit(this.author, value => context.setReviewAuthor(value));
		this.list = h(this.element.ownerDocument, 'div');
		this.list.className = 'ash-document-review-list';
		this.list.setAttribute('aria-label', localize('document.review.list', 'Comments and block revisions'));
		this.element.append(this.list);
	}
	setState(state: DocumentFormattingState): void {
		this.element.hidden = !state.document;
		this.track.enabled = this.author.enabled = this.comment.enabled = !state.readOnly;
		this.add.enabled = !state.readOnly && state.selection?.kind === 'text';
		this.setSelectValue(this.track, String(state.document?.attrs.trackChanges ?? false));
		this.rows.clear(); this.list.replaceChildren();
		const text = (node: DocumentNode | undefined): string => node?.text ?? node?.content.map(text).join('\n') ?? '';
		for (const record of state.document?.content ?? []) {
			if (record.type !== 'reviewComment' && record.type !== 'reviewChange') continue;
			const row = h(this.list.ownerDocument, 'article'); row.className = 'ash-document-review-record'; row.dataset.reviewId = record.id;
			const label = h(row.ownerDocument, 'div');
			label.textContent = record.type === 'reviewComment'
				? localize('document.review.commentSummary', '{0}: {1}', record.attrs.author, record.attrs.body)
				: record.attrs.scope === 'structure' ? localize('document.review.structureSummary', 'Document structure revision started by {0}', record.attrs.author) : localize('document.review.revisionSummary', 'Block revision started by {0}', record.attrs.author);
			row.append(label);
			const button = (name: string, run: () => void): void => {
				const control = this.rows.add(new Button(row, { ...defaultButtonStyles, label: name, size: 'small' })); control.enabled = !state.readOnly;
				this.rows.add(control.onDidClick(run));
			};
			if (record.type === 'reviewComment') {
				const quote = h(row.ownerDocument, 'blockquote'); quote.textContent = String(record.attrs.quote); row.append(quote);
				if (record.attrs.anchor) button(localize('document.review.go', 'Go to comment'), () => {
					const selection = JSON.parse(String(record.attrs.anchor));
					let target = findDocumentNode(state.document!, selection.anchor.nodeId);
					while (target?.parent && target.node.type !== 'paragraph' && target.node.type !== 'heading') target = findDocumentNode(state.document!, target.parent.id);
					if (target) this.context.selectText(target.node.id, selection);
				});
				button(record.attrs.resolved ? localize('document.review.reopen', 'Reopen comment') : localize('document.review.resolve', 'Resolve comment'), () => this.context.runDocumentCommand((_schema, document, blockId) => {
					const current = findDocumentNode(document, record.id)?.node;
					return current ? { transaction: new DocumentTransaction().withMeta('review.control', true).setNodeAttributes(current.id, { ...current.attrs, resolved: !current.attrs.resolved }), focus: { blockId } } : undefined;
				}));
				button(localize('document.review.delete', 'Delete comment'), () => this.context.runDocumentCommand((_schema, document, blockId) => document.content.some(node => node.id === record.id) ? { transaction: new DocumentTransaction().withMeta('review.control', true).deleteNode(record.id), focus: { blockId } } : undefined));
			} else {
				const comparison = h(row.ownerDocument, 'pre');
				comparison.textContent = localize('document.review.comparison', 'Before:\n{0}\nCurrent:\n{1}', record.attrs.before ? text(JSON.parse(String(record.attrs.before))) : '', text(findDocumentNode(state.document!, String(record.attrs.target))?.node)); row.append(comparison);
				for (const accept of [true, false]) button(record.attrs.scope === 'structure' ? (accept ? localize('document.review.acceptStructure', 'Accept document revision') : localize('document.review.rejectStructure', 'Reject document revision')) : accept ? localize('document.review.accept', 'Accept block revision') : localize('document.review.reject', 'Reject block revision'), () => this.context.runDocumentCommand((schema, document, blockId) => createResolveRevisionCommand(schema, document, record.id, accept, blockId)));
			}
			this.list.append(row);
		}
	}
}


/** Accessible View includes persisted review evidence as text, independently of the toolbar DOM. */
export function getDocumentReviewAccessibleText(document: DocumentNode): string {
	const text = (node: DocumentNode | undefined): string => node?.text ?? node?.content.map(text).join('\n') ?? '';
	return document.content.filter(node => node.type === 'reviewComment' || node.type === 'reviewChange').map(record => record.type === 'reviewComment'
		? localize('document.review.accessibleComment', '{0}: {1}\nQuoted text: {2}\nStatus: {3}', record.attrs.author, record.attrs.body, record.attrs.quote, record.attrs.resolved ? localize('document.review.resolved', 'Resolved') : localize('document.review.open', 'Open'))
		: localize('document.review.revisionSummary', 'Block revision started by {0}', record.attrs.author) + '\n' + localize('document.review.comparison', 'Before:\n{0}\nCurrent:\n{1}', record.attrs.before ? text(JSON.parse(String(record.attrs.before))) : '', text(findDocumentNode(document, String(record.attrs.target))?.node))
	).join('\n\n');
}
