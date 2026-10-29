import { chmod, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Stages an offline PDF MCP + Skill package; signing and installation remain with Extensions. */
export async function buildPdfReadingPackage(source: string, output: string): Promise<void> {
	if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('The packaged stdio launcher currently supports macOS and Linux; build and validate on the target host');
	try { await stat(output); throw new Error('Refusing to replace an existing PDF reading submission'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	const staging = output + '.partial-' + crypto.randomUUID();
	const payload = join(staging, 'package');
	const server = join(payload, 'server');
	const require = createRequire(join(source, 'package.json'));
	const { build } = require('esbuild') as typeof import('esbuild');
	try {
		await mkdir(server, { recursive: true });
		const bundled = await build({ metafile: true, entryPoints: { server: join(source, 'ai/server.ts'), worker: join(source, 'ai/worker.ts') }, outdir: server, outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', target: 'node22', bundle: true, external: ['pdfjs-dist/*', '@napi-rs/canvas'], banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" }, logLevel: 'silent' });
		await writeBundledNotices(Object.keys(bundled.metafile.inputs), payload);
		await writeFile(join(server, 'launch'), '#!/usr/bin/env node\nimport("./server.mjs").catch(error => { console.error(error.message); process.exitCode = 1; });\n', { mode: 0o755 });
		await chmod(join(server, 'launch'), 0o755);
		const modules = join(server, 'node_modules');
		const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
		for (const path of ['package.json', 'LICENSE', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps', 'standard_fonts', 'wasm']) {
			const target = join(modules, 'pdfjs-dist', path);
			await mkdir(dirname(target), { recursive: true });
			await cp(join(pdfRoot, path), target, { recursive: true, dereference: true });
		}
		const canvasRoot = dirname(require.resolve('@napi-rs/canvas/package.json'));
		await cp(canvasRoot, join(modules, '@napi-rs/canvas'), { recursive: true, dereference: true, filter: path => !path.slice(canvasRoot.length + 1).startsWith('node_modules') });
		require('@napi-rs/canvas');
		const native = Object.keys(require.cache).find(path => path.includes('@napi-rs') && path.endsWith('.node'));
		if (!native) throw new Error('The target host has no supported canvas binary');
		const nativeRoot = dirname(native);
		const nativePackage = JSON.parse(await readFile(join(nativeRoot, 'package.json'), 'utf8'));
		const nativeBytes = await readFile(native);
		const compressed = gzipSync(nativeBytes, { level: 9 });
		if (nativeBytes.length > 64 * 1024 * 1024 || compressed.length > 16 * 1024 * 1024) throw new Error('Canvas binary exceeds the supported package budget');
		await writeFile(join(server, 'canvas.node.gz'), compressed);
		await writeFile(join(server, 'native.json'), JSON.stringify({ bytes: nativeBytes.length, sha256: createHash('sha256').update(nativeBytes).digest('hex') }) + '\n');
		await cp(join(nativeRoot, 'package.json'), join(server, 'native-package.json'));
		await mkdir(join(payload, 'mcp'));
		await writeFile(join(payload, 'mcp/package.json'), JSON.stringify({ schemaVersion: 1, transport: 'stdio', command: 'server/launch', args: [] }, null, 2) + '\n');
		await cp(join(source, 'ai/skill'), join(payload, 'skills/pdf-reading'), { recursive: true });
		await cp(join(source, 'ai/README.md'), join(payload, 'README.md'));
		await cp(resolve(source, '../../LICENSE'), join(payload, 'LICENSE'));
		await cp(join(dirname(require.resolve('@modelcontextprotocol/sdk/server/index.js')), '../../..', 'LICENSE'), join(payload, 'MCP-SDK-LICENSE'));
		await writeFile(join(payload, 'runtime.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, node: '>=22.13.0', canvas: nativePackage.name, pdfjs: JSON.parse(await readFile(join(pdfRoot, 'package.json'), 'utf8')).version }, null, 2) + '\n');
		await writeFile(join(staging, 'catalog.json'), JSON.stringify({ schemaVersion: 2, packageType: 'plugin', source: 'official', id: 'ash/pdf-reading', version: '1.0.0', displayName: 'PDF Reading', description: 'Read PDF text and page images with AI, with page citations and source version checks.', license: 'LicenseRef-Ash', capabilities: [{ kind: 'mcp', id: 'pdf-reading', path: 'mcp/package.json' }, { kind: 'skill', id: 'pdf-reading', path: 'skills/pdf-reading' }] }, null, 2) + '\n');
		await rename(staging, output);
	} catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

/** Preserve licenses for the dependencies whose code esbuild includes in the stdio runtime. */
async function writeBundledNotices(inputs: string[], payload: string): Promise<void> {
	const packages = new Set<string>();
	for (const input of inputs.filter(path => path.includes('node_modules/'))) {
		let directory = dirname(resolve(input));
		while (directory !== dirname(directory)) {
			try {
				const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
				if (typeof manifest.name === 'string') { packages.add(directory); break; }
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			directory = dirname(directory);
		}
	}
	const notices: string[] = [];
	for (const directory of [...packages].sort()) {
		const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
		notices.push(`${manifest.name}@${manifest.version} (${manifest.license ?? 'see source license'})`);
		for (const file of (await readdir(directory)).filter(name => /^(?:license|licence|copying|notice)(?:[.-]|$)/iu.test(name)).sort()) {
			if ((await stat(join(directory, file))).isFile()) notices.push(await readFile(join(directory, file), 'utf8'));
		}
	}
	await writeFile(join(payload, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
	const output = process.argv[2];
	if (!output) throw new Error('Usage: node extensions/pdf-viewer/ai/package.ts <new-submission-directory>');
	await buildPdfReadingPackage(resolve(import.meta.dirname, '..'), resolve(output));
}
