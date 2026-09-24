import { getRegisteredIcon, type Icon } from '../../../common/icon.js';
import type { IMatch } from '../../../common/iconLabels.js';
import { appendIcon } from '../icon/icon.js';
import { h, text as createText } from '../../dom.js';

const iconToken = /\$\(([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:~([A-Za-z]+))?\)/gu;

export interface RenderLabelWithIconsOptions {
	readonly matches?: readonly IMatch[];
	readonly renderIconsInDefaultColor?: boolean;
}

/** Renders Ash's literal icon syntax without exposing the icon registry to common code. */
export function renderLabelWithIcons(
	container: HTMLElement,
	label: string,
	options: RenderLabelWithIconsOptions = {},
): void {
	container.replaceChildren();
	iconToken.lastIndex = 0;
	let cursor = 0;
	let sawToken = false;

	for (const match of label.matchAll(iconToken)) {
		const index = match.index ?? cursor;
		const token = match[0];
		const escaped = isEscaped(label, index);
		sawToken = true;
		const textEnd = escaped ? index - 1 : index;
		appendLabelText(container, label.slice(cursor, textEnd), cursor, options.matches);
		const icon = escaped ? undefined : getRegisteredIcon(match[1]!);
		if (icon) {
			const iconElement = h(container.ownerDocument, 'span');
			iconElement.className = 'ash-icon-label-inline-icon';
			iconElement.setAttribute('aria-hidden', 'true');
			if (match[2]) iconElement.dataset.iconModifier = match[2];
			if (options.renderIconsInDefaultColor === false) iconElement.classList.add('default-color');
			if (isMatched(index, index + token.length, options.matches)) iconElement.classList.add('is-highlighted');
			appendIcon(icon, iconElement);
			container.append(iconElement);
		} else {
			const literalStart = escaped ? index - 1 : index;
			appendLabelText(container, escaped ? token : token, literalStart, options.matches);
		}
		cursor = index + token.length;
	}

	appendLabelText(container, label.slice(cursor), cursor, options.matches);
	if (!sawToken && !options.matches?.length) container.textContent = label;
}

/** Appends a semantic icon to a label container and applies a modifier class. */
export function appendLabelIcon(
	container: HTMLElement,
	icon: Icon,
	modifier?: string,
): HTMLElement {
	const iconElement = h(container.ownerDocument, 'span');
	iconElement.className = 'ash-icon-label-inline-icon';
	iconElement.setAttribute('aria-hidden', 'true');
	if (modifier) iconElement.dataset.iconModifier = modifier;
	appendIcon(icon, iconElement);
	container.append(iconElement);
	return iconElement;
}

function appendLabelText(
	container: HTMLElement,
	text: string,
	start: number,
	matches: readonly IMatch[] | undefined,
): void {
	if (!text) return;
	if (!matches || matches.length === 0) {
		container.append(createText(container.ownerDocument, text));
		return;
	}

	let cursor = 0;
	for (const match of matches) {
		const localStart = Math.max(0, match.start - start);
		const localEnd = Math.min(text.length, match.end - start);
		if (localStart >= localEnd || localStart < cursor) continue;
		if (localStart > cursor) container.append(createText(container.ownerDocument, text.slice(cursor, localStart)));
		const highlighted = h(container.ownerDocument, 'span');
		highlighted.className = 'ash-icon-label-highlight';
		highlighted.textContent = text.slice(localStart, localEnd);
		container.append(highlighted);
		cursor = localEnd;
	}
	if (cursor < text.length) container.append(createText(container.ownerDocument, text.slice(cursor)));
}

function isEscaped(value: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function isMatched(start: number, end: number, matches: readonly IMatch[] | undefined): boolean {
	return matches?.some(match => match.start < end && match.end > start) === true;
}
