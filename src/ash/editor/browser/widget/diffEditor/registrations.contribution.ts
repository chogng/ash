import { Lxicon } from '../../../../base/common/lxicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { type IModelDecorationOptions } from '../../../common/model.js';

const diffInsertIcon = registerIcon('diff-insert', Lxicon.diffLineAdd,
	'Inserted diff line',
);

export const diffRemoveIcon = registerIcon('diff-remove', Lxicon.diffLineDelete,
	'Removed diff line',
);

export const diffLineAddDecorationBackground: IModelDecorationOptions = Object.freeze({
	description: 'diff-modified-line',
	isWholeLine: true,
	className: 'stanza-diff-line-added',
	marginClassName: 'stanza-diff-gutter-added',
});

export const diffLineAddDecorationBackgroundWithIndicator: IModelDecorationOptions = Object.freeze({
	...diffLineAddDecorationBackground,
	firstLineDecorationClassName: 'stanza-diff-insert-sign',
	firstLineDecorationIcon: diffInsertIcon,
});

export const diffLineDeleteDecorationBackground: IModelDecorationOptions = Object.freeze({
	description: 'diff-original-line',
	isWholeLine: true,
	className: 'stanza-diff-line-removed',
	marginClassName: 'stanza-diff-gutter-removed',
});

export const diffLineDeleteDecorationBackgroundWithIndicator: IModelDecorationOptions = Object.freeze({
	...diffLineDeleteDecorationBackground,
	firstLineDecorationClassName: 'stanza-diff-remove-sign',
	firstLineDecorationIcon: diffRemoveIcon,
});

export const diffAddDecoration: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-change',
	className: 'stanza-diff-inline-added',
	shouldFillLineOnLineBreak: true,
});

export const diffDeleteDecoration: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-change',
	className: 'stanza-diff-inline-removed',
	shouldFillLineOnLineBreak: true,
});

// The border marks the measured character boundary. Expanding a collapsed range
// would move its left edge half a character back into the preceding glyph.
export const diffAddDecorationEmpty: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-insertion-anchor',
	className: 'stanza-diff-inline-added-empty',
});

export const diffDeleteDecorationEmpty: IModelDecorationOptions = Object.freeze({
	description: 'diff-inline-deletion-anchor',
	className: 'stanza-diff-inline-removed-empty',
});
