import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const iconSource = join(root, 'resources', 'darwin', 'ash.icon');
const traySource = join(root, 'resources', 'tray', 'ash-black.svg');
const developerDirectory = process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer';
const check = process.argv.slice(2).includes('--check');

if (process.platform !== 'darwin') throw new Error('macOS icon generation requires macOS and Xcode 26');
if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('Usage: macos-icon.ts [--check]');

const temporaryRoot = await mkdtemp(join(tmpdir(), 'ash-macos-icon-'));
try {
	const compiledIcon = join(temporaryRoot, 'Icon.icon');
	const outputDirectory = join(temporaryRoot, 'out');
	await cp(iconSource, compiledIcon, { recursive: true });
	await mkdir(outputDirectory);
	await run('xcrun', [
		'actool', compiledIcon,
		'--compile', outputDirectory,
		'--output-format', 'human-readable-text',
		'--notices', '--warnings', '--errors',
		'--output-partial-info-plist', join(outputDirectory, 'info.plist'),
		'--app-icon', 'Icon',
		'--include-all-app-icons',
		'--enable-on-demand-resources', 'NO',
		'--development-region', 'en',
		'--target-device', 'mac',
		'--minimum-deployment-target', '26.0',
		'--platform', 'macosx',
		'--standalone-icon-behavior', 'all',
	], { env: { ...process.env, DEVELOPER_DIR: developerDirectory } });
	const icns = join(outputDirectory, 'Icon.icns');
	const png = join(outputDirectory, 'Icon.png');
	await run('sips', ['-s', 'format', 'png', icns, '--out', png]);

	const outputs = [
		{ path: join(root, 'resources', 'darwin', 'ash.icns'), bytes: await readFile(icns) },
		{ path: join(root, 'resources', 'darwin', 'ash.png'), bytes: await readFile(png) },
	];
	const artwork = (await readFile(traySource)).toString('base64');
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		for (const size of [18, 27, 36]) {
			const dataUrl = await page.evaluate(async ({ artwork, size }) => {
				const image = new Image();
				image.src = `data:image/svg+xml;base64,${artwork}`;
				await image.decode();
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				canvas.getContext('2d')!.drawImage(image, 0, 0, size, size);
				return canvas.toDataURL('image/png');
			}, { artwork, size });
			outputs.push({
				path: join(root, 'resources', 'tray', `ash-black-${size}.png`),
				bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
			});
		}
	} finally {
		await browser.close();
	}

	if (check) {
		const stale: string[] = [];
		for (const output of outputs) {
			if (!(await readFile(output.path)).equals(output.bytes)) stale.push(output.path);
		}
		if (stale.length) throw new Error(`macOS icon outputs are stale. Run pnpm macos-icon:generate:\n${stale.join('\n')}`);
		console.log('Validated macOS Dock and menu bar icon outputs.');
	} else {
		for (const output of outputs) await writeFile(output.path, output.bytes);
		console.log('Generated macOS Dock and menu bar icon outputs.');
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
