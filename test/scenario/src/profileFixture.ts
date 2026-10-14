import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Seeds only synthetic persistence into a new isolated profile, before any process opens it. */
export async function seedScenarioProfile(fixturePath: string, profilePath: string): Promise<void> {
	const fixtureRoot = await realpath(resolve(import.meta.dirname, '../../../.build/ash-playwright-mcp'));
	const source = await realpath(fixturePath);
	const withinRoot = relative(fixtureRoot, source);
	if (!withinRoot || isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
		throw new Error('Scenario profile fixtures must be inside .build/ash-playwright-mcp.');
	}
	const manifest = JSON.parse(await readFile(join(source, 'fixture.json'), 'utf8'));
	if (manifest.format !== 'ash-ui-profile-fixture-v1' || manifest.synthetic !== true) {
		throw new Error('Scenario profile fixtures must declare synthetic data.');
	}
	// Never copy accounts, secrets, connectors, runtime packages, or profile leases.
	const files = ['state.sqlite3', 'config.toml', 'settings.json'] as const;
	for (const file of files) {
		const stat = await lstat(join(source, file));
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Scenario fixture '${file}' must be a regular file.`);
	}
	await mkdir(profilePath, { recursive: true });
	for (const file of files) await copyFile(join(source, file), join(profilePath, file));
}
