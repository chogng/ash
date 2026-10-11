import { URI } from '../../../base/common/uri.js';
import { getNLSLanguage } from '../../../nls.js';
import { IExtensionApi } from '../../../platform/extensions/common/extensionApi.js';
import { toExtensionResourceURI } from '../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILanguagePackService } from '../../../platform/languagePacks/common/languagePacksService.js';
import { parseTranslationMessages } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import type { ExtensionHostInitialization } from '../../../platform/agentHost/common/extensionHostApi.js';
import { parseJsonc } from '../../services/extensions/common/jsonc.js';
import { localizeManifest } from '../../../platform/extensionManagement/common/extensionNls.js';

/** Resolves translations from client resources without setting a shared server language. */
export class MainThreadLocalization {
	constructor(
		@ILanguagePackService private readonly languagePacks: ILanguagePackService,
		@IExtensionApi private readonly extensions: IExtensionApi,
	) { }

	public $fetchBuiltInBundleUri(id: string, language: string): Promise<URI | undefined> {
		return this.languagePacks.getBuiltInExtensionTranslationsUri(id, language);
	}

	public async $fetchBundleContents(uri: URI): Promise<string> {
		if (uri.scheme === 'data' && uri.path.startsWith('application/json,')) {
			return uri.path.slice('application/json,'.length);
		}
		return this.extensions.resources.readExtensionResource(uri);
	}

	public async getLocalization(id: string): Promise<ExtensionHostInitialization['localization']> {
		const language = getNLSLanguage();
		if (language === 'en') { return undefined; }
		try {
			const uri = await this.$fetchBuiltInBundleUri(id, language);
			if (uri) {
				const value = JSON.parse(await this.$fetchBundleContents(uri));
				const bundle = parseTranslationMessages(value.contents?.bundle);
				const messages = parseTranslationMessages(value.contents?.package);
				if (bundle && messages) { return { uri: uri.toString(), bundle, package: messages }; }
			}
		} catch {
			// A damaged language-pack resource can fall back to the extension’s own bundle.
		}
		try {
			const catalog = await this.extensions.list('cached');
			const extension = catalog.extensions.find(extension => extension.id.toLowerCase() === id.toLowerCase());
			if (!extension) { return undefined; }
			const manifest = JSON.parse(extension.manifestJson);
			if (typeof manifest.l10n !== 'string') { return undefined; }
			const locales = [...new Set([language, language.toLowerCase(), language.split('-')[0]])];
			for (const locale of locales) {
				const resource = toExtensionResourceURI({ generation: catalog.generation, extensionId: extension.id, path: `${manifest.l10n.replace(/\/$/u, '')}/bundle.l10n.${locale}.json` });
				try {
					const bundle = parseTranslationMessages(parseJsonc(await this.$fetchBundleContents(resource), 'Extension translations'));
					if (bundle) { return { uri: resource.toString(), bundle, package: {} }; }
				} catch {
					// Optional locale resources may be absent; try the base language next.
				}
			}
		} catch {
			// A damaged optional resource must not prevent extension activation.
		}
		return undefined;
	}

	public async localizeManifest(id: string, manifestJson: string, generation: number): Promise<string> {
		if (!manifestJson.includes('%')) { return manifestJson; }
		const language = getNLSLanguage();
		const messages: Record<string, unknown> = {};
		const suffixes = language === 'en' ? [''] : ['', '.' + language.split('-')[0], '.' + language, '.' + language.toLowerCase()];
		for (const suffix of new Set(suffixes)) {
			try {
				const uri = toExtensionResourceURI({ generation, extensionId: id, path: 'package.nls' + suffix + '.json' });
				const parsed = parseTranslationMessages(parseJsonc(await this.$fetchBundleContents(uri), 'Extension messages'));
				if (parsed) { Object.assign(messages, parsed); }
			} catch {
				// Packages can rely on English declarations or omit a regional variant.
			}
		}
		const localization = await this.getLocalization(id);
		if (localization) { Object.assign(messages, localization.package); }
		return JSON.stringify(localizeManifest(JSON.parse(manifestJson), messages));
	}
}
