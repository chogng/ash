import type { ImageEditorInput, ImageEditorCompletion, ImageEditorPermissionAction } from '@ash/sdk';
import { ScreenshotEditor } from './screenshotEditor.js';
import { renderCodeImage } from './codeImage.js';
import { setMessages } from '../common/nls.js';
import { addDisposableListener, DisposableStore } from './lifecycle.js';
import { createScreenPermissionGuide } from './permissionGuide.js';

const lifetime = new DisposableStore();
let editor: ScreenshotEditor | undefined;
let completion: { resolve(value: boolean): void; reject(error: Error): void; } | undefined;
const permissionResults = new Map<ImageEditorPermissionAction, { resolve(value: boolean): void; reject(error: Error): void; }>();
let initialized = false;
lifetime.add(addDisposableListener(window, 'message', event => {
	if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
	if (event.data.type === 'completed') {
		if (event.data.error) completion?.reject(new Error(event.data.error)); else completion?.resolve(event.data.accepted === true);
		completion = undefined;
	} else if (event.data.type === 'permissionResult') {
		const result = permissionResults.get(event.data.action);
		permissionResults.delete(event.data.action);
		if (event.data.error) result?.reject(new Error(event.data.error));
		else result?.resolve(event.data.accepted === true);
	} else if (event.data.type === 'initialize' && !initialized) {
		initialized = true;
		void open(event.data as ImageEditorInput).catch(error => { parent.postMessage({ type: 'complete', result: { kind: 'error', message: String(error).slice(0, 4096) } }, '*'); });
	}
}));
lifetime.add(addDisposableListener(window, 'pagehide', () => { editor?.dispose(); lifetime.dispose(); }));
parent.postMessage({ type: 'initialize' }, '*');

async function open(input: ImageEditorInput): Promise<void> {
	const state = input.state as { messages?: Record<string, string>; help?: string; accessibilityHints?: boolean; code?: Parameters<typeof renderCodeImage>[2]; } | undefined;
	setMessages(state?.messages ?? {});
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
	for (const [key, value] of Object.entries(appearance)) document.documentElement.style.setProperty(`--snapshot-${key}`, value);
	for (const [index, value] of metrics.spacing.entries()) document.documentElement.style.setProperty(`--snapshot-spacing-${index + 1}`, value);
	document.documentElement.dataset.colorScheme = input.colorScheme;
	if (input.permission) {
		lifetime.add(createScreenPermissionGuide(document, input.permission, state?.accessibilityHints !== false, (action: ImageEditorPermissionAction) => {
			// A native drag must start while the mouse is held, even if opening Settings is still pending.
			if (permissionResults.has(action)) return Promise.resolve(false);
			return new Promise<boolean>((resolve, reject) => {
				permissionResults.set(action, { resolve, reject });
				parent.postMessage({ type: 'permission', action }, '*');
			});
		}));
		parent.postMessage({ type: 'ready' }, '*');
		return;
	}
	const image = input.code ? await renderCodeImage(document, input.code, state!.code!) : input.image!;
	editor = await ScreenshotEditor.create(document, image, {
		defaultAction: input.defaultAction,
		accessibilityHints: state?.accessibilityHints !== false,
		help: state?.help ?? '',
		selectEntire: !!input.code,
		description: input.code ? input.code.lines.map(line => line.map(token => token.text).join('')).join('\n') : undefined,
		complete: (result: ImageEditorCompletion) => new Promise<boolean>((resolve, reject) => {
			completion = { resolve, reject };
			parent.postMessage({ type: 'complete', result }, '*');
		}),
	});
	parent.postMessage({ type: 'ready' }, '*');
}
