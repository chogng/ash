import { homedir } from 'node:os';
import { join } from 'node:path';

/** Keeps backend account and model-cache storage inside the test's temporary home. */
export function createTestEnvironment(directory: string, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const environment = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
	// Product storage is isolated, but Cargo and rustup still use the host toolchain.
	environment.CARGO_HOME = source.CARGO_HOME ?? join(source.HOME ?? homedir(), '.cargo');
	environment.RUSTUP_HOME = source.RUSTUP_HOME ?? join(source.HOME ?? homedir(), '.rustup');
	// ASH_HOME isolates the product profile, while account storage resolves the OS home.
	environment.HOME = directory;
	if (process.platform === 'win32') environment.USERPROFILE = directory;
	delete environment.CODEX_HOME;
	return environment;
}
