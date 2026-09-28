import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { type IModelDecorationOptions } from '../../../common/model.js';

const diffInsertIcon = registerIcon('diff-insert', () =>
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 8h8M8 4v8"/></svg>',
	'Inserted diff line',
);

const diffRemoveIcon = registerIcon('diff-remove', () =>
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 8h8"/></svg>',
	'Removed diff line',
);

export const diffLineAddDecorationBackground: IModelDecorationOptions = Object.freeze({
	description: 'diff-modified-line',
	isWholeLine: true,
	className: 'stanza-diff-line-added',
	marginClassName: 'stanza-diff-gutter-added',
	firstLineDecorationClassName: 'stanza-diff-insert-sign',
	firstLineDecorationIcon: diffInsertIcon,
});

export const diffLineDeleteDecorationBackground: IModelDecorationOptions = Object.freeze({
	description: 'diff-original-line',
	isWholeLine: true,
	className: 'stanza-diff-line-removed',
	marginClassName: 'stanza-diff-gutter-removed',
	firstLineDecorationClassName: 'stanza-diff-remove-sign',
	firstLineDecorationIcon: diffRemoveIcon,
});

export const diffAddDecoration: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-change',
	inlineClassName: 'stanza-diff-inline-added',
});

export const diffDeleteDecoration: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-change',
	inlineClassName: 'stanza-diff-inline-removed',
});

export const diffAddDecorationEmpty: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-insertion-anchor',
	className: 'stanza-diff-inline-added-empty',
	showIfCollapsed: true,
});

export const diffDeleteDecorationEmpty: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-deletion-anchor',
	className: 'stanza-diff-inline-removed-empty',
	showIfCollapsed: true,
});
