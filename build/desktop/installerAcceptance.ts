import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AshApplicationId } from '../../src/ash/code/common/application.ts';
import { runPython } from '../python.ts';
import { writeInstallationManifest } from './installationManifest.ts';

// There is no published historical Desktop installer yet. Exercise an actual
// version transition using the complete delivered payload and a retired file.
// The candidate installer is built first and is never changed by this fixture.
if (import.meta.main) {
	assert.equal(process.platform, 'win32');
	assert.equal(process.env.CI, 'true', 'Installer fixture generation requires a disposable CI host');
	assert(process.env.ISCC_PATH && process.env.ASH_PACKAGED_BUNDLE);
	const bundle = resolve(process.env.ASH_PACKAGED_BUNDLE);
	await withPreviousInstallerBundle(bundle, async () => {
		await promisify(execFile)(process.env.ISCC_PATH!, [
			`/DBundleDir=${bundle}`, '/DAppVersion=0.0.0', `/DAppUserId=${AshApplicationId}`,
			`/DIconPath=${resolve('resources/win32/ash.ico')}`, `/O${resolve('.build/installer-acceptance')}`,
			resolve('build/desktop/win32/ash.iss'),
		], { windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
	});
}

/** Keep the old Desktop and backend version contract valid, then restore the candidate bytes even if compilation fails. */
export async function withPreviousInstallerBundle(bundle: string, compile: () => Promise<void>): Promise<void> {
	const metadataPath = join(bundle, 'resources/app/package.json');
	const backendPath = join(bundle, 'resources/ash-package.json');
	const original = await readFile(metadataPath);
	const backendOriginal = await readFile(backendPath);
	const metadata = JSON.parse(original.toString('utf8'));
	assert.equal(metadata.version, JSON.parse(backendOriginal.toString('utf8')).version);
	assert.notEqual(metadata.version, '0.0.0');
	const retired = join(bundle, 'upgrade-retired.txt');
	await writeFile(retired, 'owned by the previous installation\n', { flag: 'wx' });
	try {
		metadata.version = '0.0.0';
		await writeFile(metadataPath, JSON.stringify(metadata));
		// Reuse the package owner's canonical identity calculation; changing only
		// Electron's version makes Main reject the backend before opening a window.
		await runPython(['-B', '-c', [
			'import json, sys',
			'from pathlib import Path',
			'from build.lib.package import package_build_id',
			'path = Path(sys.argv[1])',
			'metadata = json.loads(path.read_text(encoding="utf-8"))',
			'metadata["version"] = "0.0.0"',
			'identity = {key: value for key, value in metadata.items() if key not in ("files", "buildId")}',
			'metadata["buildId"] = package_build_id(identity, metadata["files"])',
			'path.write_text(json.dumps(metadata, indent=2) + "\\n", encoding="utf-8")',
		].join('\n'), backendPath], { cwd: resolve(import.meta.dirname, '../..'), operation: 'Previous installer backend identity' });
		await writeInstallationManifest(bundle);
		await compile();
	} finally {
		await writeFile(metadataPath, original);
		await writeFile(backendPath, backendOriginal);
		await unlink(retired);
		await writeInstallationManifest(bundle);
	}
}
