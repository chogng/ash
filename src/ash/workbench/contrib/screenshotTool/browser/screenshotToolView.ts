import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { ImageViewCompletion as ImageEditorCompletion } from '../../../../platform/imageView/common/imageView.js';
import type { CodeImageSnapshot } from '../../../services/imageEditor/common/imageEditorService.js';
import type { readImageEditorTheme } from '../../../services/imageEditor/browser/imageEditorTheme.js';
export interface ScreenshotToolInput {
	readonly image?: Uint8Array;
	readonly code?: CodeImageSnapshot;
	readonly defaultAction: 'copy' | 'attach';
	readonly canRetake: boolean;
	readonly theme: ReturnType<typeof readImageEditorTheme>;
	readonly colorScheme: string;
	readonly state?: { readonly help: string; readonly accessibilityHints?: boolean; readonly code?: Parameters<typeof renderCodeImage>[2]; };
}
import { ScreenshotAnnotationEditor } from './screenshotAnnotation.js';
import { renderCodeImage } from './codeImage.js';

/** Mounts the product component directly; extension HTML keeps its separate sandbox. */
export async function mountScreenshotTool(document: Document, input: ScreenshotToolInput, complete: (result: ImageEditorCompletion) => Promise<boolean>, signal: AbortSignal) {
	const state = input.state;
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
	};
	const image = input.code ? await renderCodeImage(document, input.code, state!.code!) : input.image!;
	const editor = await ScreenshotAnnotationEditor.create(document, image, {
		defaultAction: input.defaultAction,
		canRetake: input.canRetake,
		accessibilityHints: state?.accessibilityHints !== false,
		help: state?.help ?? '',
		selectEntire: !!input.code,
		description: input.code ? input.code.lines.map(line => line.map(token => token.text).join('')).join('\n') : undefined,
		complete,
	});
	if (signal.aborted) { editor.dispose(); signal.throwIfAborted(); }
	for (const [key, value] of Object.entries(appearance)) editor.element.style.setProperty(`--snapshot-${key}`, value);
	for (const [index, value] of metrics.spacing.entries()) editor.element.style.setProperty(`--snapshot-spacing-${index + 1}`, value);
	editor.element.dataset.colorScheme = input.colorScheme;
	return editor;
}
