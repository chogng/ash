import type { CodeImageSnapshot } from '../../../services/imageEditor/common/imageEditorService.js';
import type { readImageEditorTheme } from '../../../services/imageEditor/browser/imageEditorTheme.js';
import { renderCodeImage } from './codeImage.js';
import { ScreenshotAnnotationEditor } from './screenshotAnnotation.js';
import type { ScreenshotToolCompletion } from './screenshotTool.js';
import type { IScreenshotRect } from './screenshotSelection.js';
import { localize } from '../../../../nls.js';

export interface ScreenshotToolInput {
	readonly agentWindow?: boolean;
	readonly image?: Uint8Array;
	readonly windowBounds?: readonly IScreenshotRect[];
	readonly code?: CodeImageSnapshot;
	readonly defaultAction: 'copy' | 'attach';
	readonly canRetake: boolean;
	readonly canPin?: boolean;
	readonly theme: ReturnType<typeof readImageEditorTheme>;
	readonly colorScheme: string;
	readonly state?: { readonly help: string; readonly accessibilityHints?: boolean; readonly code?: Parameters<typeof renderCodeImage>[2]; };
}

/** Mounts the product component directly; extension HTML keeps its separate sandbox. */
export async function mountScreenshotTool(document: Document, input: ScreenshotToolInput, complete: (result: ScreenshotToolCompletion) => Promise<boolean>, signal: AbortSignal, container = document.body) {
	const state = input.state;
	const help = state?.help ?? '';
	signal.throwIfAborted();
	const { colors, metrics } = input.theme;
	const appearance = {
		foreground: colors.foreground,
		background: colors.background,
		'panel-background': colors.panelBackground,
		'selection-mask': colors.selectionMask,
		border: colors.border,
		'focus-border': colors.focusBorder,
		'contrast-border': colors.contrastBorder,
		'input-background': colors.inputBackground,
		'input-foreground': colors.inputForeground,
		'input-border': colors.inputBorder,
		'hover-background': colors.hoverBackground,
		'button-background': colors.buttonBackground,
		'button-foreground': colors.buttonForeground,
		'font-size': metrics.fontSize,
		'label-font-size': metrics.labelFontSize,
		'heading-font-size': metrics.headingFontSize,
		'border-width': metrics.borderWidth,
		'small-radius': metrics.smallRadius,
		'large-radius': metrics.largeRadius,
		shadow: input.theme.shadow,
		'spacing-1': metrics.spacing[0],
		'spacing-2': metrics.spacing[1],
		'spacing-3': metrics.spacing[2],
		'spacing-4': metrics.spacing[3],
	};
	const image = input.code ? await renderCodeImage(document, input.code, state!.code!) : input.image!;
	const editor = await ScreenshotAnnotationEditor.create(document, image, {
		agentWindow: input.agentWindow,
		container,
		windowBounds: input.windowBounds,
		appearance,
		colorScheme: input.colorScheme,
		defaultAction: input.agentWindow ? 'copy' : input.defaultAction,
		canRetake: input.canRetake,
		canPin: input.canPin,
		accessibilityHints: state?.accessibilityHints !== false,
		help: input.windowBounds?.length
			? help + '\n' + localize('screenshot.windowHelp', 'Point to a window to preview its bounds. Click to select it, or drag to make a custom selection. With the selection surface focused, Up and Down Arrow cycle through windows before a region is selected. Enter selects the previewed window. The window selection captures the pixels visible on this display.')
			: help,
		selectEntire: !!input.code,
		description: input.code ? input.code.lines.map(line => line.map(token => token.text).join('')).join('\n') : undefined,
		complete,
	});
	if (signal.aborted) { editor.dispose(); signal.throwIfAborted(); }
	return editor;
}
