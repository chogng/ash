import { execFile } from 'node:child_process';
import { basename, dirname, extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import { watchRebuild, type RebuildServer } from '../../lib/watchRebuild.ts';
import { pythonCommand } from '../../python.ts';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../..');
const scripts = resolve(repository, '.agents/skills/svg-icon-font/scripts');

interface ProductIconsPluginOptions {
	readonly sourceDirectory?: string;
	readonly outputFile?: string;
	readonly fontDirectory?: string;
	readonly debounceMilliseconds?: number;
}

interface ProductIconsServer extends RebuildServer {
	readonly watcher: RebuildServer['watcher'] & { add(path: string): unknown; };
}

export type AshProductIconsPlugin = Omit<Plugin, 'configureServer' | 'handleHotUpdate' | 'config'> & {
	readonly configureServer: (server: ProductIconsServer) => void;
	readonly config: () => Promise<void>;
	readonly handleHotUpdate: (context: { readonly file: string; }) => [] | undefined;
};

/**
 * Rebuilds both WOFF2 faces and their codepoint catalog after SVG imports.
 * The resource compiler owns dependencies, staging and publication; Vite only
 * schedules it and reloads after the complete generation succeeds.
 */
export function productIconsPlugin(options: ProductIconsPluginOptions = {}): AshProductIconsPlugin {
	const sourceDirectory = resolve(options.sourceDirectory ?? resolve(import.meta.dirname, '../../../resources/icons'));
	const outputFile = resolve(options.outputFile ?? resolve(import.meta.dirname, '../../../src/ash/base/common/lxiconsLibrary.ts'));
	const fontDirectory = resolve(options.fontDirectory ?? resolve(repository, 'src/ash/base/browser/ui/lxicons'));
	const inputs = [
		resolve(sourceDirectory, 'font/sessions.json'),
		resolve(sourceDirectory, 'variable/sidebar/manifest.yaml'),
		resolve(scripts, '../requirements.txt'),
		resolve(repository, '.agents/skills/variable-iconfont/scripts/vifont.py'),
		resolve(repository, 'build/resources/icons/generate.ts'),
		resolve(repository, 'build/resources/icons/generate-to-ts.ts'),
		resolve(repository, 'build/lib/generatedTypeScript.ts'),
		resolve(repository, 'build/format.ts'),
		resolve(repository, 'pnpm-lock.yaml'),
		resolve(repository, 'tsfmt.json'),
		resolve(repository, '.prettierrc.toml'),
	];
	const accepts = (path: string): boolean =>
		isDirectSvgChild(path, sourceDirectory) ||
		(samePath(dirname(resolve(path)), scripts) && extname(path) === '.py' && !basename(path).startsWith('test_')) ||
		inputs.some(input => samePath(resolve(path), input));
	const debounceMilliseconds = options.debounceMilliseconds ?? 50;
	let stopWatching: (() => Promise<void>) | undefined;

	async function rebuild(): Promise<boolean> {
		const { command, args } = pythonCommand([
			'-B',
			resolve(scripts, 'build_product_font.py'),
			'--source-directory',
			sourceDirectory,
			'--font-directory',
			fontDirectory,
			'--typescript-file',
			outputFile,
		]);
		const { stdout } = await execute(command, args, {
			cwd: repository,
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
		});
		const report: unknown = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)!);
		if (!report || typeof report !== 'object' || !('changed' in report) || typeof report.changed !== 'boolean') {
			throw new Error('Icon font compiler did not report a completed generation');
		}
		return report.changed;
	}

	return {
		name: 'ash-product-icons',
		apply: 'serve',
		async config() {
			// Vite resolves replacement config before closing the live server, but runs
			// buildStart afterwards. A resource error must leave the old port available.
			await rebuild();
		},
		async closeBundle() {
			await stopWatching?.();
		},
		configureServer(server) {
			server.watcher.add(sourceDirectory);
			for (const path of [scripts, ...inputs]) server.watcher.add(path);
			stopWatching = watchRebuild(server, accepts, rebuild, debounceMilliseconds);
		},
		handleHotUpdate({ file }) {
			// Vite must not reload individual files from a partially published generation.
			// Generated outputs are deliberately not compiler inputs, preventing loops.
			if (accepts(file) || samePath(resolve(file), outputFile) || ['lxicon.woff2', 'lxicon-variable.woff2'].some(name => samePath(resolve(file), resolve(fontDirectory, name)))) {
				return [];
			}
		},
	};
}

function isDirectSvgChild(path: string, sourceDirectory: string): boolean {
	const resolvedPath = resolve(path);
	return extname(resolvedPath).toLowerCase() === '.svg' && samePath(dirname(resolvedPath), sourceDirectory);
}

function samePath(first: string, second: string): boolean {
	if (process.platform === 'win32') {
		return first.toLowerCase() === second.toLowerCase();
	}
	return first === second;
}
