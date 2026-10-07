import './pixelSpinner.css';
import { addDisposableListener, h } from '../../dom.js';
import { observeIntersection } from '../../observer.js';
import { mainWindow } from '../../window.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../common/lifecycle.js';

export interface IPixelSpinnerOptions {
	readonly ariaLabel?: string;
	readonly variant?: 'grid' | 'ring';
}

export interface IPixelSpinner extends IDisposable {
	readonly element: HTMLElement;
}

/** Creates a current-color loading indicator; its owner disposes it when work finishes. */
export function createPixelSpinner(parent?: HTMLElement, options?: IPixelSpinnerOptions): IPixelSpinner {
	const element = h(mainWindow.document, 'span');
	element.className = 'ash-pixel-spinner';
	element.classList.toggle('ash-pixel-spinner-ring', options?.variant === 'ring');
	if (options?.ariaLabel) {
		element.setAttribute('role', 'status');
		element.setAttribute('aria-label', options.ariaLabel);
	} else {
		element.setAttribute('aria-hidden', 'true');
	}
	element.append(...Array.from({ length: 4 }, () => h(mainWindow.document, 'i')));
	parent?.append(element);
	const resources = new DisposableStore();
	resources.add(toDisposable(() => element.remove()));
	let isVisible = true;
	const updateAnimation = (): void => {
		element.classList.toggle('paused', element.ownerDocument.hidden || !isVisible);
	};
	resources.add(addDisposableListener(element.ownerDocument, 'visibilitychange', updateAnimation));
	resources.add(observeIntersection(element, entry => {
		isVisible = entry.isIntersecting;
		updateAnimation();
	}));
	updateAnimation();
	return Object.assign(toDisposable(() => resources.dispose()), { element });
}
