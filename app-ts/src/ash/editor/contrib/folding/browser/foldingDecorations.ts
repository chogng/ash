import type { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon, themeColorFromId } from '../../../../base/common/themables.js';
import { foldBackground } from '../../../../platform/theme/common/colors/editorColors.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { MinimapPosition, TrackedRangeStickiness, type IModelDecorationOptions, type IModelDecorationsChangeAccessor } from '../../../common/model.js';
import type { IDecorationProvider } from './foldingModel.js';

export const foldingExpandedIcon = registerIcon('folding-expanded', Lxicon.chevronDown, 'Icon for an expanded folding range');
export const foldingCollapsedIcon = registerIcon('folding-collapsed', Lxicon.chevronRight, 'Icon for a collapsed folding range');
export const foldingManualCollapsedIcon = registerIcon('folding-manual-collapsed', foldingCollapsedIcon, 'Icon for a manually collapsed folding range');
export const foldingManualExpandedIcon = registerIcon('folding-manual-expanded', foldingExpandedIcon, 'Icon for a manually expanded folding range');

const collapsedTooltip = 'Expand folded range';
const expandedTooltip = 'Collapse range';
const highlighted = Object.freeze({
	className: 'folded-background',
	minimap: { color: themeColorFromId(foldBackground), position: MinimapPosition.Inline },
});

/** Selects folding presentation and delegates its decoration transaction to one editor. */
export class FoldingDecorationProvider implements IDecorationProvider {
	public showFoldingControls: 'always' | 'never' | 'mouseover' = 'mouseover';
	public showFoldingHighlights = true;

	constructor(private readonly editor: ICodeEditor) {}

	getDecorationOption(isCollapsed: boolean, isHidden: boolean, isManual: boolean): IModelDecorationOptions {
		if (isHidden) return hiddenRange;
		if (isCollapsed) {
			const icon = this.showFoldingControls === 'never'
				? undefined
				: isManual ? foldingManualCollapsedIcon : foldingCollapsedIcon;
			return foldingOption(
				isManual ? 'folding-manually-collapsed' : 'folding-collapsed',
				TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
				collapsedTooltip,
				icon,
				this.showFoldingHighlights,
			);
		}
		if (this.showFoldingControls === 'never') return expandedWithoutControls;
		const icon = isManual ? foldingManualExpandedIcon : foldingExpandedIcon;
		const alwaysVisible = this.showFoldingControls === 'always' || isManual;
		return foldingOption(
			isManual ? 'folding-manually-expanded' : 'folding-expanded',
			isManual ? TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges : TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			expandedTooltip,
			icon,
			false,
			alwaysVisible,
		);
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null {
		return this.editor.changeDecorations(callback);
	}

	removeDecorations(decorationIds: string[]): void {
		this.editor.removeDecorations(decorationIds);
	}
}

const hiddenRange = Object.freeze<IModelDecorationOptions>({
	description: 'folding-hidden-range',
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
});

const expandedWithoutControls = Object.freeze<IModelDecorationOptions>({
	description: 'folding-no-controls-expanded',
	stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
	isWholeLine: true,
});

function foldingOption(
	description: string,
	stickiness: TrackedRangeStickiness,
	tooltip: string,
	icon: Icon | undefined,
	highlight: boolean,
	alwaysVisible = false,
): IModelDecorationOptions {
	return Object.freeze({
		description,
		stickiness,
		isWholeLine: true,
		linesDecorationsTooltip: tooltip,
		...(icon ? {
			firstLineDecorationClassName: `${alwaysVisible ? 'alwaysShowFoldIcons ' : ''}${ThemeIcon.asClassName(icon)}`,
			firstLineDecorationIcon: icon,
		} : {}),
		...(isCollapsedDescription(description) ? { afterContentClassName: 'inline-folded' } : {}),
		...(highlight ? highlighted : {}),
	});
}

function isCollapsedDescription(description: string): boolean {
	return description.endsWith('-collapsed');
}
