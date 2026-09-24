import type { HoverContent } from '../hover/hover.js';
import { getHoverDelegate, type IManagedHover } from '../hover/hoverDelegate.js';
import { appendIcon } from '../icon/icon.js';
import { getIconAriaLabel, type IMatch } from '../../../common/iconLabels.js';
import type { Icon } from '../../../common/icon.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { h, text as createText } from '../../dom.js';
import { renderLabelWithIcons } from './iconLabels.js';

export interface IconLabelValueOptions {
	readonly title?: HoverContent;
	readonly descriptionTitle?: HoverContent;
	readonly suffix?: string;
	readonly hideIcon?: boolean;
	readonly extraClasses?: readonly string[];
	readonly bold?: boolean;
	readonly italic?: boolean;
	readonly strikethrough?: boolean;
	readonly matches?: readonly IMatch[];
	readonly descriptionMatches?: readonly IMatch[];
	readonly labelEscapeNewLines?: boolean;
	readonly disabledCommand?: boolean;
	readonly domId?: string;
	readonly ariaLabel?: string;
	readonly separator?: string;
	readonly supportIcons?: boolean;
	readonly icon?: Icon;
	readonly renderIcon?: (container: HTMLSpanElement) => void;
	readonly reserveIconSpace?: boolean;
}

/** Construction inputs for a semantic icon and text label. */
export interface IconLabelOptions extends IconLabelValueOptions {
	readonly label: string | readonly string[];
	readonly description?: string;
}

/**
 * Reusable label whose icon, name, description, suffix, and hover lifetimes
 * share one stable DOM shape.
 */
export class IconLabel extends Disposable {
	readonly element: HTMLSpanElement;
	readonly iconElement: HTMLSpanElement;
	readonly labelElement: HTMLSpanElement;

	private readonly labelContainer: HTMLSpanElement;
	private readonly descriptionHover = this._register(new MutableDisposable<IManagedHover>());
	private readonly titleHover = this._register(new MutableDisposable<IManagedHover>());
	private readonly supportIcons: boolean;
	private appliedClasses: readonly string[] = [];
	private descriptionElement: HTMLSpanElement | undefined;
	private suffixElement: HTMLSpanElement | undefined;

	constructor(container: HTMLElement, options: IconLabelOptions) {
		super();
		if (options.icon && options.renderIcon) {
			throw new TypeError('IconLabel accepts either a semantic icon or an icon renderer');
		}
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, 'span');
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = 'ash-icon-label';
		this.supportIcons = options.supportIcons === true;

		this.iconElement = h(ownerDocument, 'span');
		this.iconElement.className = 'ash-icon-label-icon';
		this.iconElement.setAttribute('aria-hidden', 'true');

		this.labelContainer = h(ownerDocument, 'span');
		this.labelContainer.className = 'ash-icon-label-container';
		this.labelElement = h(ownerDocument, 'span');
		this.labelElement.className = 'ash-icon-label-text';
		this.labelContainer.append(this.labelElement);
		element.append(this.iconElement, this.labelContainer);
		container.append(element);

		this.setLabel(options.label, options.description, options);
	}

	setLabel(
		label: string | readonly string[] | undefined,
		description?: string,
		options?: IconLabelValueOptions,
	): void {
		this.setIcon(
			options?.hideIcon ? undefined : options?.icon,
			options?.hideIcon ? undefined : options?.renderIcon,
			options?.reserveIconSpace === true,
			options?.hideIcon === true,
		);

		this.updateClasses(options);
		this.labelContainer.classList.toggle('disabled', options?.disabledCommand === true || options?.extraClasses?.includes('disabled') === true);
		const ariaLabel = options?.ariaLabel ?? (typeof options?.title === 'string' ? getIconAriaLabel(options.title) : undefined);
		if (ariaLabel !== undefined) this.element.setAttribute('aria-label', ariaLabel);
		else this.element.removeAttribute('aria-label');

		const supportIcons = options?.supportIcons ?? this.supportIcons;
		const separator = options?.separator ?? '/';
		const escapedName = normalizeLabel(label ?? '', options?.matches, options?.labelEscapeNewLines === true, separator);
		const escapedDescription = normalizeLabel(description, options?.descriptionMatches, options?.labelEscapeNewLines === true);
		this.renderName(escapedName.value ?? '', supportIcons, escapedName.matches, separator, options?.domId);
		this.renderDescription(typeof escapedDescription.value === 'string' ? escapedDescription.value : undefined, escapedDescription.matches, supportIcons, options?.descriptionTitle);
		this.renderSuffix(options?.suffix);
		this.setHover(this.titleHover, this.element, options?.title);
	}

	/** Replaces the current icon while keeping the label nodes stable. */
	setIcon(
		icon: Icon | undefined,
		renderIcon: ((container: HTMLSpanElement) => void) | undefined = undefined,
		reserveIconSpace = false,
		hideIcon = false,
	): void {
		if (icon && renderIcon) throw new TypeError('IconLabel accepts either a semantic icon or an icon renderer');
		this.iconElement.replaceChildren();
		this.iconElement.className = 'ash-icon-label-icon';
		this.iconElement.setAttribute('aria-hidden', 'true');
		this.iconElement.classList.toggle('is-reserved', reserveIconSpace);
		if (hideIcon) return;
		if (icon) appendIcon(icon, this.iconElement);
		else renderIcon?.(this.iconElement);
	}

	clear(): void {
		this.setLabel('');
	}

	private renderName(
		label: string | readonly string[],
		supportIcons: boolean,
		matches: readonly IMatch[] | undefined,
		separator: string,
		domId: string | undefined,
	): void {
		this.labelElement.replaceChildren();
		const labels = typeof label === 'string' ? [label] : label ?? [''];
		this.labelElement.classList.toggle('multiple', typeof label !== 'string');
		if (typeof label === 'string' && domId) this.labelElement.id = domId;
		else this.labelElement.removeAttribute('id');
		let offset = 0;
		for (let index = 0; index < labels.length; index += 1) {
			const value = labels[index] ?? '';
			const segment = h(this.element.ownerDocument, 'span');
			segment.className = 'ash-icon-label-segment';
			if (domId && labels.length > 1) {
				segment.id = `${domId}_${index}`;
				segment.dataset.iconLabelCount = String(labels.length);
				segment.dataset.iconLabelIndex = String(index);
				segment.setAttribute('role', 'treeitem');
			}
			const segmentMatches = matches?.flatMap(match => {
				const start = Math.max(offset, match.start);
				const end = Math.min(offset + value.length, match.end);
				return start < end ? [{ start: start - offset, end: end - offset }] : [];
			});
			if (supportIcons) renderLabelWithIcons(segment, value, { matches: segmentMatches });
			else appendTextWithMatches(segment, value, offset, matches);
			this.labelElement.append(segment);
			offset += value.length;
			if (index < labels.length - 1) {
				const separatorElement = h(this.element.ownerDocument, 'span');
				separatorElement.className = 'ash-icon-label-separator';
				separatorElement.textContent = separator;
				this.labelElement.append(separatorElement);
				offset += separator.length;
			}
		}
	}

	private renderDescription(
		description: string | undefined,
		matches: readonly IMatch[] | undefined,
		supportIcons: boolean,
		title: HoverContent,
	): void {
		if (description !== undefined || this.descriptionElement) {
			const element = this.descriptionElement ??= this.createDescriptionElement();
			element.replaceChildren();
			element.hidden = !description;
			if (supportIcons) renderLabelWithIcons(element, description ?? '', { matches });
			else appendTextWithMatches(element, description ?? '', 0, matches);
			this.setHover(this.descriptionHover, element, title);
		} else {
			this.descriptionHover.clear();
		}
	}

	private renderSuffix(suffix: string | undefined): void {
		if (suffix !== undefined || this.suffixElement) {
			const element = this.suffixElement ??= this.createSuffixElement();
			element.textContent = suffix ?? '';
			element.hidden = !suffix;
		}
	}

	private createDescriptionElement(): HTMLSpanElement {
		const element = h(this.element.ownerDocument, 'span');
		element.className = 'ash-icon-label-description';
		this.labelContainer.append(element);
		return element;
	}

	private createSuffixElement(): HTMLSpanElement {
		const element = h(this.element.ownerDocument, 'span');
		element.className = 'ash-icon-label-suffix';
		this.element.append(element);
		return element;
	}

	private updateClasses(options: IconLabelValueOptions | undefined): void {
		for (const className of this.appliedClasses) this.element.classList.remove(className);
		const classes = [
			...(options?.extraClasses ?? []),
			...(options?.bold ? ['bold'] : []),
			...(options?.italic ? ['italic'] : []),
			...(options?.strikethrough ? ['strikethrough'] : []),
		];
		this.appliedClasses = classes;
		this.element.classList.add(...classes);
	}

	private setHover(
		slot: MutableDisposable<IManagedHover>,
		target: HTMLElement,
		content: HoverContent,
	): void {
		slot.clear();
		target.removeAttribute('title');
		if (content === undefined || content === '') return;
		slot.value = getHoverDelegate().setupHover({ target, content });
	}
}

function appendTextWithMatches(
	container: HTMLElement,
	text: string,
	start: number,
	matches: readonly IMatch[] | undefined,
): void {
	if (!text) return;
	if (!matches || matches.length === 0) {
		container.textContent = text;
		return;
	}
	let cursor = 0;
	for (const match of matches) {
		const localStart = Math.max(0, match.start - start);
		const localEnd = Math.min(text.length, match.end - start);
		if (localStart >= localEnd || localStart < cursor) continue;
		if (localStart > cursor) container.append(createText(container.ownerDocument, text.slice(cursor, localStart)));
		const highlight = h(container.ownerDocument, 'span');
		highlight.className = 'ash-icon-label-highlight';
		highlight.textContent = text.slice(localStart, localEnd);
		container.append(highlight);
		cursor = localEnd;
	}
	if (cursor < text.length) container.append(createText(container.ownerDocument, text.slice(cursor)));
}

function normalizeLabel(
	value: string | readonly string[] | undefined,
	matches: readonly IMatch[] | undefined,
	escapeNewLines: boolean,
	separator = '/',
): { readonly value: string | readonly string[] | undefined; readonly matches: readonly IMatch[] | undefined } {
	if (!escapeNewLines || value === undefined) return { value, matches };
	if (typeof value !== 'string') {
		let sourceOffset = 0;
		let outputOffset = 0;
		const normalized: string[] = [];
		const normalizedMatches: IMatch[] = [];
		for (const [index, segment] of value.entries()) {
			const result = escapeLabelNewLines(segment);
			normalized.push(result.value);
			for (const match of matches ?? []) {
				const start = Math.max(sourceOffset, match.start);
				const end = Math.min(sourceOffset + segment.length, match.end);
				if (start < end) normalizedMatches.push({ start: outputOffset + result.offset(start - sourceOffset), end: outputOffset + result.offset(end - sourceOffset) });
			}
			sourceOffset += segment.length + (index < value.length - 1 ? separator.length : 0);
			outputOffset += result.value.length + (index < value.length - 1 ? separator.length : 0);
		}
		return { value: normalized, matches: normalizedMatches };
	}
	const result = escapeLabelNewLines(value);
	return { value: result.value, matches: matches?.map(match => ({ start: result.offset(match.start), end: result.offset(match.end) })) };
}

function escapeLabelNewLines(value: string): { readonly value: string; readonly offset: (sourceOffset: number) => number } {
	const offsets = new Array<number>(value.length + 1);
	let result = '';
	let sourceOffset = 0;
	while (sourceOffset < value.length) {
		offsets[sourceOffset] = result.length;
		if (value[sourceOffset] === '\r' && value[sourceOffset + 1] === '\n') {
			result += '↵';
			sourceOffset += 2;
			offsets[sourceOffset] = result.length;
			continue;
		}
		if (value[sourceOffset] === '\r' || value[sourceOffset] === '\n') {
			result += '↵';
			sourceOffset += 1;
			offsets[sourceOffset] = result.length;
			continue;
		}
		result += value[sourceOffset];
		sourceOffset += 1;
	}
	offsets[value.length] ??= result.length;
	return { value: result, offset: sourceOffset => offsets[Math.max(0, Math.min(value.length, sourceOffset))] ?? result.length };
}
