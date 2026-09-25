import './lxicon.css';
import '../../../common/lxicons.js';
import { Icon, type IconDefinition } from '../../../common/icon.js';
import { getLxiconDefinition } from '../../../common/lxiconsUtil.js';
import { setAriaAttribute } from '../aria/aria.js';
import { h } from '../../dom.js';
import { createTrustedTypesPolicy } from '../../trustedTypes.js';

const prototypesByDocument = new WeakMap<Document, Map<IconDefinition, SVGElement>>();
const iconResolversByDocument = new WeakMap<Document, (icon: Icon) => IconDefinition | undefined>();
const artworkAttributes = new WeakMap<SVGElement, readonly string[]>();
const iconPolicy = createTrustedTypesPolicy('ashIcon', { createHTML: value => value });

/** Mounts one SVG icon with consistent accessibility metadata. */
export function appendIcon(icon: Icon, container: HTMLElement): SVGElement {
	const element = createLxicon(resolveDefinition(icon, container.ownerDocument), container.ownerDocument);
	artworkAttributes.set(element, artworkAttributeNames(element));
	element.setAttribute('data-ash-icon-id', icon.id);
	container.append(element);
	return element;
}

/** Binds a window's theme artwork and updates mounted SVGs without replacing their DOM nodes. */
export function setIconResolver(document: Document, resolver: (icon: Icon) => IconDefinition | undefined): void {
	iconResolversByDocument.set(document, resolver);
	for (const element of document.querySelectorAll<SVGElement>('svg.ash-icon[data-ash-icon-id]')) {
		const previousAttributes = artworkAttributes.get(element);
		if (!previousAttributes) continue;
		const id = element.getAttribute('data-ash-icon-id')!;
		const artwork = createLxicon(resolveDefinition(Icon.fromId(id), document), document);
		for (const attribute of previousAttributes) element.removeAttribute(attribute);
		for (const attribute of [...artwork.attributes]) {
			if (isArtworkAttribute(attribute.name)) element.setAttribute(attribute.name, attribute.value);
		}
		artworkAttributes.set(element, artworkAttributeNames(artwork));
		element.replaceChildren(...[...artwork.childNodes].map(child => child.cloneNode(true)));
	}
}

export function getRegisteredIcon(id: string, document: Document): Icon | undefined {
	const icon = Icon.fromId(id);
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(id);
	return definition ? icon : undefined;
}

/** Materializes repository or theme supplied SVG artwork in the target document. */
function createLxicon(definition: IconDefinition, document: Document): SVGElement {
	let prototypes = prototypesByDocument.get(document);
	if (!prototypes) {
		prototypes = new Map();
		prototypesByDocument.set(document, prototypes);
	}
	let prototype = prototypes.get(definition);
	if (!prototype) {
		const template = h(document, 'template');
		const source = definition().trim();
		template.innerHTML = iconPolicy?.createHTML?.(source) ?? source;
		const candidate = template.content.firstElementChild;
		if (template.content.childElementCount !== 1 || candidate?.namespaceURI !== 'http://www.w3.org/2000/svg') {
			throw new TypeError('Icon definition did not produce one SVG element');
		}
		prototype = candidate as SVGElement;
		prototype.classList.add('ash-icon');
		setAriaAttribute(prototype, 'hidden', true);
		prototype.setAttribute('focusable', 'false');
		prototypes.set(definition, prototype);
	}
	return prototype.cloneNode(true) as SVGElement;
}

function resolveDefinition(icon: Icon, document: Document): IconDefinition {
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(icon.id);
	if (!definition) throw new ReferenceError(`Unknown icon '${icon.id}'`);
	return definition;
}

function artworkAttributeNames(element: SVGElement): readonly string[] {
	return [...element.attributes].map(attribute => attribute.name).filter(isArtworkAttribute);
}

function isArtworkAttribute(name: string): boolean {
	return name !== 'class' && name !== 'style' && name !== 'aria-hidden' && name !== 'focusable' && name !== 'data-ash-icon-id';
}
