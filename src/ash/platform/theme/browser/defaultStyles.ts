import type { IFindWidgetStyles } from '../../../base/browser/ui/tree/abstractTree.js';
import type { IProgressBarStyles } from '../../../base/browser/ui/progressbar/progressbar.js';
import type { IToggleStyles, ICheckboxStyles } from '../../../base/browser/ui/toggle/toggle.js';
import type { IListStyles } from '../../../base/browser/ui/list/listWidget.js';
import type { IMenuStyles } from '../../../base/browser/ui/menu/menu.js';
import type { ISelectBoxStyles } from '../../../base/browser/ui/selectbox/selectbox.js';
import type { IDialogStyles } from '../../../base/browser/ui/dialog/dialog.js';
import type { IKeybindingLabelStyles } from '../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import type { ICountBadgeStyles } from '../../../base/browser/ui/countBadge/countBadge.js';
import type { IInputBoxStyles } from '../../../base/browser/ui/inputbox/inputbox.js';
import type { IButtonStyles } from '../../../base/browser/ui/button/button.js';
import type { IBreadcrumbsWidgetStyles } from '../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { colorCssVariable } from '../common/colorUtils.js';
import type { ColorIdentifier } from '../common/colorRegistry.js';
import { descriptionForeground, foreground, widgetBorder } from '../common/colors/baseColors.js';
import { buttonForeground, buttonHoverBackground, buttonSecondaryBackground, primaryButtonBackground, primaryButtonForeground, primaryButtonHoverBackground } from '../common/colors/inputColors.js';

/** Overrides name registered colors; widgets receive CSS values and stay independent of platform services. */
export type IStyleOverride<T> = { readonly [P in keyof T]?: ColorIdentifier | undefined };

function colorVariable(id: ColorIdentifier): string {
	return `var(${colorCssVariable(id)})`;
}

function withOverrides<T extends { readonly [P in keyof T]: string | undefined }>(defaults: T, overrides: IStyleOverride<T>): T {
	const result = { ...defaults };
	for (const key of Object.keys(overrides) as (keyof T)[]) {
		const id = overrides[key];
		Object.assign(result, { [key]: id === undefined ? undefined : colorVariable(id) });
	}
	return result;
}

/** CSS references let retained controls follow the containing theme without per-widget listeners. */
export const defaultButtonStyles: IButtonStyles = Object.freeze({
	buttonForeground: colorVariable(primaryButtonForeground),
	buttonBackground: colorVariable(primaryButtonBackground),
	buttonHoverBackground: colorVariable(primaryButtonHoverBackground),
	buttonSecondaryForeground: colorVariable(buttonForeground),
	buttonSecondaryBackground: colorVariable(buttonSecondaryBackground),
	buttonSecondaryHoverBackground: colorVariable(buttonHoverBackground),
	buttonSecondaryBorder: colorVariable(widgetBorder),
	buttonBorder: undefined,
});

/** Explicit `undefined` clears a default so the widget can use its own presentation fallback. */
export function getButtonStyles(overrides: IStyleOverride<IButtonStyles>): IButtonStyles {
	return withOverrides(defaultButtonStyles, overrides);
}

export const defaultBreadcrumbsWidgetStyles: IBreadcrumbsWidgetStyles = Object.freeze({
	breadcrumbsBackground: undefined,
	breadcrumbsForeground: colorVariable(descriptionForeground),
	breadcrumbsHoverForeground: colorVariable(foreground),
	breadcrumbsFocusForeground: colorVariable(foreground),
	breadcrumbsFocusAndSelectionForeground: colorVariable(foreground),
});

export const defaultInputBoxStyles: IInputBoxStyles = Object.freeze({
	inputBackground: colorVariable('input.background'),
	inputForeground: colorVariable('input.foreground'),
	inputBorder: colorVariable('input.border'),
});

export const defaultCountBadgeStyles: ICountBadgeStyles = Object.freeze({
	badgeBackground: colorVariable('badge.background'),
	badgeForeground: colorVariable('badge.foreground'),
	badgeBorder: colorVariable('contrastBorder'),
});

export const defaultKeybindingLabelStyles: IKeybindingLabelStyles = Object.freeze({
	keybindingLabelBackground: colorVariable('keybindingLabel.background'),
	keybindingLabelForeground: colorVariable('keybindingLabel.foreground'),
	keybindingLabelBorder: colorVariable('keybindingLabel.border'),
	keybindingLabelBottomBorder: undefined,
	keybindingLabelShadow: undefined,
});

export const defaultDialogStyles: IDialogStyles = Object.freeze({
	dialogForeground: colorVariable('foreground'),
	dialogBackground: colorVariable('dialog.background'),
	dialogBorder: colorVariable('dialog.border'),
	dialogShadow: colorVariable('dialog.shadow'),
	errorIconForeground: colorVariable('error.foreground'),
	warningIconForeground: colorVariable('warning.foreground'),
	infoIconForeground: colorVariable('foreground'),
	textLinkForeground: colorVariable('textLink.foreground'),
});

export const defaultSelectBoxStyles: ISelectBoxStyles = Object.freeze({
	selectBackground: colorVariable('input.background'),
	selectForeground: colorVariable('input.foreground'),
	selectBorder: colorVariable('input.border'),
	selectListBackground: colorVariable('input.background'),
	focusBorder: colorVariable('focusBorder'),
});

export const defaultMenuStyles: IMenuStyles = Object.freeze({
	foregroundColor: colorVariable('menu.foreground'),
	backgroundColor: colorVariable('menu.background'),
	selectionForegroundColor: colorVariable('menu.selectionForeground'),
	selectionBackgroundColor: colorVariable('menu.selectionBackground'),
	borderColor: colorVariable('border'),
	separatorColor: colorVariable('border'),
	shadowColor: colorVariable('widget.shadow'),
});

export const defaultListStyles: IListStyles = Object.freeze({
	listBackground: undefined,
	listActiveSelectionBackground: colorVariable('list.activeSelectionBackground'),
	listActiveSelectionForeground: colorVariable('list.activeSelectionForeground'),
	listInactiveSelectionBackground: colorVariable('list.inactiveSelectionBackground'),
	listHoverBackground: colorVariable('list.hoverBackground'),
	listFocusOutline: colorVariable('focusBorder'),
	treeIndentGuidesStroke: colorVariable('tree.indentGuidesStroke'),
	treeInactiveIndentGuidesStroke: colorVariable('tree.inactiveIndentGuidesStroke'),
});

export const defaultProgressBarStyles: IProgressBarStyles = Object.freeze({
	progressBarBackground: colorVariable('accent.background'),
});

export const defaultToggleStyles: IToggleStyles = Object.freeze({
	inputActiveOptionBorder: colorVariable('accent.background'),
	inputActiveOptionForeground: colorVariable('button.primaryForeground'),
	inputActiveOptionBackground: colorVariable('accent.background'),
});

export const defaultCheckboxStyles: ICheckboxStyles = Object.freeze({
	checkboxBackground: colorVariable('input.background'),
	checkboxBorder: colorVariable('input.border'),
	checkboxForeground: colorVariable('input.foreground'),
});

export const defaultFindWidgetStyles: IFindWidgetStyles = Object.freeze({
	listFilterWidgetBackground: colorVariable('menu.background'),
	listFilterWidgetOutline: colorVariable('widget.border'),
	listFilterWidgetNoMatchesOutline: colorVariable('error.foreground'),
	listFilterWidgetShadow: undefined,
	inputBoxStyles: defaultInputBoxStyles,
	buttonStyles: defaultButtonStyles,
});
