import katex from 'katex';
import 'katex/dist/katex.min.css';
import '../media/markdown.css';

const api = acquireVsCodeApi();
const root = document.getElementById('markdown-preview');

function equal(current, next) {
	if (current instanceof Element && next instanceof Element && current.hasAttribute('data-math')) {
		return current.getAttribute('data-math') === next.getAttribute('data-math') && current.getAttribute('data-display') === next.getAttribute('data-display');
	}
	return current.isEqualNode(next);
}

/** Preserve unchanged subtrees, including selection, focused links and rendered math. */
function patch(parent, next) {
	const current = [...parent.childNodes];
	const incoming = [...next.childNodes];
	let start = 0;
	while (start < current.length && start < incoming.length && equal(current[start], incoming[start])) start++;
	let end = current.length;
	let nextEnd = incoming.length;
	while (end > start && nextEnd > start && equal(current[end - 1], incoming[nextEnd - 1])) { end--; nextEnd--; }
	const count = Math.max(end - start, nextEnd - start);
	for (let index = 0; index < count; index++) {
		const old = index < end - start ? current[start + index] : undefined;
		const replacement = index < nextEnd - start ? incoming[start + index] : undefined;
		if (!replacement) { old.remove(); continue; }
		if (!old) { parent.insertBefore(replacement, current[end] ?? null); continue; }
		if (equal(old, replacement)) continue;
		if (old instanceof Element && replacement instanceof Element && old.tagName === replacement.tagName && old.attributes.length === replacement.attributes.length && [...old.attributes].every(attribute => replacement.getAttribute(attribute.name) === attribute.value) && !old.hasAttribute('data-math')) {
			patch(old, replacement);
		} else { old.replaceWith(replacement); }
	}
}

window.addEventListener('message', event => {
	if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
	if (event.data.type === 'theme' && typeof event.data.variables === 'string') { document.documentElement.style.cssText = event.data.variables; return; }
	if (event.data.type !== 'preview' || typeof event.data.html !== 'string') return;
	const content = document.createElement('template');
	content.innerHTML = event.data.html;
	const scroll = document.scrollingElement;
	const top = scroll.scrollTop;
	patch(root, content.content);
	for (const element of root.querySelectorAll('[data-math]:not([data-rendered])')) {
		katex.render(element.dataset.math, element, { displayMode: element.dataset.display === 'true', throwOnError: false, trust: false });
		element.dataset.rendered = 'true';
	}
	scroll.scrollTop = top;
});

document.addEventListener('click', event => {
	const link = event.target.closest('a');
	if (!link) return;
	event.preventDefault();
	const href = link.getAttribute('href');
	if (href?.startsWith('#')) {
		let fragment;
		try { fragment = decodeURIComponent(href.slice(1)).toLowerCase(); } catch { return; }
		const target = document.getElementById(fragment);
		if (target && root.contains(target)) { target.scrollIntoView(); target.tabIndex = -1; target.focus({ preventScroll: true }); }
	} else { api.postMessage({ href }); }
});
api.postMessage({ type: 'ready' });
