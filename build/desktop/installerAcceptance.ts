import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AshApplicationId } from '../../src/ash/code/common/application.ts';
import { writeInstallationManifest } from './installationManifest.ts';

// There is no published historical Desktop installer yet. Exercise an actual
// version transition using the complete delivered payload and a retired file.
// The candidate installer is built first and is never changed by this fixture.
assert.equal(process.platform, 'win32');
assert.equal(process.env.CI, 'true', 'Installer fixture generation requires a disposable CI host');
assert(process.env.ISCC_PATH && process.env.ASH_PACKAGED_BUNDLE);
const bundle = resolve(process.env.ASH_PACKAGED_BUNDLE);
const metadataPath = join(bundle, 'resources/app/package.json');
const original = await readFile(metadataPath);
const metadata = JSON.parse(original.toString('utf8'));
assert.notEqual(metadata.version, '0.0.0');
const retired = join(bundle, 'upgrade-retired.txt');
await writeFile(retired, 'owned by the previous installation\n', { flag: 'wx' });
try {
	metadata.version = '0.0.0';
	await writeFile(metadataPath, JSON.stringify(metadata));
	await writeInstallationManifest(bundle);
	await promisify(execFile)(process.env.ISCC_PATH, [
		`/DBundleDir=${bundle}`, '/DAppVersion=0.0.0', `/DAppUserId=${AshApplicationId}`,
		`/DIconPath=${resolve('resources/win32/ash.ico')}`, `/O${resolve('.build/installer-acceptance')}`,
		resolve('build/desktop/win32/ash.iss'),
	], { windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
} finally {
	await writeFile(metadataPath, original);
	await unlink(retired);
	await writeInstallationManifest(bundle);
}
