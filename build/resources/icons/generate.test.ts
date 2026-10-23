import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkIcons, generateIcons, type IconOutputs } from './generate.ts';

const addSvg = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path stroke="black" d="M2.5 8h11M8 2.5v11"/></svg>\n';

function outputs(root: string): IconOutputs {
	return { manifestFile: join(root, 'icons/manifest.json'), typescriptFile: join(root, 'generated/lxiconsLibrary.ts') };
}

/** Models the resource toolchain publishing a font and its matching source fingerprints. */
async function prepareFont(sourceDirectory: string, codepoints: Record<string, string>, color: Record<string, string> = {}): Promise<void> {
	await generateIcons({ sourceDirectory, outputs: { manifestFile: join(sourceDirectory, 'manifest.json') } });
	const sources: Record<string, string> = {};
	for (const file of await readdir(sourceDirectory)) {
		if (file.endsWith('.svg')) sources[file.slice(0, -4)] = createHash('sha256').update((await readFile(join(sourceDirectory, file), 'utf8')).trim()).digest('hex');
	}
	await mkdir(join(sourceDirectory, 'font'), { recursive: true });
	await writeFile(join(sourceDirectory, 'font/manifest.json'), JSON.stringify({ codepoints, color, sources }));
}

test('the resource catalog tracks SVG changes and canonicalizes artwork without a font build', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-product-icons-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceDirectory = join(root, 'icons');
	const catalog = { manifestFile: join(sourceDirectory, 'manifest.json') };
	await mkdir(sourceDirectory);
	await writeFile(join(sourceDirectory, 'add.svg'), addSvg);
	const report = await generateIcons({ sourceDirectory, outputs: catalog });
	assert.equal(report.sourceChanged, true);
	assert.doesNotMatch(await readFile(join(sourceDirectory, 'add.svg'), 'utf8'), /\b(?:width|height)="16"/);
	assert.equal((await checkIcons({ sourceDirectory, outputs: catalog })).count, 1);
	await writeFile(join(sourceDirectory, 'close.svg'), addSvg.replace('black', 'red'));
	await generateIcons({ sourceDirectory, outputs: catalog });
	assert.deepEqual(JSON.parse(await readFile(catalog.manifestFile, 'utf8')).icons.map(({ id, rendering }: { id: string; rendering: string; }) => ({ id, rendering })), [
		{ id: 'add', rendering: 'symbolic' }, { id: 'close', rendering: 'multicolor' },
	]);
	await unlink(join(sourceDirectory, 'close.svg'));
	assert.equal((await generateIcons({ sourceDirectory, outputs: catalog })).count, 1);
});

test('the runtime library registers stable codepoints for both monochrome and color glyphs', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-product-icons-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceDirectory = join(root, 'icons');
	await mkdir(sourceDirectory);
	await writeFile(join(sourceDirectory, 'add.svg'), addSvg);
	await writeFile(join(sourceDirectory, 'export.svg'), addSvg);
	await writeFile(join(sourceDirectory, 'close.svg'), addSvg.replace('black', 'red'));
	await prepareFont(sourceDirectory, { add: 'E004', export: 'E010', close: 'E020' }, { close: 'Fixed color' });
	const generatedOutputs = outputs(root);
	await generateIcons({ sourceDirectory, outputs: generatedOutputs });
	const generated = await readFile(generatedOutputs.typescriptFile!, 'utf8');
	assert.match(generated, /add: registerLxicon\("add", 0xe004\)/);
	assert.match(generated, /export: registerLxicon\("export", 0xe010\)/);
	assert.match(generated, /close: registerLxicon\("close", 0xe020\)/);
	assert.doesNotMatch(generated, /<svg|fallback|artwork|createProductIconLibrary|\.svg/);
	assert.equal((await generateIcons({ sourceDirectory, outputs: generatedOutputs })).outputChanged, false);
	await writeFile(generatedOutputs.typescriptFile!, 'stale');
	await assert.rejects(checkIcons({ sourceDirectory, outputs: generatedOutputs }), /require generation: typescript/);
	assert.equal(await readFile(generatedOutputs.typescriptFile!, 'utf8'), 'stale');
});

test('runtime generation rejects missing or stale font inputs instead of emitting an SVG catalog', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-product-icons-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceDirectory = join(root, 'icons');
	await mkdir(sourceDirectory);
	await writeFile(join(sourceDirectory, 'add.svg'), addSvg);
	const options = { sourceDirectory, outputs: outputs(root), sourceHandling: 'ignore' as const };
	await assert.rejects(generateIcons(options), { code: 'ENOENT' });
	await prepareFont(sourceDirectory, {});
	await assert.rejects(generateIcons(options), /Missing icon font codepoint: add/);
	await prepareFont(sourceDirectory, { add: 'E004' });
	await writeFile(join(sourceDirectory, 'add.svg'), addSvg.replace('M2.5', 'M3.5'));
	await assert.rejects(generateIcons(options), /Icon font is stale for 'add'/);
	await assert.rejects(readFile(options.outputs.typescriptFile!), { code: 'ENOENT' });
});

test('product icon generation rejects linked or active SVG content', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-product-icons-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, 'linked.svg'), '<svg viewBox="0 0 16 16"><a href="https://example.test"><path d="M0 0h1v1z"/></a></svg>');
	await assert.rejects(generateIcons({ sourceDirectory: root, outputs: { manifestFile: join(root, 'manifest.json') } }), /unsupported active or external content/);
});
