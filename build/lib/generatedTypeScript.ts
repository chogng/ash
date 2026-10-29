import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');

/** Generated destinations may be ignored build artifacts; their emitted source still uses the repository rules. */
export function formatGeneratedTypeScript(source: string): string {
	const bun = resolve(repository, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
	const result = spawnSync(
		bun,
		[
			'fmt',
			'--no-script',
			'--disable-nested-config',
			'--no-editorconfig',
			'--config',
			resolve(repository, '.prettierrc.toml'),
			'--stdin-filepath',
			resolve(repository, 'build/generatedSource.ts'),
		],
		{ cwd: repository, input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Generated TypeScript formatting failed: ${result.stderr}`);
	return result.stdout;
}
