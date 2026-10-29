import type { CodeImageSnapshot } from '@ash/sdk';
import { localize } from '../common/nls.js';

export interface CodeImageOptions {
	readonly padding: number;
	readonly scale: number;
	readonly background: string;
	readonly lineNumbers: boolean;
	readonly realLineNumbers: boolean;
	readonly windowControls: boolean;
	readonly windowTitle: boolean;
	readonly transparent: boolean;
}

/** Selection text and syntax styles are immutable input; the extension owns every output pixel. */
export async function renderCodeImage(document: Document, input: CodeImageSnapshot, options: CodeImageOptions): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d')!;
	const font = `${input.fontSize}px ${input.fontFamily}`;
	await document.fonts.load(font);
	context.font = font;
	const lineHeight = Math.ceil(input.fontSize * 1.5);
	const lines = input.lines.map(tokens => {
		let column = 0;
		return tokens.map(token => ({
			...token, text: [...token.text].map(character => {
				const count = character === '\t' ? input.tabSize - column % input.tabSize : 1;
				column += count;
				return character === '\t' ? ' '.repeat(count) : character;
			}).join('')
		}));
	});
	const numbers = options.lineNumbers ? context.measureText(String((options.realLineNumbers ? input.firstLine : 1) + lines.length - 1)).width + 24 : 0;
	const header = options.windowControls || options.windowTitle ? 36 : 0;
	const width = Math.ceil(Math.max(240, ...lines.map(tokens => tokens.reduce((width, token) => {
		context.font = `${token.italic ? 'italic ' : ''}${token.bold ? 'bold ' : ''}${font}`;
		return width + context.measureText(token.text).width;
	}, 0))) + numbers + 48 + options.padding * 2);
	const height = Math.ceil(lines.length * lineHeight + header + 48 + options.padding * 2);
	const pixelWidth = Math.ceil(width * options.scale), pixelHeight = Math.ceil(height * options.scale);
	if (!Number.isFinite(pixelWidth * pixelHeight) || pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > 16_777_216) {
		throw new Error(localize('snapshot.code.tooLarge', 'The code image is too large. Select fewer lines or lower the resolution scale.'));
	}
	canvas.width = pixelWidth; canvas.height = pixelHeight;
	context.scale(options.scale, options.scale);
	if (!options.transparent) { context.fillStyle = options.background; context.fillRect(0, 0, width, height); }
	context.fillStyle = input.background;
	context.beginPath(); context.roundRect(options.padding, options.padding, width - options.padding * 2, height - options.padding * 2, 8); context.fill();
	if (options.windowControls) for (const [index, color] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
		context.fillStyle = color; context.beginPath(); context.arc(options.padding + 24 + index * 18, options.padding + 22, 5, 0, Math.PI * 2); context.fill();
	}
	context.font = font;
	context.textBaseline = 'top';
	if (options.windowTitle) {
		context.fillStyle = input.foreground;
		context.fillText(input.title, options.padding + (options.windowControls ? 90 : 24), options.padding + 14, width - options.padding * 2 - 120);
	}
	for (const [index, tokens] of lines.entries()) {
		const y = options.padding + header + 24 + index * lineHeight;
		let x = options.padding + 24;
		context.font = font;
		if (options.lineNumbers) {
			context.fillStyle = input.foreground;
			context.globalAlpha = 0.6;
			context.fillText(String((options.realLineNumbers ? input.firstLine : 1) + index), x, y);
			context.globalAlpha = 1;
			x += numbers;
		}
		for (const token of tokens) {
			context.font = `${token.italic ? 'italic ' : ''}${token.bold ? 'bold ' : ''}${font}`;
			context.fillStyle = token.color;
			context.fillText(token.text, x, y);
			const width = context.measureText(token.text).width;
			if (token.underline) context.fillRect(x, y + input.fontSize, width, 1);
			if (token.strikethrough) context.fillRect(x, y + input.fontSize / 2, width, 1);
			x += width;
		}
	}
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
	if (!blob) throw new Error(localize('snapshot.code.exportFailed', 'Could not create the code image.'));
	return new Uint8Array(await blob.arrayBuffer());
}
