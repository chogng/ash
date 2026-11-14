import './media/screenshotPinnedImage.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ScreenshotToolCompletion } from './screenshotTool.js';
import type { defaultImageEditorTheme } from '../../../services/imageEditor/browser/imageEditorTheme.js';

/** Owns the read-only image and controls inside a detached native image window. */
export async function mountPinnedScreenshot(
	document: Document,
	image: Uint8Array,
	theme: ReturnType<typeof defaultImageEditorTheme>,
	accessibilityHints: boolean,
	complete: (result: ScreenshotToolCompletion) => Promise<boolean>
): Promise<IDisposable> {
	const lifetime = new DisposableStore();
	const root = document.createElement('main');
	root.className = 'ash-pinned-screenshot';
	root.setAttribute('aria-label', localize('screenshot.pinned.title', 'Pinned screenshot'));
	document.title = localize('screenshot.pinned.title', 'Pinned screenshot');
	for (const [key, value] of Object.entries(theme.colors)) {
		root.style.setProperty(`--ash-pinned-${key}`, value);
	}
	root.style.setProperty('--ash-pinned-font-size', theme.metrics.fontSize);
	root.style.setProperty('--ash-pinned-radius', theme.metrics.smallRadius);
	root.style.setProperty('--ash-pinned-spacing', theme.metrics.spacing[2]);
	root.style.setProperty('--ash-pinned-stroke', theme.metrics.borderWidth);
	const toolbar = document.createElement('div');
	toolbar.className = 'ash-pinned-screenshot-toolbar';
	toolbar.setAttribute('role', 'group');
	toolbar.setAttribute('aria-label', localize('screenshot.tools', 'Screenshot tools'));
	const stage = document.createElement('div');
	stage.className = 'ash-pinned-screenshot-stage';
	const picture = document.createElement('img');
	const url = URL.createObjectURL(new Blob([new Uint8Array(image)], { type: 'image/png' }));
	lifetime.add(toDisposable(() => URL.revokeObjectURL(url)));
	picture.src = url;
	picture.alt = localize('screenshot.pinned.image', 'Pinned screenshot. Image contents are not described.');
	stage.append(picture);
	const status = document.createElement('div');
	status.className = 'ash-pinned-screenshot-status';
	status.setAttribute('role', 'status');
	const help = document.createElement('dialog');
	help.className = 'ash-pinned-screenshot-help';
	help.setAttribute('aria-label', localize('screenshot.helpTitle', 'Screenshot Help'));
	const content = document.createElement('textarea');
	content.readOnly = true;
	content.setAttribute('aria-label', localize('screenshot.helpTitle', 'Screenshot Help'));
	const helpText = localize('screenshot.pinned.help', 'This screenshot stays above other windows until closed. Drag the window title bar to move it and resize the window to scale the preview. Copy and Save use the original image including annotations. Tab and Shift+Tab move between controls. Escape closes the pinned screenshot. Alt+F1 opens this help. Alt+F2 reads image dimensions. Image contents are not described.');
	let restoreFocus: HTMLElement | undefined;
	const showHelp = (summary: boolean): void => {
		restoreFocus = document.activeElement as HTMLElement;
		content.value = summary ? localize('screenshot.pinned.dimensions', 'Width {0}, Height {1} pixels. Image contents are not described.', picture.naturalWidth, picture.naturalHeight) : helpText;
		help.showModal();
		content.focus();
	};
	let busy = false;
	const buttons: HTMLButtonElement[] = [];
	const run = async (kind: 'copy' | 'save' | 'cancel'): Promise<void> => {
		if (busy) { return; }
		busy = true;
		for (const button of buttons) { button.disabled = true; }
		try {
			await complete(kind === 'cancel' ? { kind } : { kind, image });
			if (kind === 'copy') { status.textContent = localize('screenshot.pinned.copied', 'Image copied.'); }
		} catch (error) {
			status.textContent = localize('screenshot.failed', 'Screenshot action failed: {0}', String(error));
		} finally {
			busy = false;
			for (const button of buttons) { button.disabled = false; }
		}
	};
	const button = (parent: HTMLElement, label: string, action: () => void): void => {
		const control = document.createElement('button');
		control.type = 'button';
		control.textContent = label;
		lifetime.add(addDisposableListener(control, 'click', action));
		buttons.push(control);
		parent.append(control);
	};
	button(toolbar, localize('screenshot.copy', 'Copy'), () => { void run('copy'); });
	button(toolbar, localize('screenshot.save', 'Save'), () => { void run('save'); });
	button(toolbar, localize('screenshot.helpTitle', 'Screenshot Help'), () => showHelp(false));
	button(toolbar, localize('screenshot.pinned.close', 'Close pinned screenshot'), () => { void run('cancel'); });
	help.append(content);
	button(help, localize('screenshot.closeHelp', 'Close help'), () => help.close());
	lifetime.add(addDisposableListener(help, 'close', () => restoreFocus?.focus()));
	lifetime.add(addDisposableListener(root, 'keydown', (event: KeyboardEvent) => {
		if (help.open) { return; }
		if (event.altKey && (event.key === 'F1' || event.key === 'F2')) {
			event.preventDefault();
			showHelp(event.key === 'F2');
		} else if (event.key === 'Escape') {
			event.preventDefault();
			void run('cancel');
		}
	}));
	root.append(toolbar, stage, status, help);
	document.body.append(root);
	lifetime.add(toDisposable(() => { help.close(); root.remove(); }));
	try {
		await picture.decode();
		buttons[0].focus();
		if (accessibilityHints) {
			status.textContent = localize('screenshot.pinned.hint', 'Pinned screenshot. Press Alt+F1 for help.');
		}
		return lifetime;
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}
