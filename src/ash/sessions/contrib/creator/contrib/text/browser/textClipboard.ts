import { parseDesignTextStyle, type DesignTextRun, type DesignTextStyle } from '../../../common/model/designText.js';

/** Read only text and supported typography from an inert fragment; never insert clipboard markup. */
export function readDesignTextHtml(document: Document, html: string): { text: string; runs: readonly DesignTextRun[] } {
	const template = document.createElement('template');
	template.innerHTML = html;
	let text = '';
	const runs: DesignTextRun[] = [];
	const append = (value: string, style: DesignTextStyle): void => {
		if (value) {
			const start = text.length;
			text += value;
			runs.push({ start, end: text.length, style });
		}
	};
	const walk = (node: Node, inherited: DesignTextStyle): void => {
		if (node.nodeType === 3) {
			const value = node.textContent ?? '';
			const betweenBlocks = /^\s*$/u.test(value) && [...(node.parentElement?.children ?? [])].some(child => ['DIV', 'P', 'LI', 'UL', 'OL'].includes(child.tagName));
			if (!betweenBlocks) {
				append(value, inherited);
			}
			return;
		}
		if (node.nodeType !== 1) {
			return;
		}
		const element = node as HTMLElement;
		const tag = element.tagName.toLowerCase();
		if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'head'].includes(tag)) {
			return;
		}
		if (tag === 'br') {
			append('\n', inherited);
			return;
		}
		const block = ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(tag);
		if (block && text && !text.endsWith('\n')) {
			append('\n', inherited);
		}
		const css = element.style;
		const style: DesignTextStyle = { ...inherited };
		if (['b', 'strong'].includes(tag)) {
			Reflect.set(style, 'fontWeight', 700);
		}
		if (['i', 'em'].includes(tag)) {
			Reflect.set(style, 'fontStyle', 'italic');
		}
		if (tag === 'u') {
			Reflect.set(style, 'textDecoration', 'underline');
		}
		if (['s', 'strike', 'del'].includes(tag)) {
			Reflect.set(style, 'textDecoration', 'line-through');
		}
		if (css.fontFamily) {
			Reflect.set(style, 'fontFamily', css.fontFamily);
		}
		if (css.fontWeight) {
			Reflect.set(style, 'fontWeight', css.fontWeight === 'bold' ? 700 : css.fontWeight === 'normal' ? 400 : Number(css.fontWeight));
		}
		if (css.fontStyle === 'normal' || css.fontStyle === 'italic') {
			Reflect.set(style, 'fontStyle', css.fontStyle);
		}
		if (/^\d+(?:\.\d+)?px$/u.test(css.fontSize)) {
			Reflect.set(style, 'fontSize', parseFloat(css.fontSize));
		}
		for (const [key, value] of [
			['lineHeight', css.lineHeight],
			['letterSpacing', css.letterSpacing],
		] as const) {
			if (/^-?\d+(?:\.\d+)?(?:px|em|%)$/u.test(value)) {
				Reflect.set(style, key, parseFloat(value) * (value.endsWith('em') ? 100 : 1));
				Reflect.set(style, `${key}Unit`, value.endsWith('px') ? 'px' : 'percent');
			}
		}
		const decoration = css.textDecorationLine || css.textDecoration;
		if (decoration.includes('underline') || decoration.includes('line-through')) {
			Reflect.set(style, 'textDecoration', [decoration.includes('underline') ? 'underline' : '', decoration.includes('line-through') ? 'line-through' : ''].filter(Boolean).join(' '));
		}
		if (['left', 'center', 'right', 'justify'].includes(css.textAlign)) {
			Reflect.set(style, 'textAlign', css.textAlign);
		}
		if (element.dir === 'ltr' || element.dir === 'rtl') {
			Reflect.set(style, 'textDirection', element.dir);
		}
		if (tag === 'li') {
			Reflect.set(style, 'listType', element.parentElement?.tagName.toLowerCase() === 'ol' ? 'number' : 'bullet');
		}
		const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/u.exec(css.color);
		if (rgb) {
			Reflect.set(
				style,
				'fill',
				'#' +
					rgb
						.slice(1, 4)
						.map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0'))
						.join('') +
					(rgb[4] === undefined
						? ''
						: Math.round(Math.max(0, Math.min(1, Number(rgb[4]))) * 255)
								.toString(16)
								.padStart(2, '0')),
			);
		} else if (/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(css.color)) {
			Reflect.set(style, 'fill', css.color);
		}
		let validated = inherited;
		try {
			validated = parseDesignTextStyle(style);
		} catch {
			/* Invalid formatting does not discard clipboard text. */
		}
		for (const child of element.childNodes) {
			walk(child, validated);
		}
		if (block && !text.endsWith('\n')) {
			append('\n', validated);
		}
	};
	for (const node of template.content.childNodes) {
		walk(node, {});
	}
	if (text.endsWith('\n')) {
		text = text.slice(0, -1);
	}
	return {
		text,
		runs: runs.filter(run => run.start < text.length).map(run => ({ ...run, end: Math.min(run.end, text.length) })),
	};
}
