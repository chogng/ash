import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

/** The test-home owner removes this private keychain after its owned processes stop. */
export async function prepareTestKeychain(environment: Readonly<Record<string, string>>): Promise<void> {
	if (process.platform !== 'darwin') return;
	const keychain = join(environment.HOME, 'Library', 'Keychains', 'ash-smoke.keychain-db');
	try { await access(keychain); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
	// Security.framework resolves user-domain preferences under HOME. Without
	// Preferences, the security CLI succeeds but cannot persist the default.
	await mkdir(join(environment.HOME, 'Library', 'Preferences'), { recursive: true });
	await mkdir(join(environment.HOME, 'Library', 'Keychains'), { recursive: true });
	const password = randomBytes(32).toString('hex');
	const execute = promisify(execFile);
	const options = { env: { ...environment }, timeout: 10_000 };
	await execute('/usr/bin/security', ['create-keychain', '-p', password, keychain], options);
	await execute('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychain], options);
	await execute('/usr/bin/security', ['unlock-keychain', '-p', password, keychain], options);
}
