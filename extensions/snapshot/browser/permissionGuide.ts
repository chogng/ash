import type { ImageEditorInput, ImageEditorPermissionAction } from '@ash/sdk';
import { addDisposableListener, DisposableStore, toDisposable } from './lifecycle.js';
import { localize } from '../common/nls.js';
import './permissionGuide.css';

/** A modeless companion: native consent remains in System Settings, with a keyboard alternative to dragging. */
export function createScreenPermissionGuide(
	document: Document,
	initial: NonNullable<ImageEditorInput['permission']>,
	accessibilityHints: boolean,
	action: (action: ImageEditorPermissionAction) => Promise<boolean>,
): DisposableStore {
	const lifetime = new DisposableStore();
	const window = document.defaultView!;
	let disposed = false;
	lifetime.add(
		toDisposable(() => {
			disposed = true;
		}),
	);

	const domNode = document.createElement('main');
	domNode.className = 'screen-permission-guide';
	const status = document.createElement('span');
	status.textContent = localize('screenshot.permission.dragHint', 'Drag to Add · Click to Copy Path');
	status.setAttribute('role', 'status');
	status.setAttribute('aria-atomic', 'true');
	const run = async (kind: ImageEditorPermissionAction): Promise<boolean> => {
		try {
			return await action(kind);
		} catch {
			if (!disposed)
				status.textContent = localize(
					'screenshot.permission.failed',
					'The action could not be completed. Please try again.',
				);
			return false;
		}
	};
	const button = (label: string, parent: HTMLElement, clicked: () => void): HTMLButtonElement => {
		const element = document.createElement('button');
		element.type = 'button';
		element.textContent = label;
		lifetime.add(addDisposableListener(element, 'click', clicked));
		parent.append(element);
		return element;
	};
	const card = button('', domNode, () => {
		void run('copyPath').then(copied => {
			if (!copied || disposed) return;
			status.textContent = localize('screenshot.permission.copied', 'Application path copied.');
		});
	});
	card.className = 'screen-permission-app';
	card.draggable = true;
	card.setAttribute(
		'aria-label',
		localize(
			'screenshot.permission.cardLabel',
			'{0}. Drag to System Settings, or press Enter to copy the application path.',
			initial.applicationName,
		),
	);
	const icon = document.createElement('img');
	icon.alt = '';
	icon.draggable = false;
	const iconUrl = URL.createObjectURL(new Blob([new Uint8Array(initial.icon)], { type: 'image/png' }));
	icon.src = iconUrl;
	lifetime.add(toDisposable(() => URL.revokeObjectURL(iconUrl)));
	const label = document.createElement('span');
	label.className = 'screen-permission-app-label';
	const name = document.createElement('strong');
	name.textContent = initial.applicationName;
	name.title = initial.applicationName;
	label.append(name, status);
	card.append(icon, label);
	lifetime.add(
		addDisposableListener(card, 'dragstart', event => {
			event.preventDefault();
			void run('drag');
		}),
	);
	// Plain text and native dialog semantics keep the isolated guide directly readable.
	const help = document.createElement('dialog');
	help.className = 'screen-permission-help';
	const helpTitle = document.createElement('h2');
	helpTitle.id = 'screen-permission-help-title';
	helpTitle.textContent = localize('screenshot.permission.helpTitle', 'Screen Permission Help');
	help.setAttribute('aria-labelledby', helpTitle.id);
	const helpText = document.createElement('p');
	helpText.textContent = localize(
		'screenshot.permission.help',
		'System Settings opens automatically. Drag the app card into the upper Screen & System Audio Recording list and enable it. For keyboard access, press Enter on the app card to copy its path, use + in System Settings, press ⌘⇧G and paste the path. Return to Ash after granting permission to continue the screenshot automatically. If macOS asks you to reopen Ash, follow its prompt. Escape closes this guide.',
	);
	help.append(helpTitle, helpText);
	button(localize('screenshot.permission.closeHelp', 'Close Help'), help, () => help.close());
	lifetime.add(
		addDisposableListener(window, 'keydown', event => {
			if (event.altKey && event.key === 'F1') {
				event.preventDefault();
				if (!help.open) help.showModal();
			} else if (event.key === 'Escape' && !help.open) {
				event.preventDefault();
				void run('cancel');
			}
		}),
	);
	if (accessibilityHints) {
		const helpHint = document.createElement('p');
		helpHint.className = 'screen-permission-help-hint';
		helpHint.id = 'screen-permission-help-hint';
		helpHint.textContent = localize('screenshot.permission.helpHint', 'Press Option+F1 for keyboard help.');
		card.setAttribute('aria-describedby', helpHint.id);
		domNode.append(helpHint);
	}
	document.body.append(domNode, help);
	document.body.classList.add('screen-permission-window');
	card.focus();
	lifetime.add(
		toDisposable(() => {
			if (help.open) help.close();
			help.remove();
			domNode.remove();
			document.body.classList.remove('screen-permission-window');
		}),
	);
	return lifetime;
}
