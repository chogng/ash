import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { LanguagePackStore } from '../../node/languagePackStore.js';
import type { LanguagePackCatalog } from '../../common/languagePacksService.js';
import { resolveLanguagePackCatalog } from '../../common/languagePackCatalog.js';

const catalog: LanguagePackCatalog = { schemaVersion: 1, catalogVersion: 'ash-1', locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', bundles: { ash: { hello: 'Bonjour' } } };

test('saved language resources are available to the next process and updates replace the complete catalog', async () => {
	const profile = await mkdtemp(join(tmpdir(), 'ash-language-'));
	try {
		const store = new LanguagePackStore(profile);
		assert.equal(await store.read('fr'), undefined);
		await store.write(catalog);
		assert.deepEqual(await new LanguagePackStore(profile).read('fr'), catalog);
		const updated = { ...catalog, bundles: { ash: { hello: 'Salut' } } };
		await store.write(updated);
		assert.deepEqual(JSON.parse(await readFile(join(profile, 'languagepacks/fr.json'), 'utf8')), updated);
		await assert.rejects(store.read('../settings'), /Invalid display language ID/);
		await writeFile(join(profile, 'languagepacks/fr.json'), JSON.stringify({ ...catalog, locale: 'de' }));
		await assert.rejects(store.read('fr'), /Invalid display language resource/);
	} finally { await rm(profile, { recursive: true, force: true }); }
});

test('startup recovers from damaged or incompatible disk resources and uses a reinstalled base language', async () => {
	const profile = await mkdtemp(join(tmpdir(), 'ash-language-'));
	const english = { ...catalog, locale: 'en', bundles: { ash: { hello: 'Hello' } } };
	try {
		const store = new LanguagePackStore(profile);
		assert.deepEqual(await resolveLanguagePackCatalog('fr-CA', [english], store), english);
		await store.write(catalog);
		for (const source of ['{invalid JSON', JSON.stringify({ ...catalog, catalogVersion: 'ash-future' })]) {
			await writeFile(join(profile, 'languagepacks/fr.json'), source);
			assert.deepEqual(await resolveLanguagePackCatalog('fr-CA', [english], new LanguagePackStore(profile)), english);
		}
		await store.write(catalog);
		assert.deepEqual(await resolveLanguagePackCatalog('fr-CA', [english], new LanguagePackStore(profile)), catalog);
	} finally { await rm(profile, { recursive: true, force: true }); }
});
