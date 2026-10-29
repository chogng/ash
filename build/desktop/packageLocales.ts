import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readPreinstalledLanguagePackIds } from '../resources/languagePacks.ts';

/** Runs on the extracted distribution before signing; the installed Electron and ICU data stay intact. */
export async function pruneElectronLocales({ buildPath, platform }: { readonly buildPath: string; readonly platform: string }): Promise<void> {
	const locales = new Set(['en-US']);
	for (const id of await readPreinstalledLanguagePackIds()) {
		const [publisher, name] = id.split('/');
		const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../../extensions', name, 'package.json'), 'utf8'));
		const locale: unknown = manifest.contributes?.localizations?.[0]?.languageId;
		if (manifest.publisher !== publisher || manifest.name !== name || typeof locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale)) {
			throw new Error(`Invalid preinstalled locale: ${id}`);
		}
		locales.add(locale);
	}
	if (platform !== 'darwin' && platform !== 'win32') {
		throw new Error(`Unsupported locale packaging platform: ${platform}`);
	}
	const mac = platform === 'darwin';
	const directory = mac ? join(buildPath, 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources') : join(buildPath, 'locales');
	// Require every selected base resource before removing anything, including English fallback.
	for (const locale of locales) {
		const file = mac ? join(directory, `${locale === 'en-US' ? 'en' : locale.replaceAll('-', '_')}.lproj/locale.pak`) : join(directory, `${locale}.pak`);
		if (!(await lstat(file)).isFile()) {
			throw new Error(`Missing packaged locale: ${locale}`);
		}
	}
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (mac ? !entry.isDirectory() || !entry.name.endsWith('.lproj') : !entry.isFile() || !entry.name.endsWith('.pak')) {
			continue;
		}
		if (mac) {
			const pak = await lstat(join(directory, entry.name, 'locale.pak')).catch(error => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			});
			// Base.lproj and other shared bundle assets are not Chromium language packs.
			if (!pak?.isFile()) {
				continue;
			}
		}
		const base = entry.name
			.replace(mac ? /\.lproj$/u : /\.pak$/u, '')
			.replace(/_(?:FEMININE|MASCULINE|NEUTER)$/u, '')
			.replaceAll('_', '-');
		if (!locales.has(base === 'en' ? 'en-US' : base)) {
			await rm(join(directory, entry.name), { recursive: mac });
		}
	}
}
