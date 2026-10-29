import './lxicon.css';
import '../../../common/lxicons.js';
import { Icon, type IconDefinition } from '../../../common/icon.js';
import { getLxiconDefinition } from '../../../common/lxiconsUtil.js';
import { setAriaAttribute } from '../aria/aria.js';
import { h } from '../../dom.js';
const iconResolversByDocument = new WeakMap<Document, (icon: Icon) => IconDefinition | undefined>();
const mountedIcons = new WeakSet<HTMLSpanElement>();

/** Mounts a decorative font icon whose node survives product-theme changes. */
export function appendIcon(icon: Icon, container: HTMLElement): HTMLSpanElement {
	const definition = resolveDefinition(icon, container.ownerDocument);
	const element = h(container.ownerDocument, 'span');
	element.classList.add('ash-icon', `ash-icon-${icon.id}`);
	setAriaAttribute(element, 'hidden', true);
	element.dataset.ashIconId = icon.id;
	container.append(element);
	renderDefinition(element, definition);
	return element;
}

/** Updates a document's mounted icons without replacing consumer-owned nodes. */
export function setIconResolver(document: Document, resolver: (icon: Icon) => IconDefinition | undefined): void {
	iconResolversByDocument.set(document, resolver);
	for (const element of document.querySelectorAll<HTMLSpanElement>('span.ash-icon[data-ash-icon-id]')) {
		if (!mountedIcons.has(element)) continue;
		const id = element.dataset.ashIconId!;
		renderDefinition(element, resolver(Icon.fromId(id)) ?? getLxiconDefinition(id));
	}
}

export function getRegisteredIcon(id: string, document: Document): Icon | undefined {
	const icon = Icon.fromId(id);
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(id);
	return definition ? icon : undefined;
}

function renderDefinition(element: HTMLSpanElement, definition: IconDefinition | undefined): void {
	element.classList.remove('ash-icon-default-font', 'ash-icon-font', 'ash-icon-layered');
	element.removeAttribute('data-ash-icon-character');
	for (const property of ['--ash-icon-font-family', '--ash-icon-font-weight', '--ash-icon-font-style'])
		element.style.removeProperty(property);
	element.replaceChildren();
	mountedIcons.add(element);
	if (!definition) {
		return;
	}
	element.classList.add('ash-icon-font');
	element.dataset.ashIconCharacter = definition.fontCharacter;
	if (definition.layers) {
		element.classList.add('ash-icon-layered');
		for (const layer of definition.layers) {
			const glyph = h(element.ownerDocument, 'span', { className: 'ash-icon-font-layer' });
			glyph.dataset.ashIconLayer = layer.id;
			glyph.dataset.ashIconCharacter = layer.fontCharacter;
			glyph.style.transformOrigin = `${layer.origin[0] * 100}% ${layer.origin[1] * 100}%`;
			element.append(glyph);
		}
	}
	if (definition.font) {
		element.style.setProperty('--ash-icon-font-family', JSON.stringify(definition.font.id));
		element.style.setProperty('--ash-icon-font-weight', definition.font.definition.weight ?? 'normal');
		element.style.setProperty('--ash-icon-font-style', definition.font.definition.style ?? 'normal');
	} else {
		element.classList.add('ash-icon-default-font');
	}
}

function resolveDefinition(icon: Icon, document: Document): IconDefinition {
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(icon.id);
	if (!definition) throw new ReferenceError(`Unknown icon '${icon.id}'`);
	return definition;
}
