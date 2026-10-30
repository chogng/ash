import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { optimize } from 'svgo';
import { generateToTs } from './generate-to-ts.ts';

const repositoryDirectory = resolve(import.meta.dirname, '../../..');
const iconDirectory = resolve(repositoryDirectory, 'resources/icons');
const defaultOutputs: IconOutputs = {
	manifestFile: resolve(iconDirectory, 'manifest.json'),
	typescriptFile: resolve(repositoryDirectory, 'src/ash/base/common/lxiconsLibrary.ts'),
};
const iconFilePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.svg$/;
const unsafeSvgPattern = /<(?:script|foreignObject)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=/i;
const paintAttributePattern = /\b(?:fill|stroke)="([^"]+)"/g;
const symbolicPaints = new Set([
	'#000',
	'#000000',
	'#fff',
	'#ffffff',
	'black',
	'currentcolor',
	'none',
	'white',
]);

export type IconRendering = 'multicolor' | 'symbolic';
type IconSourceHandling = 'check' | 'ignore' | 'write';

export interface IconOutputs {
	readonly manifestFile?: string;
	readonly typescriptFile?: string;
}

export interface GenerateIconsOptions {
	readonly outputs?: IconOutputs;
	readonly sourceDirectory?: string;
	readonly sourceHandling?: IconSourceHandling;
}

export interface GenerateIconsReport {
	readonly count: number;
	readonly outputChanged: boolean;
	readonly sourceChanged: boolean;
}

export interface GeneratedIcon {
	readonly fileName: string;
	readonly id: string;
	readonly propertyName: string;
	readonly rendering: IconRendering;
	readonly sourcePath: string;
	readonly svg: string;
	readonly fontCharacter?: string;
	readonly layers?: readonly { readonly id: string; readonly fontCharacter: string; readonly origin: readonly [number, number]; }[];
}

interface IconSourceUpdate {
	readonly content: string;
	readonly fileName: string;
	readonly path: string;
}

interface IconCompilation {
	readonly icons: GeneratedIcon[];
	readonly sourceUpdates: readonly IconSourceUpdate[];
}

interface GeneratedOutput {
	readonly content: string;
	readonly label: string;
	readonly path: string;
}

export async function generateIcons(options: GenerateIconsOptions = {}): Promise<GenerateIconsReport> {
	const sourceDirectory = options.sourceDirectory ?? iconDirectory;
	const sourceHandling = options.sourceHandling ?? 'write';
	const outputs = options.outputs ?? defaultOutputs;
	const compilation = await compileIcons(sourceDirectory);
	if (outputs.typescriptFile) {
		const path = resolve(sourceDirectory, 'font/manifest.json');
		// A missing prepared font must never silently turn the catalog into SVG icons.
		const font: { codepoints: Record<string, string>; sources: Record<string, string>; layers?: Record<string, readonly { id: string; glyph: string; origin: readonly [number, number]; }[]>; } = JSON.parse(await readFile(path, 'utf8'));
		for (let i = 0; i < compilation.icons.length; i++) {
			const icon = compilation.icons[i]!;
			if (font.sources[icon.id] !== createHash('sha256').update(icon.svg.trim()).digest('hex')) {
				throw new Error(`Icon font is stale for '${icon.id}'. Run 'pnpm icons:build'.`);
			}
			const point = font.codepoints[icon.id];
			if (!point || !/^[E-F][0-9A-F]{3}$/u.test(point)) throw new TypeError(`Missing icon font codepoint: ${icon.id}`);
			const preparedLayers = Object.hasOwn(font.layers ?? {}, icon.id) ? font.layers![icon.id] : undefined;
			if (preparedLayers && !Array.isArray(preparedLayers)) throw new TypeError(`Invalid prepared font layers: ${icon.id}`);
			const layers = preparedLayers?.map(layer => {
				const point = font.codepoints[layer.glyph];
				if (!/^[a-z][a-z0-9-]*$/u.test(layer.id) || !point || !/^[E-F][0-9A-F]{3}$/u.test(point)
					|| !Array.isArray(layer.origin) || layer.origin.length !== 2 || layer.origin.some((value: number) => !Number.isFinite(value) || value < 0 || value > 1)) {
					throw new TypeError(`Invalid prepared font layer: ${icon.id}`);
				}
				return { id: layer.id, fontCharacter: String.fromCodePoint(Number.parseInt(point, 16)), origin: layer.origin };
			});
			compilation.icons[i] = { ...icon, fontCharacter: String.fromCodePoint(Number.parseInt(point, 16)), ...(layers ? { layers } : {}) };
		}
	}
	const generatedOutputs = compileOutputs(compilation.icons, outputs);
	const staleOutputs = await findStaleOutputs(generatedOutputs);

	if (sourceHandling === 'check') {
		const failures = [
			...compilation.sourceUpdates.map((update) => `source:${update.fileName}`),
			...staleOutputs.map((output) => output.label),
		];
		if (failures.length > 0) {
			throw new Error(`Product icons require generation: ${failures.join(', ')}. Run 'pnpm icons:generate'.`);
		}
		return { count: compilation.icons.length, outputChanged: false, sourceChanged: false };
	}

	if (sourceHandling === 'write') {
		await Promise.all(compilation.sourceUpdates.map((update) => writeFile(update.path, update.content, 'utf8')));
	}
	await Promise.all(staleOutputs.map((output) => writeTextFile(output.path, output.content)));
	return {
		count: compilation.icons.length,
		outputChanged: staleOutputs.length > 0,
		sourceChanged: sourceHandling === 'write' && compilation.sourceUpdates.length > 0,
	};
}

export async function checkIcons(options: Omit<GenerateIconsOptions, 'sourceHandling'> = {}): Promise<GenerateIconsReport> {
	return generateIcons({ ...options, sourceHandling: 'check' });
}

async function compileIcons(sourceDirectory: string): Promise<IconCompilation> {
	const iconFiles = (await readdir(sourceDirectory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && extname(entry.name) === '.svg')
		.map((entry) => entry.name)
		.sort((left, right) => {
			const leftId = basename(left, '.svg');
			const rightId = basename(right, '.svg');
			return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
		});
	if (iconFiles.length === 0) {
		throw new Error(`No product icons found in ${sourceDirectory}`);
	}

	const icons: GeneratedIcon[] = [];
	const propertyNames = new Set<string>();
	const sourceUpdates: IconSourceUpdate[] = [];
	for (const fileName of iconFiles) {
		if (!iconFilePattern.test(fileName)) {
			throw new Error(`Invalid product icon filename '${fileName}'`);
		}
		const sourcePath = resolve(sourceDirectory, fileName);
		const source = await readFile(sourcePath, 'utf8');
		const svg = source.trim();
		validateSvg(fileName, svg);
		const optimizedSvg = optimizeSvg(fileName, svg);
		validateSvg(fileName, optimizedSvg);

		const canonicalSource = `${optimizedSvg}\n`;
		if (source !== canonicalSource) {
			sourceUpdates.push({ content: canonicalSource, fileName, path: sourcePath });
		}

		const id = basename(fileName, '.svg');
		const propertyName = typescriptPropertyName(id);
		if (propertyNames.has(propertyName)) {
			throw new Error(`Duplicate generated TypeScript icon name '${propertyName}'`);
		}

		propertyNames.add(propertyName);
		icons.push({
			fileName,
			id,
			propertyName,
			rendering: renderingMode(optimizedSvg),
			sourcePath,
			svg: optimizedSvg,
		});
	}
	return { icons, sourceUpdates };
}

function compileOutputs(icons: readonly GeneratedIcon[], outputs: IconOutputs): GeneratedOutput[] {
	const generated: GeneratedOutput[] = [];
	if (outputs.manifestFile) {
		generated.push({ content: generateManifest(icons), label: 'manifest', path: outputs.manifestFile });
	}
	if (outputs.typescriptFile) {
		generated.push({ content: generateToTs(icons), label: 'typescript', path: outputs.typescriptFile });
	}
	if (generated.length === 0) {
		throw new Error('Product icon generation requires at least one output');
	}
	return generated;
}

function generateManifest(icons: readonly GeneratedIcon[]): string {
	return `${JSON.stringify({
		version: 1,
		icons: icons.map(({ fileName, id, rendering }) => ({ id, file: fileName, rendering })),
	}, null, 2)}\n`;
}

function renderingMode(svg: string): IconRendering {
	for (const [, paint] of svg.matchAll(paintAttributePattern)) {
		if (!symbolicPaints.has(paint.toLowerCase())) {
			return 'multicolor';
		}
	}
	return 'symbolic';
}

function validateSvg(fileName: string, svg: string): void {
	if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) {
		throw new Error(`Product icon '${fileName}' must contain one SVG root`);
	}
	if ((svg.match(/<svg\b/g) ?? []).length !== 1 || (svg.match(/<\/svg>/g) ?? []).length !== 1) {
		throw new Error(`Product icon '${fileName}' must contain exactly one SVG root`);
	}
	if (unsafeSvgPattern.test(svg)) {
		throw new Error(`Product icon '${fileName}' contains unsupported active or external content`);
	}
}

function optimizeSvg(fileName: string, svg: string): string {
	const iconName = basename(fileName, '.svg');
	return optimize(svg, {
		path: fileName,
		multipass: true,
		plugins: [
			// Layer IDs are build inputs for the animated brand glyphs.
			iconName === 'ash-mark' ? { name: 'preset-default' as const, params: { overrides: { cleanupIds: false } } } : 'preset-default',
			...(iconName === 'ash-mark' ? [] : [{
				name: 'prefixIds' as const,
				params: {
					delim: '-',
					prefix: `ash-${iconName}`,
				},
			}]),
			'removeDimensions',
		],
	}).data.trim();
}

function typescriptPropertyName(id: string): string {
	const words = id.split('-');
	return `${words[0]}${words.slice(1).map(capitalize).join('')}`;
}

function capitalize(value: string): string {
	return `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function findStaleOutputs(outputs: readonly GeneratedOutput[]): Promise<GeneratedOutput[]> {
	const stale: GeneratedOutput[] = [];
	for (const output of outputs) {
		try {
			const current = await readFile(output.path, 'utf8');
			if (normalizeNewlines(current) !== output.content) {
				stale.push(output);
			}
		} catch (error: unknown) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
				throw error;
			}
			stale.push(output);
		}
	}
	return stale;
}

function normalizeNewlines(content: string): string {
	return content.replaceAll('\r\n', '\n');
}

async function writeTextFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			check: { type: 'boolean' },
			'catalog-only': { type: 'boolean' },
			'source-directory': { type: 'string' },
			'typescript-file': { type: 'string' },
		}
	});
	if (values.check && values['catalog-only']) throw new Error('--check and --catalog-only are mutually exclusive');
	const sourceDirectory = resolve(values['source-directory'] ?? iconDirectory);
	const options: GenerateIconsOptions = {
		sourceDirectory,
		outputs: {
			manifestFile: resolve(sourceDirectory, 'manifest.json'),
			...(values['catalog-only'] ? {} : { typescriptFile: resolve(values['typescript-file'] ?? defaultOutputs.typescriptFile!) }),
		},
	};
	if (values.check) {
		const report = await checkIcons(options);
		console.log(`Validated ${report.count} product icons and generated outputs.`);
	} else {
		const report = await generateIcons(options);
		const status = report.outputChanged || report.sourceChanged ? 'Generated' : 'Already generated';
		console.log(`${status} ${report.count} product icons and generated outputs.`);
	}
}
