import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Hoist only the deployment: development keeps pnpm's isolated workspace layout. */
export const productionDependencyDeployOptions = ['--filter', 'ash', '--config.node-linker=hoisted', 'deploy', '--prod', '--ignore-scripts'] as const;

/** Deploy dependencies from locked manifests without traversing the build tree being packaged. */
export async function prepareProductionDependencyWorkspace(repository: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches', 'licenses', 'THIRD_PARTY_NOTICES.md']) {
		try {
			await cp(join(repository, file), join(destination, file), { recursive: true, errorOnExist: true, force: false });
		} catch (error) {
			if (['licenses', 'THIRD_PARTY_NOTICES.md'].includes(file) && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
	}
}

/** Packager supplies POSIX paths relative to the application stage, with a leading slash. */
export function ignoreApplicationFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
	const parts = path.slice(1).split('/');
	const [top, second] = parts;
	if (!top) return false;
	if (!['package.json', 'node_modules', 'dist', 'resources', 'licenses', 'THIRD_PARTY_NOTICES.md'].includes(top)) return true;
	// Hoisted packages are self-contained; pnpm's private store would copy them a second time.
	if (top !== 'node_modules') return false;
	if (second === 'electron' || second?.startsWith('.') === true) return true;
	const packageIndex = parts.lastIndexOf('node_modules') + 1;
	const name = parts[packageIndex];
	if (name === 'native-is-elevated' && platform !== 'win32') return true;
	if (name !== 'native-keymap' && name !== 'native-is-elevated') return false;
	// These two loaders only consume build/Release; retain attribution but omit
	// C++ sources, compiler outputs and duplicate bin/<platform>-<arch>-<abi> copies.
	const file = parts.slice(packageIndex + 1).join('/');
	return !['', 'package.json', 'index.js', 'build', 'build/Release', `build/Release/${name === 'native-keymap' ? 'keymapping' : 'iselevated'}.node`].includes(file)
		&& !/^(?:license(?:\.txt)?|thirdpartynotices\.txt)$/iu.test(file);
}
