import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';

/** Requests to this origin are fulfilled only by the isolated webview's resource worker. */
export const webviewGenericCspSource = 'https://resources.ash-webview.invalid';

/** Keeps the file path hierarchy intact so CSS, fonts and modules can resolve sibling resources. */
export function asWebviewUri(resource: URI): URI {
	if (resource.scheme === Schemas.http || resource.scheme === Schemas.https || resource.scheme === Schemas.data) {
		return resource;
	}
	return URI.from({
		scheme: Schemas.https,
		authority: 'resources.ash-webview.invalid',
		path: `/${resource.scheme}/a${resource.authority}${resource.path}`,
		query: resource.query,
		fragment: resource.fragment,
	});
}
