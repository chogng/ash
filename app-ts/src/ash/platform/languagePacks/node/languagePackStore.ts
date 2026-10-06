import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeLocale, parseLanguagePackCatalog } from '../common/languagePackCatalog.js';
import type { ILanguagePackStore } from '../common/languagePackStore.js';
import type { LanguagePackCatalog } from '../common/languagePacksService.js';

export class LanguagePackStore implements ILanguagePackStore {
	constructor(private readonly profileRoot: string) { }

	public async read(locale: string): Promise<LanguagePackCatalog | undefined> {
		const path = this.catalogPath(locale);
		let source: string;
		try { source = await readFile(path, 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
		const catalog = parseLanguagePackCatalog(JSON.parse(source));
		if (!catalog || catalog.locale !== locale) { throw new Error(`Invalid display language resource: ${path}`); }
		return catalog;
	}

	public async write(catalog: LanguagePackCatalog): Promise<void> {
		const path = this.catalogPath(catalog.locale);
		await mkdir(join(this.profileRoot, 'languagepacks'), { recursive: true });
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(catalog), 'utf8');
			await rename(temporaryPath, path);
		} finally { await rm(temporaryPath, { force: true }); }
	}

	private catalogPath(locale: string): string {
		if (!locale || normalizeLocale(locale) !== locale) { throw new TypeError('Invalid display language ID'); }
		return join(this.profileRoot, 'languagepacks', `${locale}.json`);
	}
}
