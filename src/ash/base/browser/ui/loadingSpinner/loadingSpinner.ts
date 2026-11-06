import './loadingSpinner.css';
import { h } from '../../dom.js';

/** Creates a decorative loading ring. The caller owns the accessible loading state. */
export function createLoadingSpinner(document: Document, size: 'default' | 'large' = 'default'): HTMLSpanElement {
	return h(document, 'span', {
		className: size === 'large' ? 'ash-loading-spinner large' : 'ash-loading-spinner',
		attributes: { 'aria-hidden': 'true' },
	});
}
