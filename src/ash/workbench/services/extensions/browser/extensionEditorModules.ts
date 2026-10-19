import { localize } from '../../../../nls.js';
import type { ExtensionEditorClientModule, ExtensionEditorModuleLoader } from './extensionEditor.js';

/** Verify product-compiled sources before importing their module. Catalog bytes never execute. */
export const loadExtensionEditorModule: ExtensionEditorModuleLoader = async (packageName, entry, expectedDigest) => {
	const modules = import.meta.glob<ExtensionEditorClientModule>('../../../../../../extensions/*/browser/editor.ts');
	const sources = import.meta.glob<string>('../../../../../../extensions/*/{browser,common}/**/*.{ts,css}', { query: '?raw', import: 'default' });
	const prefix = `../../../../../../extensions/${packageName}/`;
	const load = modules[`../../../../../../extensions/${packageName}/${entry}`];
	if (!load) throw new Error(localize('extensions.clientEditor.moduleUnavailable', 'This editor component is unavailable in this version of Ash.'));
	const paths = Object.keys(sources).filter(path => path.startsWith(prefix)).sort();
	const content = await Promise.all(paths.map(async path => `${path.slice(prefix.length)}\0${await sources[path]()}\0`));
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content.join('')));
	const digest = `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
	if (digest !== expectedDigest) throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
	return load();
};
