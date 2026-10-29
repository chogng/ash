import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneElectronLocales } from './packageLocales.ts';

for (const platform of ['darwin', 'win32']) {
	test(`${platform} packaging retains selected locales and ICU, including gender variants`, async t => {
		const buildPath = await mkdtemp(join(tmpdir(), 'ash-packaged-locales-'));
		t.after(() => rm(buildPath, { recursive: true, force: true }));
		const mac = platform === 'darwin';
		const directory = mac ? join(buildPath, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources') : join(buildPath, 'locales');
		await mkdir(directory, { recursive: true });
		const file = (locale: string) => mac ? join(directory, `${locale}.lproj/locale.pak`) : join(directory, `${locale}.pak`);
		const selected = mac ? ['en', 'zh_CN', 'zh_CN_FEMININE'] : ['en-US', 'zh-CN', 'zh-CN_FEMININE'];
		for (const locale of [...selected, 'fr', 'fr_FEMININE', mac ? 'en_GB' : 'en-GB']) {
			await mkdir(join(file(locale), '..'), { recursive: true });
			await writeFile(file(locale), locale);
		}
		await writeFile(join(directory, 'icudtl.dat'), 'Internationalization data');
		if (mac) {
			await mkdir(join(directory, 'Base.lproj'));
			await writeFile(join(directory, 'Base.lproj/shared.nib'), 'Shared interface resource');
		}
		await pruneElectronLocales({ buildPath, platform });
		assert.deepEqual((await readdir(directory)).sort(), [...selected.map(locale => mac ? `${locale}.lproj` : `${locale}.pak`), 'icudtl.dat', ...mac ? ['Base.lproj'] : []].sort());
		assert.equal(await readFile(join(directory, 'icudtl.dat'), 'utf8'), 'Internationalization data');
		for (const locale of selected) { assert.equal(await readFile(file(locale), 'utf8'), locale); }
		await pruneElectronLocales({ buildPath, platform });
	});
}

test('missing selected locale fails before pruning the other resources', async t => {
	const buildPath = await mkdtemp(join(tmpdir(), 'ash-packaged-locales-'));
	t.after(() => rm(buildPath, { recursive: true, force: true }));
	await mkdir(join(buildPath, 'locales'));
	await writeFile(join(buildPath, 'locales/en-US.pak'), 'English');
	await writeFile(join(buildPath, 'locales/fr.pak'), 'French');
	await assert.rejects(pruneElectronLocales({ buildPath, platform: 'win32' }), /ENOENT/);
	assert.deepEqual((await readdir(join(buildPath, 'locales'))).sort(), ['en-US.pak', 'fr.pak']);
});
