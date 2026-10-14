import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { BROWSER_SEARCH_NONE, BrowserSearchEngineId, BrowserSearchEngineSettingId, buildSearchUrl, resolveAddressBarInputType } from '../../common/browserSearch.js';

/** Resolves address-bar intent; page loading and authorization remain with the page owner. */
export class BrowserSearchFeatures {
	constructor(@IConfigurationService private readonly configuration: IConfigurationService) { }
	public resolve(text: string): string | undefined {
		const kind = resolveAddressBarInputType(text);
		if (kind === 'empty') { return undefined; }
		const engine = this.configuration.getValue<string>(BrowserSearchEngineSettingId);
		if (kind !== 'url' && engine !== BROWSER_SEARCH_NONE) { return buildSearchUrl(text, engine as BrowserSearchEngineId); }
		const input = text.trim();
		if (kind === 'url' && !/^[a-z][a-z\d+.-]*:/iu.test(input)) {
			return (/^(localhost|127\.0\.0\.1|\[::1\])(?:[:/?#]|$)/iu.test(input) ? 'http://' : 'https://') + input;
		}
		if (/^localhost:\d/iu.test(input)) { return 'http://' + input; }
		return input;
	}
}
