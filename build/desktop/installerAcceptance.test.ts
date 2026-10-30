import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { writeInstallationManifest } from './installationManifest.ts';
import { withPreviousInstallerBundle } from './installerAcceptance.ts';

test('previous installer keeps Desktop and backend versions coherent and restores the candidate on success or failure', async () => {
	const bundle = await mkdtemp(join(tmpdir(), 'ash-previous-installer-'));
	const desktopPath = join(bundle, 'resources/app/package.json');
	const backendPath = join(bundle, 'resources/ash-package.json');
	const manifestPath = join(bundle, 'resources/installation-files.json');
	try {
		await mkdir(dirname(desktopPath), { recursive: true });
		await writeFile(desktopPath, '{"version":"1.2.3"}\n');
		await writeFile(
			backendPath,
			JSON.stringify({ version: '1.2.3', buildId: `sha256:${'a'.repeat(64)}`, files: {} }),
		);
		await writeInstallationManifest(bundle);
		const paths = [desktopPath, backendPath, manifestPath];
		const original = await Promise.all(paths.map(path => readFile(path)));
		for (const fail of [false, true]) {
			const compilation = withPreviousInstallerBundle(bundle, async () => {
				assert.equal(JSON.parse(await readFile(desktopPath, 'utf8')).version, '0.0.0');
				const backend = JSON.parse(await readFile(backendPath, 'utf8'));
				assert.equal(backend.version, '0.0.0');
				assert.notEqual(backend.buildId, JSON.parse(original[1].toString()).buildId);
				const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
				for (const relative of [
					'resources/app/package.json',
					'resources/ash-package.json',
					'upgrade-retired.txt',
				]) {
					assert.equal(
						manifest.files[relative],
						createHash('sha256')
							.update(await readFile(join(bundle, relative)))
							.digest('hex'),
					);
				}
				if (fail) throw new Error('fixture compiler failed');
			});
			if (fail) await assert.rejects(compilation, /fixture compiler failed/);
			else await compilation;
			assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), original);
			await assert.rejects(stat(join(bundle, 'upgrade-retired.txt')), { code: 'ENOENT' });
		}
	} finally {
		const absolute = await realpath(bundle);
		assert.equal(dirname(absolute), await realpath(tmpdir()));
		assert(basename(absolute).startsWith('ash-previous-installer-'));
		await rm(absolute, { recursive: true, force: true });
	}
});
