import type { ValidDiffEditorBaseOptions } from './editorOptions.js';

/** Default options shared by side-by-side and inline diff hosts. */
export const diffEditorDefaultOptions = Object.freeze({
	enableSplitViewResizing: true,
	splitViewDefaultRatio: 0.5,
	renderSideBySide: true,
	renderMarginRevertIcon: true,
	renderGutterMenu: true,
	maxComputationTime: 5_000,
	maxFileSize: 50,
	ignoreTrimWhitespace: true,
	renderIndicators: true,
	originalEditable: false,
	diffCodeLens: false,
	renderOverviewRuler: true,
	diffWordWrap: 'inherit' as const,
	diffAlgorithm: 'advanced' as const,
	accessibilityVerbose: false,
	experimental: Object.freeze({
		showMoves: false,
		showEmptyDecorations: true,
		useTrueInlineView: false,
	}),
	hideUnchangedRegions: Object.freeze({
		enabled: false,
		contextLineCount: 3,
		minimumLineCount: 3,
		revealLineCount: 20,
	}),
	isInEmbeddedEditor: false,
	onlyShowAccessibleDiffViewer: false,
	renderSideBySideInlineBreakpoint: 900,
	useInlineViewWhenSpaceIsLimited: true,
	compactMode: false,
	hideOriginalLineNumbers: false,
}) satisfies ValidDiffEditorBaseOptions;
