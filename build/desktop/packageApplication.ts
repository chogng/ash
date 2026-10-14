/** Hoist only the deployment: development keeps pnpm's isolated workspace layout. */
export const productionDependencyDeployOptions = ['--filter', 'ash', '--config.node-linker=hoisted', 'deploy', '--prod', '--ignore-scripts'] as const;

/** Packager supplies POSIX paths relative to the application stage, with a leading slash. */
export function ignoreApplicationFile(path: string): boolean {
	const [top, second] = path.slice(1).split('/');
	if (!top) return false;
	if (!['package.json', 'node_modules', 'dist', 'resources', 'licenses', 'THIRD_PARTY_NOTICES.md'].includes(top)) return true;
	// Hoisted packages are self-contained; pnpm's private store would copy them a second time.
	return top === 'node_modules' && (second === 'electron' || second?.startsWith('.') === true);
}
