import { getWindow } from '../../../base/browser/dom.js';

export const ACTION_WIDGET_ANIMATED_CLASS = 'ash-action-widget-animated';
export const ACTION_WIDGET_DROPDOWN_MOTION_CLASS = 'ash-action-widget-dropdown-motion';
export const ACTION_WIDGET_DROPDOWN_MOTION_CLOSING_CLASS = 'ash-action-widget-dropdown-closing';

/** Layout must measure the final geometry rather than the entrance transform. */
export function finishActionWidgetOpeningAnimation(widget: HTMLElement): void {
	const cssAnimation = getWindow(widget).CSSAnimation;
	if (!cssAnimation) {
		return;
	}
	const opening = widget.getAnimations().filter(animation =>
		animation instanceof cssAnimation && animation.animationName === 'ash-action-widget-scale-open');
	opening.forEach(animation => animation.finish());
}
