/** Keeps backend account and model-cache storage inside the test's temporary home. */
export function createTestEnvironment(directory: string, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const environment = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined));
	// ASH_HOME isolates the product profile, while account storage resolves the OS home.
	environment.HOME = directory;
	if (process.platform === 'win32') environment.USERPROFILE = directory;
	delete environment.CODEX_HOME;
	return environment;
}
