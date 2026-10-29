import type { Font as ShapingFont, Face as ShapingFace, Blob as ShapingBlob } from 'harfbuzzjs';
import { getDesignVectorContours, loadDesignVectorGeometry } from './designVectorGeometry.js';
import type { Font, FontCollection, Glyph, PathCommand } from 'fontkit';
import { mainWindow } from '../../../../base/browser/window.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { flattenDesignVector } from '../common/commands/vectorCommands.js';
import type { DesignPathNode, DesignShape } from '../common/model/document.js';
import type { DesignPathContour } from '../common/model/designVector.js';
import type { DesignTextShape, DesignTextStyle } from '../common/model/designText.js';
import { renderDesignTextFrame } from './designTextRendering.js';

interface LocalFontData {
	readonly family: string;
	readonly postscriptName: string;
	blob(): Promise<Blob>;
}
interface OutlineFont {
	readonly font: Font;
	readonly family: string;
	readonly face: FontFace;
}
const importedFonts: OutlineFont[] = [];
const shapingSources = new WeakMap<ArrayBuffer, { blob: ShapingBlob; faces: Map<number, ShapingFace> }>();
const fontSources = new WeakMap<Font, { bytes: ArrayBuffer; index: number; variations?: Record<string, number> }>();

/** Font bytes stay in the renderer; the saved result contains only editable cubic paths. */
export async function importDesignOutlineFont(file: File): Promise<void> {
	if (file.size > 64 * 1024 * 1024) {
		throw new Error(localize('sessions.design.outlineFontSize', 'Choose a font file smaller than 64 MB.'));
	}
	const bytes = await file.arrayBuffer();
	const fonts = await readFonts(bytes);
	if (importedFonts.length + fonts.length > 32) {
		throw new Error(localize('sessions.design.outlineFontLimit', 'Too many outline fonts are loaded. Reopen the app to clear the font cache.'));
	}
	const fontFaces: FontFace[] = [];
	for (const font of fonts) {
		const weight = font.variationAxes.wght;
		const face = new FontFace(font.familyName, bytes, {
			style: font.italicAngle ? 'italic' : 'normal',
			weight: weight ? `${weight.min} ${weight.max}` : String(font['OS/2']?.usWeightClass ?? 400),
		});
		await face.load();
		fontFaces.push(face);
	}
	for (const face of fontFaces) {
		mainWindow.document.fonts.add(face);
	}
	for (const [i, font] of fonts.entries()) {
		const old = importedFonts.findIndex(item => item.font.postscriptName === font.postscriptName);
		if (old >= 0) {
			mainWindow.document.fonts.delete(importedFonts[old].face);
			importedFonts.splice(old, 1);
		}
		importedFonts.push({ font, family: font.familyName, face: fontFaces[i] });
	}
}
async function readFonts(bytes: ArrayBuffer): Promise<readonly Font[]> {
	const signature = new DataView(bytes).getUint32(0);
	if (![0x00010000, 0x4f54544f, 0x74727565, 0x74746366].includes(signature)) {
		throw new Error(localize('sessions.design.outlineFontFormat', 'Load a TrueType (.ttf) or OpenType (.otf) font for outlines.'));
	}
	const { create } = await import('fontkit');
	// Fontkit 2 accepts Uint8Array in browsers; its community declaration still names Node's Buffer.
	const value = create(new Uint8Array(bytes) as Parameters<typeof create>[0]);
	const fonts = 'fonts' in value ? (value as FontCollection).fonts : [value as Font];
	for (const [index, font] of fonts.entries()) {
		fontSources.set(font, { bytes, index });
	}
	return fonts;
}

class OutlineFonts {
	private readonly loaded = new Map<string, Promise<readonly Font[]>>();
	private readonly resolved = new Map<string, Font>();
	private readonly variations = new Map<string, Font>();
	private readonly shapingFonts = new Map<Font, ShapingFont>();
	constructor(
		private readonly available: readonly LocalFontData[],
		private readonly document: Document,
	) {}
	public async resolve(style: DesignTextStyle, text: string): Promise<Font> {
		const family = style.fontFamily ?? 'sans-serif',
			weight = style.fontWeight ?? 400,
			italic = style.fontStyle === 'italic';
		const key = JSON.stringify([family, weight, italic, style.fontVariations, text]);
		const cached = this.resolved.get(key);
		if (cached) {
			return cached;
		}
		const names = family.split(',').map(name =>
			name
				.trim()
				.replace(/^["']|["']$/gu, '')
				.toLowerCase(),
		);
		const candidates = [...new Set([...importedFonts.map(item => item.family), ...this.available.map(item => item.family)])];
		candidates.sort((a, b) => {
			const rank = (name: string) =>
				names.includes(name.toLowerCase()) ? names.indexOf(name.toLowerCase()) : /^(Arial|Helvetica|Times New Roman|Courier New|Liberation Sans|Noto Sans)$/u.test(name) ? 50 : 100;
			return rank(a) - rank(b);
		});
		for (const candidate of candidates) {
			if (names[0] !== candidate.toLowerCase() && !this.matches(family, candidate, style, text)) {
				continue;
			}
			const local = this.available.filter(item => item.family === candidate);
			const fonts = [...importedFonts.filter(item => item.family === candidate).map(item => item.font)];
			for (const source of local) {
				let loading = this.loaded.get(source.postscriptName);
				if (!loading) {
					loading = source
						.blob()
						.then(blob => blob.arrayBuffer())
						.then(readFonts);
					this.loaded.set(source.postscriptName, loading);
				}
				try {
					fonts.push(...(await loading).filter(font => font.postscriptName === source.postscriptName || font.familyName === source.family));
				} catch {
					/* Another installed face can supply the requested style. */
				}
			}
			for (let font of fonts) {
				if (!!font.italicAngle !== italic && !(font.variationAxes.ital || font.variationAxes.slnt)) {
					continue;
				}
				if (!font.variationAxes.wght && (font['OS/2']?.usWeightClass ?? 400) !== weight) {
					continue;
				}
				if ([...text].some(char => !/[\s\u200c\u200d\ufe00-\ufe0f]/u.test(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!))) {
					continue;
				}
				const axes: Record<string, number> = {
					...(font.variationAxes.wght ? { wght: weight } : {}),
					...(font.variationAxes.ital ? { ital: italic ? 1 : 0 } : {}),
					...(font.variationAxes.slnt && italic ? { slnt: -12 } : {}),
					...(font.variationAxes.opsz ? { opsz: style.fontSize ?? 24 } : {}),
					...style.fontVariations,
				};
				for (const tag of Object.keys(axes)) {
					const axis = font.variationAxes[tag];
					if (axis) {
						axes[tag] = Math.max(axis.min, Math.min(axis.max, axes[tag]));
					}
				}
				if (Object.keys(axes).length) {
					const variationKey = JSON.stringify([font.postscriptName, axes]);
					let variation = this.variations.get(variationKey);
					if (!variation) {
						variation = font.getVariation(axes);
						fontSources.set(variation, { ...fontSources.get(font)!, variations: axes });
						this.variations.set(variationKey, variation);
					}
					font = variation;
				}
				this.resolved.set(key, font);
				return font;
			}
		}
		throw new Error(
			localize(
				'sessions.design.outlineMissingFont',
				'The exact font for “{0}” ({1}, {2}) is unavailable. Allow local font access or load the matching font file, then try again.',
				text.slice(0, 20),
				family,
				weight,
			),
		);
	}
	public async shape(
		font: Font,
		text: string,
		features: Readonly<Record<string, number>>,
		direction: 'ltr' | 'rtl',
	): Promise<{
		glyphs: Glyph[];
		clusters: number[];
		positions: { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[];
	}> {
		const hb = await import('harfbuzzjs');
		let shapingFont = this.shapingFonts.get(font);
		if (!shapingFont) {
			const source = fontSources.get(font)!;
			// Imported fonts can be converted repeatedly. Share the WASM byte copy and face for the lifetime of their source bytes.
			let shared = shapingSources.get(source.bytes);
			if (!shared) {
				shared = { blob: new hb.Blob(source.bytes), faces: new Map() };
				shapingSources.set(source.bytes, shared);
			}
			let face = shared.faces.get(source.index);
			if (!face) {
				face = new hb.Face(shared.blob, source.index);
				shared.faces.set(source.index, face);
			}
			shapingFont = new hb.Font(face);
			shapingFont.setScale(font.unitsPerEm, font.unitsPerEm);
			if (source.variations) {
				shapingFont.setVariations(Object.entries(source.variations).map(([tag, value]) => new hb.Variation(tag, value)));
			}
			this.shapingFonts.set(font, shapingFont);
		}
		const buffer = new hb.Buffer();
		buffer.addText(text);
		buffer.guessSegmentProperties();
		buffer.setDirection(direction === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
		hb.shape(
			shapingFont,
			buffer,
			Object.entries(features).map(([tag, value]) => new hb.Feature(tag, value)),
		);
		const infos = buffer.getGlyphInfos(),
			ends = [...new Set([...infos.map(info => info.cluster), text.length])].sort((a, b) => a - b);
		return {
			clusters: infos.map(info => info.cluster),
			glyphs: infos.map(info =>
				font.getGlyph(
					info.codepoint,
					[...text.slice(info.cluster, ends[ends.indexOf(info.cluster) + 1])].map(char => char.codePointAt(0)!),
				),
			),
			positions: buffer.getGlyphPositions(),
		};
	}
	private matches(requested: string, candidate: string, style: DesignTextStyle, text: string): boolean {
		const canvas = this.document.createElement('canvas');
		canvas.width = 512;
		canvas.height = 80;
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		const sample = text.trim() || 'Ag';
		const raster = (family: string) => {
			context.clearRect(0, 0, 512, 80);
			context.font = `${style.fontStyle ?? 'normal'} ${style.fontWeight ?? 400} 32px ${family}`;
			context.fillText(sample, 4, 50);
			return context.getImageData(0, 0, 512, 80).data;
		};
		const a = raster(requested),
			width = context.measureText(sample).width,
			b = raster(`"${candidate.replaceAll('"', '\\"')}"`);
		if (Math.abs(width - context.measureText(sample).width) > 0.001) {
			return false;
		}
		return a.every((value, i) => value === b[i]);
	}
}

/** Convert TrueType quadratics to exact cubics; counter contours retain their winding. */
function glyphContours(commands: readonly PathCommand[], x: number, baseline: number, scale: number, shape: DesignTextShape): readonly DesignPathContour[] {
	const contours: DesignPathContour[] = [];
	let nodes: DesignPathNode[] = [];
	const point = (xValue: number, yValue: number) => ({
		x: (x + xValue * scale) / shape.width,
		y: (baseline - yValue * scale) / shape.height,
	});
	const close = () => {
		if (nodes.length > 1) {
			const first = nodes[0],
				last = nodes.at(-1)!;
			if (Math.abs(first.x - last.x) < 1e-10 && Math.abs(first.y - last.y) < 1e-10) {
				nodes[0] = { ...first, incoming: last.incoming };
				nodes.pop();
			}
			if (nodes.length >= 2) {
				contours.push({ nodes, closed: true });
			}
		}
		nodes = [];
	};
	for (const command of commands) {
		const args = command.args;
		if (command.command === 'moveTo') {
			close();
			const p = point(args[0], args[1]);
			nodes.push({ ...p, incoming: p, outgoing: p });
		} else if (command.command === 'closePath') {
			close();
		} else if (nodes.length) {
			const p = point(args[args.length - 2], args[args.length - 1]),
				last = nodes.at(-1)!;
			let incoming = p,
				outgoing = last;
			if (command.command === 'quadraticCurveTo') {
				const control = point(args[0], args[1]);
				outgoing = {
					...last,
					x: last.x + ((control.x - last.x) * 2) / 3,
					y: last.y + ((control.y - last.y) * 2) / 3,
				};
				incoming = { x: p.x + ((control.x - p.x) * 2) / 3, y: p.y + ((control.y - p.y) * 2) / 3 };
			} else if (command.command === 'bezierCurveTo') {
				outgoing = { ...last, ...point(args[0], args[1]) };
				incoming = point(args[2], args[3]);
			}
			nodes[nodes.length - 1] = { ...last, outgoing: { x: outgoing.x, y: outgoing.y } };
			nodes.push({ ...p, incoming, outgoing: p });
		}
	}
	close();
	return contours;
}
interface TextPiece {
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly rect: DOMRect;
	readonly font: Font;
	readonly direction: 'ltr' | 'rtl';
}

/** DOM ranges retain browser line breaking and placement; HarfBuzz shapes runs and Fontkit supplies glyph outlines. */
export async function outlineDesignText(shape: DesignTextShape, splitGlyphs: boolean): Promise<DesignShape> {
	const document = mainWindow.document;
	const query = (mainWindow as Window & { queryLocalFonts?: () => Promise<readonly LocalFontData[]> }).queryLocalFonts;
	let available: readonly LocalFontData[] = [];
	if (query && !importedFonts.length) {
		try {
			available = await query.call(mainWindow);
		} catch {
			/* Imported fonts still work when permission is denied. */
		}
	}
	const fonts = new OutlineFonts(available, document);
	const frame = renderDesignTextFrame(document, shape);
	Object.assign(frame.style, {
		position: 'fixed',
		left: '-100000px',
		top: '0',
		visibility: 'hidden',
		pointerEvents: 'none',
		width: `${shape.width}px`,
		height: `${shape.height}px`,
	});
	frame.setAttribute('aria-hidden', 'true');
	document.body.append(frame);
	try {
		await document.fonts.ready;
		materializeOutlineText(frame, shape);
		const origin = frame.getBoundingClientRect(),
			paths: DesignShape[] = [];
		let runStart = 0;
		for (const paragraph of frame.querySelectorAll<HTMLElement>('[data-text-paragraph]')) {
			for (const span of paragraph.querySelectorAll('span')) {
				const node = span.firstChild;
				if (!node || !node.textContent) {
					continue;
				}
				const style = getComputedStyle(span),
					text = node.textContent;
				const authored: DesignTextStyle = {
					fontFamily: style.fontFamily,
					fontSize: parseFloat(style.fontSize),
					fontWeight: Number(style.fontWeight),
					fontStyle: style.fontStyle === 'italic' ? 'italic' : 'normal',
					fontVariations: { ...shape.fontVariations },
					fontFeatures: { ...shape.fontFeatures },
				};
				for (const run of span.hasAttribute('data-outline-marker') ? [] : (shape.textRuns ?? [])) {
					if (runStart >= run.start && runStart < run.end) {
						Object.assign(authored, run.style);
					}
				}
				const pieces: TextPiece[] = [];
				const wordStarts = new Set([...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(segment => segment.isWordLike).map(segment => segment.index));
				for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
					const range = document.createRange();
					range.setStart(node, segment.index);
					range.setEnd(node, segment.index + segment.segment.length);
					const rect = range.getBoundingClientRect();
					if (shape.textTruncate && (rect.top >= origin.bottom || rect.bottom <= origin.top)) {
						continue;
					}
					const transformed =
						style.textTransform === 'uppercase'
							? segment.segment.toLocaleUpperCase()
							: style.textTransform === 'lowercase'
								? segment.segment.toLocaleLowerCase()
								: style.textTransform === 'capitalize' && wordStarts.has(segment.index)
									? segment.segment.toLocaleUpperCase()
									: segment.segment;
					const font = await fonts.resolve(authored, transformed);
					pieces.push({
						text: transformed,
						start: segment.index,
						end: segment.index + segment.segment.length,
						rect,
						font,
						direction: /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(transformed) ? 'rtl' : 'ltr',
					});
				}
				// Neutral punctuation and digits follow their browser bidi run, including mirrored brackets.
				for (let i = 0; i < pieces.length; i++) {
					if (/\p{Letter}/u.test(pieces[i].text)) {
						continue;
					}
					const next = pieces[i + 1],
						previous = pieces[i - 1];
					const direction =
						next && Math.abs(next.rect.top - pieces[i].rect.top) < 0.5
							? next.rect.left < pieces[i].rect.left
								? 'rtl'
								: 'ltr'
							: previous && Math.abs(previous.rect.top - pieces[i].rect.top) < 0.5
								? previous.rect.left > pieces[i].rect.left
									? 'rtl'
									: 'ltr'
								: pieces[i].direction;
					pieces[i] = { ...pieces[i], direction };
				}
				for (let i = 0; i < pieces.length;) {
					const first = pieces[i],
						group = [first];
					i++;
					while (
						i < pieces.length &&
						pieces[i].font === first.font &&
						pieces[i].direction === first.direction &&
						Math.abs(pieces[i].rect.top - first.rect.top) < 0.5 &&
						pieces[i].start === group.at(-1)!.end &&
						!/\s/u.test(pieces[i].text) &&
						!/\s/u.test(group.at(-1)!.text)
					) {
						group.push(pieces[i++]);
					}
					const value = group.map(piece => piece.text).join(''),
						font = first.font,
						size = authored.fontSize!,
						scale = size / font.unitsPerEm;
					const spacing = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing);
					const features = {
						...(spacing ? { liga: 0, clig: 0 } : {}),
						...authored.fontFeatures,
						...(style.fontVariantCaps === 'small-caps' ? { smcp: 1 } : {}),
					};
					const run = await fonts.shape(font, value, features, first.direction);
					const canvas = document.createElement('canvas'),
						context = canvas.getContext('2d')!;
					context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
					const metrics = context.measureText(value),
						baseline = first.rect.top - origin.top + metrics.fontBoundingBoxAscent;
					let x = Math.min(...group.map(piece => piece.rect.left)) - origin.left;
					for (const [index, glyph] of run.glyphs.entries()) {
						const position = run.positions[index],
							tracking = index === run.glyphs.length - 1 || run.clusters[index] !== run.clusters[index + 1] ? spacing : 0;
						if (glyph.codePoints.length && /^\s+$/u.test(String.fromCodePoint(...glyph.codePoints))) {
							x += position.xAdvance * scale + tracking;
							continue;
						}
						if (glyph.id === 0 && !/^\s*$/u.test(String.fromCodePoint(...glyph.codePoints))) {
							throw new Error(localize('sessions.design.outlineMissingGlyph', 'This font cannot outline one or more characters.'));
						}
						if (!glyph.path.commands.length && !/^[\s\u200c\u200d\ufe00-\ufe0f]*$/u.test(String.fromCodePoint(...glyph.codePoints))) {
							throw new Error(localize('sessions.design.outlineBitmapGlyph', 'This glyph has no vector outline. Bitmap-only color fonts cannot be converted to paths.'));
						}
						const bounds = glyph.path.bbox;
						const width = Math.max(0.001, (bounds.maxX - bounds.minX) * scale),
							height = Math.max(0.001, (bounds.maxY - bounds.minY) * scale);
						const contours = glyphContours(glyph.path.commands, -bounds.minX * scale, bounds.maxY * scale, scale, { ...shape, width, height });
						if (contours.length) {
							const path = flattenDesignVector(shape, contours);
							paths.push({
								...path,
								id: generateUuid(),
								x: x + position.xOffset * scale + bounds.minX * scale,
								y: baseline - position.yOffset * scale - bounds.maxY * scale,
								width,
								height,
								rotation: 0,
								opacity: undefined,
								effects: undefined,
								motion: undefined,
								interactions: undefined,
								constraints: undefined,
								sizing: undefined,
								sizeLimits: undefined,
								gridCell: undefined,
								layoutPositioning: undefined,
								name: glyphName(glyph),
								fill: cssColor(style.color),
								bindings: undefined,
								styleBindings: undefined,
							});
						}
						x += position.xAdvance * scale + tracking;
					}
					const width = Math.max(...group.map(piece => piece.rect.right)) - Math.min(...group.map(piece => piece.rect.left));
					const left = Math.min(...group.map(piece => piece.rect.left)) - origin.left;
					for (const decoration of ['underline', 'line-through']) {
						if (!style.textDecorationLine.includes(decoration)) {
							continue;
						}
						const y = baseline - (decoration === 'underline' ? font.underlinePosition : font.xHeight / 2) * scale,
							height = Math.max(0.5, font.underlineThickness * scale);
						const nodes = [
							[left, y],
							[left + width, y],
							[left + width, y + height],
							[left, y + height],
						].map(([x, y]) => {
							const point = { x: x / shape.width, y: y / shape.height };
							return { ...point, incoming: point, outgoing: point };
						});
						paths.push({
							...flattenDesignVector(shape, [{ closed: true, nodes }]),
							id: generateUuid(),
							x: 0,
							y: 0,
							rotation: 0,
							fill: cssColor(style.color),
							opacity: undefined,
							effects: undefined,
							motion: undefined,
							interactions: undefined,
							bindings: undefined,
							styleBindings: undefined,
						});
					}
				}
				if (!span.hasAttribute('data-outline-marker')) {
					runStart += text.length;
				}
			}
			runStart++;
		}
		if (shape.textTruncate) {
			await loadDesignVectorGeometry();
			for (let i = paths.length - 1; i >= 0; i--) {
				const path = paths[i];
				const contours = getDesignVectorContours(path, false, {
					x: -path.x,
					y: -path.y,
					width: shape.width,
					height: shape.height,
				});
				if (contours.length) {
					paths[i] = flattenDesignVector(path, contours);
				} else {
					paths.splice(i, 1);
				}
			}
		}
		if (!paths.length) {
			throw new Error(localize('sessions.design.outlineEmptyText', 'This text has no visible glyph outlines.'));
		}
		if (!splitGlyphs) {
			const fill = paths[0].fill;
			const contours = paths.flatMap(path =>
				path.kind === 'path'
					? [{ nodes: path.nodes, closed: path.closed }, ...(path.subpaths ?? [])].map(contour => {
							const point = (point: { x: number; y: number }) => ({
								x: (path.x + point.x * path.width) / shape.width,
								y: (path.y + point.y * path.height) / shape.height,
							});
							return {
								...contour,
								nodes: contour.nodes.map(node => ({
									...point(node),
									incoming: point(node.incoming),
									outgoing: point(node.outgoing),
								})),
								...(path.fill !== fill ? { fill: path.fill } : {}),
							};
						})
					: [],
			);
			if (contours.length > 1001 || contours.reduce((sum, contour) => sum + contour.nodes.length, 0) > 10000) {
				throw new Error(localize('sessions.design.outlineTooComplex', 'This text exceeds the single-path point limit. Use Outline stroke to keep separate glyph layers.'));
			}
			return stripTextBindings({ ...flattenDesignVector(shape, contours), fill });
		}
		const geometry = stripTextBindings(flattenDesignVector(shape, [{ nodes: [], closed: false }]));
		const { nodes: _nodes, closed: _closed, subpaths: _subpaths, strokeWidth: _strokeWidth, fillRule: _fillRule, kind: _kind, ...common } = geometry;
		return { ...common, kind: 'group', contentWidth: shape.width, contentHeight: shape.height, children: paths };
	} finally {
		frame.remove();
	}
}
/** CSS markers and ellipsis are painted content, not text nodes. Materialize them only in the off-screen clone. */
function materializeOutlineText(frame: HTMLElement, shape: DesignTextShape): void {
	const document = frame.ownerDocument,
		root = frame.querySelector<HTMLElement>('[data-design-text]')!;
	for (const [index, paragraph] of [...frame.querySelectorAll<HTMLElement>('[data-text-paragraph]')].entries()) {
		const style = getComputedStyle(paragraph);
		if (style.display !== 'list-item') {
			continue;
		}
		const first = paragraph.querySelector('span')?.firstChild;
		const range = document.createRange();
		if (first) {
			range.setStart(first, 0);
			range.setEnd(first, Math.min(1, first.textContent?.length ?? 0));
		}
		const before = first ? range.getBoundingClientRect().left : 0;
		const marker = document.createElement('span');
		marker.dataset.outlineMarker = '';
		marker.textContent = style.listStyleType === 'decimal' ? `${index + 1}. ` : '• ';
		paragraph.style.display = 'block';
		paragraph.prepend(marker);
		if (first) {
			marker.style.marginInlineEnd = `${before - range.getBoundingClientRect().left}px`;
		}
	}
	if (!shape.textTruncate) {
		return;
	}
	const align = frame.style.justifyContent;
	frame.style.justifyContent = 'flex-start';
	root.style.display = 'block';
	root.style.webkitLineClamp = '';
	root.style.overflow = 'visible';
	const lineHeight = shape.lineHeight === undefined ? shape.fontSize * 1.2 : shape.lineHeightUnit === 'percent' ? (shape.fontSize * shape.lineHeight) / 100 : shape.lineHeight;
	const maxLines = shape.maxLines ?? Math.max(1, Math.floor(shape.height / Math.max(0.001, lineHeight)));
	const characters: { node: Text; start: number; end: number; top: number }[] = [];
	for (const span of root.querySelectorAll('span')) {
		const node = span.firstChild as Text | null;
		if (!node) {
			continue;
		}
		const style = getComputedStyle(span),
			context = document.createElement('canvas').getContext('2d')!;
		context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		for (const segment of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(node.data)) {
			const range = document.createRange();
			range.setStart(node, segment.index);
			range.setEnd(node, segment.index + segment.segment.length);
			characters.push({
				node,
				start: segment.index,
				end: segment.index + segment.segment.length,
				top: range.getBoundingClientRect().top + context.measureText(segment.segment).fontBoundingBoxAscent,
			});
		}
	}
	const lines = [...new Set(characters.map(char => Math.round(char.top)))].sort((a, b) => a - b);
	if (lines.length > maxLines) {
		const lastTop = lines[maxLines - 1],
			visible = characters.filter(char => Math.round(char.top) <= lastTop);
		const last = visible.at(-1);
		if (last) {
			last.node.data = last.node.data.slice(0, last.end);
			const spans = [...root.querySelectorAll('span')],
				lastSpan = last.node.parentElement!,
				lastIndex = spans.indexOf(lastSpan);
			for (const span of spans.slice(lastIndex + 1)) {
				span.remove();
			}
			const paragraphs = [...root.querySelectorAll('[data-text-paragraph]')],
				paragraph = lastSpan.closest('[data-text-paragraph]')!;
			for (const item of paragraphs.slice(paragraphs.indexOf(paragraph) + 1)) {
				item.remove();
			}
			// Remove whole graphemes until the ellipsis stays on the last visible line.
			let content = last.node.data;
			while (true) {
				last.node.data = content + '…';
				const range = document.createRange();
				range.setStart(last.node, content.length);
				range.setEnd(last.node, last.node.length);
				const style = getComputedStyle(lastSpan),
					context = document.createElement('canvas').getContext('2d')!;
				context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				if (Math.round(range.getBoundingClientRect().top + context.measureText('…').fontBoundingBoxAscent) <= lastTop || !content) {
					break;
				}
				const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(content)];
				content = content.slice(0, segments.at(-1)!.index);
			}
		}
	}
	frame.style.justifyContent = align;
}
function stripTextBindings(path: Extract<DesignShape, { kind: 'path' }>): typeof path {
	return {
		...path,
		bindings: path.bindings ? Object.fromEntries(Object.entries(path.bindings).filter(([key]) => ['fill', 'opacity', 'visible', 'width', 'height'].includes(key))) : undefined,
		styleBindings: path.styleBindings ? Object.fromEntries(Object.entries(path.styleBindings).filter(([key]) => key !== 'text')) : undefined,
	};
}
function glyphName(glyph: Glyph): string {
	return glyph.codePoints.length ? String.fromCodePoint(...glyph.codePoints) : glyph.name;
}
function cssColor(color: string): string {
	const values = color.match(/[\d.]+/gu)?.map(Number) ?? [128, 128, 128];
	return (
		'#' +
		values
			.slice(0, 3)
			.map(value => Math.round(value).toString(16).padStart(2, '0'))
			.join('') +
		(values[3] !== undefined && values[3] < 1
			? Math.round(values[3] * 255)
					.toString(16)
					.padStart(2, '0')
			: '')
	);
}
