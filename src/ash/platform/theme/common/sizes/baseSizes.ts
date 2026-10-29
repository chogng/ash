import { localize } from '../../../../nls.js';
import { registerSize } from '../sizeRegistry.js';
import { size } from '../sizeUtils.js';

// Import after NLS initialization: registration captures descriptions in the startup language.
// Exports are registered token IDs; numeric values and units remain owned by the size registry.
const owner = 'platform.ui';

/** Registers a pixel length and returns its token ID. */
function length(id: string, value: number, description: string): string {
	return registerSize(id, size(value), { description, owner });
}

/** Registers a unitless value so CSS serialization does not append a length unit. */
function scalar(id: string, value: number, description: string): string {
	return registerSize(id, size(value, 'unitless'), { description, owner });
}

/** Registers an animation duration in milliseconds, independently of the length scale. */
function duration(id: string, value: number, description: string): string {
	return registerSize(id, size(value, 'ms'), { description, owner });
}

// Spacing IDs encode tenths of a pixel (size80 = 8px); zero uses the explicit sizeNone token.
for (const value of [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40]) {
	const name = value === 0 ? 'None' : String(value * 10);
	length(
		`spacing.size${name}`,
		value,
		localize('size.spacing', 'Standard {0}px spacing.', value),
	);
}

// Surface radii increase with prominence; fully rounded shapes use a separate circle token.
export const cornerRadiusXSmall = length(
	'cornerRadius.xSmall',
	2,
	localize('size.cornerRadius.xSmall', 'Radius for very compact elements.'),
);

export const cornerRadiusSmall = length(
	'cornerRadius.small',
	4,
	localize('size.cornerRadius.small', 'Radius for controls.'),
);

export const cornerRadiusMedium = length(
	'cornerRadius.medium',
	6,
	localize('size.cornerRadius.medium', 'Radius for inner surfaces.'),
);

export const cornerRadiusLarge = length(
	'cornerRadius.large',
	8,
	localize('size.cornerRadius.large', 'Radius for prominent surfaces.'),
);

export const cornerRadiusXLarge = length(
	'cornerRadius.xLarge',
	12,
	localize('size.cornerRadius.xLarge', 'Radius for large surfaces.'),
);

export const cornerRadiusXXLarge = length(
	'cornerRadius.xxLarge',
	16,
	localize('size.cornerRadius.xxLarge', 'Radius for extra-large surfaces.'),
);

// An oversized radius lets CSS clamp rounding to the element's bounds without knowing its dimensions.
export const cornerRadiusCircle = length(
	'cornerRadius.circle',
	9999,
	localize('size.cornerRadius.circle', 'Radius for round buttons, dots, and pills.'),
);

// Glyph sizes are independent of the surrounding control's layout and pointer target size.
export const lxiconFontSize = length(
	'lxiconFontSize',
	16,
	localize('size.lxiconFontSize', 'Standard Lxicon glyph size.'),
);

export const lxiconFontSizeCompact = length(
	'lxiconFontSize.compact',
	12,
	localize('size.lxiconFontSize.compact', 'Compact Lxicon glyph size.'),
);

length(
	'lxiconFontSize.large',
	18,
	localize('size.lxiconFontSize.large', 'Large Lxicon glyph size.'),
);

// Typography roles describe text hierarchy; emphasis pairs a size role with a separate weight token.
export const fontSizeHeading1 = length(
	'fontSize.heading1',
	26,
	localize('size.fontSize.heading1', 'Largest heading font size.'),
);

export const fontSizeHeading2 = length(
	'fontSize.heading2',
	18,
	localize('size.fontSize.heading2', 'Title heading font size.'),
);

export const fontSizeHeading3 = length(
	'fontSize.heading3',
	13,
	localize('size.fontSize.heading3', 'Subtitle heading font size.'),
);

export const fontSizeBody1 = length(
	'fontSize.body1',
	13,
	localize('size.fontSize.body1', 'Primary body font size.'),
);

export const fontSizeBody2 = length(
	'fontSize.body2',
	11,
	localize('size.fontSize.body2', 'Secondary body font size.'),
);

export const fontSizeLabel1 = length(
	'fontSize.label1',
	12,
	localize('size.fontSize.label1', 'Section title and tab label font size.'),
);

export const fontSizeLabel2 = length(
	'fontSize.label2',
	11,
	localize('size.fontSize.label2', 'Metadata label font size.'),
);

export const fontSizeLabel3 = length(
	'fontSize.label3',
	10,
	localize('size.fontSize.label3', 'Badge label font size.'),
);

export const fontWeightRegular = scalar(
	'fontWeight.regular',
	400,
	localize('size.fontWeight.regular', 'Regular font weight for un-emphasized text.'),
);

export const fontWeightSemiBold = scalar(
	'fontWeight.semiBold',
	600,
	localize(
		'size.fontWeight.semiBold',
		'Strong font weight paired with any font-size role for tabs, headings, and emphasized text.',
	),
);

export const strokeThickness = length(
	'strokeThickness',
	1,
	localize('size.strokeThickness', 'Standard UI border thickness.'),
);

// Shared motion timings let components choose an emphasis level without inventing per-widget durations.
export const animationDurationFast = duration(
	'animation.durationFast',
	120,
	localize('size.animation.durationFast', 'Short UI state transition duration.'),
);

export const animationDurationNormal = duration(
	'animation.durationNormal',
	200,
	localize('size.animation.durationNormal', 'Standard UI animation duration.'),
);

export const animationDurationSlow = duration(
	'animation.durationSlow',
	350,
	localize('size.animation.durationSlow', 'Emphasized UI animation duration.'),
);

// Component geometry complements the generic scales when a widget needs a shared layout contract.
export const tabHeight = length(
	'tab.height',
	24,
	localize('size.tab.height', 'Standard height for TabList tabs.'),
);
// CSS defaults; row delegates and action hosts own the corresponding layout geometry.
length(
	'list.rowHeight',
	22,
	localize('size.list.rowHeight', 'Standard height for single-line list and tree rows.'),
);

export const tabListContentInset = length(
	'tabList.contentInset',
	4,
	localize('size.tabList.contentInset', 'Horizontal inset between an inset TabList and its first or last tab.'),
);

export const tabListItemContentInset = length(
	'tabList.itemContentInset',
	6,
	localize('size.tabList.itemContentInset', "Horizontal inset between a TabList item's edge and its label content."),
);

export const compositeBarContentInset = length(
	'compositeBar.contentInset',
	4,
	localize('size.compositeBar.contentInset', 'Horizontal inset between a CompositeBar and its first or last action.'),
);

export const paneTitleHeight = length(
	'pane.titleHeight',
	32,
	localize('size.pane.titleHeight', 'Standard height for a Workbench pane title.'),
);

export const actionBarGap = length(
	'actionBar.gap',
	2,
	localize('size.actionBar.gap', 'Gap between action bar items.'),
);

export const toolbarItemGap = length(
	'toolbar.itemGap',
	2,
	localize('size.toolbar.itemGap', 'Gap before a toolbar item.'),
);

export const toolbarActionSize = length(
	'toolbar.actionSize',
	22,
	localize('size.toolbar.actionSize', 'Standard square hit area for toolbar icon actions.'),
);

export const scrollbarSize = length(
	'scrollbar.size',
	10,
	localize('size.scrollbar.size', 'Default scrollbar thickness.'),
);

export const treeIndent = length(
	'tree.indent',
	8,
	localize('size.tree.indent', 'Default tree nesting indentation.'),
);

// Keep the separator's pointer target independent of its visible hover feedback thickness.
export const sashDragAreaSize = length(
	'sash.dragAreaSize',
	4,
	localize('size.sash.dragAreaSize', 'Default pointer target size for draggable Sash separators.'),
);

export const sashHoverFeedbackSize = length(
	'sash.hoverFeedbackSize',
	1,
	localize('size.sash.hoverFeedbackSize', 'Default visible feedback size for hovered Sash separators.'),
);

export const modalEditorWidth = length(
	'modalEditor.width',
	960,
	localize('size.modalEditor.width', 'Preferred modal editor width.'),
);

export const modalEditorHeight = length(
	'modalEditor.height',
	720,
	localize('size.modalEditor.height', 'Preferred modal editor height.'),
);
