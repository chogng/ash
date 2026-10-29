import { designTextSegments, designTextStyleAt, type DesignTextShape, type DesignTextStyle } from '../common/model/designText.js';

function spacing(value: number | undefined, unit: 'px' | 'percent' | undefined, fallback: string): string {
	return value === undefined ? fallback : unit === 'percent' ? `${value / 100}em` : `${value}px`;
}
/** Authored typography is shared by canvas, inline editing, measurement and exported HTML. */
export function applyDesignTextStyle(element: HTMLElement, style: DesignTextStyle): void {
	Object.assign(element.style, {
		fontFamily: style.fontFamily ?? 'sans-serif',
		fontSize: `${style.fontSize ?? 24}px`,
		fontWeight: String(style.fontWeight ?? 400),
		fontStyle: style.fontStyle ?? 'normal',
		color: style.fill ?? '#808080',
		lineHeight: spacing(style.lineHeight, style.lineHeightUnit, 'normal'),
		letterSpacing: spacing(style.letterSpacing, style.letterSpacingUnit, 'normal'),
		textDecoration: style.textDecoration ?? 'none',
		textTransform: (
			{
				upper: 'uppercase',
				lower: 'lowercase',
				title: 'capitalize',
				original: 'none',
				'small-caps': 'none',
			} as const
		)[style.textCase ?? 'original'],
		fontVariantCaps: style.textCase === 'small-caps' ? 'small-caps' : 'normal',
		fontFeatureSettings:
			Object.entries(style.fontFeatures ?? {})
				.map(([tag, value]) => `"${tag}" ${value}`)
				.join(', ') || 'normal',
		fontVariationSettings:
			Object.entries(style.fontVariations ?? {})
				.map(([tag, value]) => `"${tag}" ${value}`)
				.join(', ') || 'normal',
	});
}
export function renderDesignText(document: Document, shape: DesignTextShape, editing = false): HTMLDivElement {
	const root = document.createElement('div');
	root.dataset.designText = '';
	root.style.counterReset = 'list-item';
	applyDesignTextStyle(root, shape);
	Object.assign(root.style, {
		margin: '0',
		padding: '0',
		border: '0',
		boxSizing: 'border-box',
		width: '100%',
		minHeight: '1em',
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
		textAlign: shape.textAlign ?? 'left',
	});
	let start = 0;
	for (const [index, text] of shape.text.split('\n').entries()) {
		if (index) {
			root.append(document.createTextNode('\n'));
		}
		const paragraph = document.createElement('div');
		paragraph.dataset.textParagraph = '';
		const paragraphStyle = designTextStyleAt(shape, start);
		applyDesignTextStyle(paragraph, paragraphStyle);
		paragraph.dir = paragraphStyle.textDirection ?? 'auto';
		Object.assign(paragraph.style, {
			margin: '0',
			padding: '0',
			whiteSpace: shape.textAutoResize === 'width' && shape.sizing?.width !== 'fill' && !shape.sizeLimits?.maxWidth ? 'pre' : 'pre-wrap',
			textAlign: paragraphStyle.textAlign ?? 'left',
			textIndent: `${paragraphStyle.paragraphIndent ?? 0}px`,
			marginTop: index ? `${paragraphStyle.paragraphSpacing ?? 0}px` : '0',
			minHeight: '1lh',
			textWrapStyle: paragraphStyle.textWrap ?? 'auto',
			textBoxTrim: paragraphStyle.textTrim === 'cap-height' ? 'trim-both' : 'none',
			textBoxEdge: 'cap alphabetic',
		});
		if (paragraphStyle.listType && paragraphStyle.listType !== 'none') {
			paragraph.style.display = 'list-item';
			paragraph.style.listStyleType = paragraphStyle.listType === 'number' ? 'decimal' : 'disc';
			paragraph.style.listStylePosition = 'inside';
			paragraph.style.counterIncrement = 'list-item';
		}
		for (const run of designTextSegments(shape, start, start + text.length)) {
			const span = document.createElement('span');
			applyDesignTextStyle(span, { ...shape, ...run.style });
			span.textContent = shape.text.slice(run.start, run.end);
			paragraph.append(span);
		}
		if (!text) {
			paragraph.append(document.createElement('br'));
		}
		root.append(paragraph);
		start += text.length + 1;
	}
	if (!editing && shape.textTruncate) {
		const lineHeight = shape.lineHeight === undefined ? shape.fontSize * 1.2 : shape.lineHeightUnit === 'percent' ? (shape.fontSize * shape.lineHeight) / 100 : shape.lineHeight;
		Object.assign(root.style, {
			overflow: 'hidden',
			display: '-webkit-box',
			webkitBoxOrient: 'vertical',
			webkitLineClamp: String(shape.maxLines ?? Math.max(1, Math.floor(shape.height / Math.max(0.001, lineHeight)))),
		});
	}
	return root;
}

/** Fixed-height text aligns within its box; content can still extend beyond an unclipped layer. */
export function renderDesignTextFrame(document: Document, shape: DesignTextShape, editing = false): HTMLDivElement {
	const frame = document.createElement('div');
	Object.assign(frame.style, {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		justifyContent: shape.textVerticalAlign === 'center' ? 'center' : shape.textVerticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
		overflow: shape.textTruncate && !editing ? 'hidden' : 'visible',
	});
	const text = renderDesignText(document, shape, editing);
	text.style.flexShrink = '0';
	frame.append(text);
	return frame;
}
