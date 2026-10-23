import './lxicon.css';
import '../../../common/lxicons.js';
import { Icon, type IconDefinition } from '../../../common/icon.js';
import { getLxiconDefinition } from '../../../common/lxiconsUtil.js';
import { setAriaAttribute } from '../aria/aria.js';
import { h } from '../../dom.js';
import { createTrustedTypesPolicy } from '../../trustedTypes.js';

const prototypesByDocument = new WeakMap<Document, Map<IconDefinition, SVGElement>>();
const iconResolversByDocument = new WeakMap<Document, (icon: Icon) => IconDefinition | undefined>();
const renderedDefinitions = new WeakMap<HTMLSpanElement, IconDefinition | undefined>();
const fontLoads = new WeakMap<Document, Map<string, Promise<boolean>>>();
const iconPolicy = createTrustedTypesPolicy('ashIcon', { createHTML: value => value });

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
		if (!renderedDefinitions.has(element)) continue;
		const id = element.dataset.ashIconId!;
		renderDefinition(element, resolver(Icon.fromId(id)) ?? getLxiconDefinition(id));
	}
}

export function getRegisteredIcon(id: string, document: Document): Icon | undefined {
	const icon = Icon.fromId(id);
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(id);
	return definition ? icon : undefined;
}

/** Parses dedicated artwork only; successful font icons have no SVG descendants. */
function createArtwork(definition: IconDefinition, document: Document): SVGElement | undefined {
	const source = typeof definition === 'function' ? definition : definition.fallback;
	if (!source) return undefined;
	let prototypes = prototypesByDocument.get(document);
	if (!prototypes) {
		prototypes = new Map();
		prototypesByDocument.set(document, prototypes);
	}
	let prototype = prototypes.get(definition);
	if (!prototype) {
		const template = h(document, 'template');
		const markup = source().trim();
		template.innerHTML = iconPolicy?.createHTML?.(markup) ?? markup;
		const candidate = template.content.firstElementChild;
		if (template.content.childElementCount !== 1 || candidate?.namespaceURI !== 'http://www.w3.org/2000/svg') {
			throw new TypeError('Icon definition did not produce one SVG element');
		}
		prototype = candidate as SVGElement;
		prototype.classList.add('ash-icon-artwork');
		prototype.setAttribute('focusable', 'false');
		prototypes.set(definition, prototype);
	}
	return prototype.cloneNode(true) as SVGElement;
}

function renderDefinition(element: HTMLSpanElement, definition: IconDefinition | undefined): void {
	element.classList.remove('ash-icon-default-font', 'ash-icon-font', 'ash-icon-font-ready');
	element.removeAttribute('data-ash-icon-character');
	for (const property of ['--ash-icon-font-family', '--ash-icon-font-weight', '--ash-icon-font-style']) element.style.removeProperty(property);
	element.replaceChildren();
	renderedDefinitions.set(element, definition);
	if (!definition) {
		return;
	}
	if (typeof definition === 'function') {
		appendArtwork(element, definition);
		return;
	}
	element.classList.add('ash-icon-font');
	element.dataset.ashIconCharacter = definition.fontCharacter;
	if (definition.font) {
		element.style.setProperty('--ash-icon-font-family', JSON.stringify(definition.font.id));
		element.style.setProperty('--ash-icon-font-weight', definition.font.definition.weight ?? 'normal');
		element.style.setProperty('--ash-icon-font-style', definition.font.definition.style ?? 'normal');
	} else {
		element.classList.add('ash-icon-default-font');
	}
	loadGlyphFont(element, definition);
}

function appendArtwork(element: HTMLSpanElement, definition: IconDefinition): void {
	const artwork = createArtwork(definition, element.ownerDocument);
	if (artwork) element.replaceChildren(artwork);
}

/** Use the window's actual face; an IDE does not preload the Sessions profile. */
function loadGlyphFont(element: HTMLSpanElement, definition: Exclude<IconDefinition, () => string>): void {
	const document = element.ownerDocument;
	if (!document.fonts) {
		appendArtwork(element, definition);
		return;
	}
	const reference = new WeakRef(element);
	// Theme styles and detached controls finish mounting in the current turn.
	void Promise.resolve().then(async () => {
		const query = fontQuery(reference, definition);
		if (!query) return;
		let loads = fontLoads.get(document);
		if (!loads) { loads = new Map(); fontLoads.set(document, loads); }
		let loaded = loads.get(query);
		if (!loaded) {
			loaded = document.fonts.load(query, definition.fontCharacter).then(faces => faces.length > 0, () => false);
			loads.set(query, loaded);
		}
		const ready = await loaded;
		if (!ready) loads.delete(query);
		const mounted = reference.deref();
		if (!mounted || renderedDefinitions.get(mounted) !== definition) return;
		mounted.classList.toggle('ash-icon-font-ready', ready);
		if (!ready) appendArtwork(mounted, definition);
	});
}

/** Keep the DOM reference out of the asynchronous font-load frame. */
function fontQuery(reference: WeakRef<HTMLSpanElement>, definition: IconDefinition): string | undefined {
	const element = reference.deref();
	if (!element || renderedDefinitions.get(element) !== definition) return undefined;
	const style = element.ownerDocument.defaultView!.getComputedStyle(element);
	return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} 16px ${style.fontFamily || '"Ash UI Icons"'}`;
}

function resolveDefinition(icon: Icon, document: Document): IconDefinition {
	const definition = iconResolversByDocument.get(document)?.(icon) ?? getLxiconDefinition(icon.id);
	if (!definition) throw new ReferenceError(`Unknown icon '${icon.id}'`);
	return definition;
}
