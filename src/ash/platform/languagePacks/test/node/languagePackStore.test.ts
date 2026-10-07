import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { LanguagePackStore } from '../../node/languagePackStore.js';
import type { LanguagePackCatalog } from '../../common/languagePacksService.js';

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
