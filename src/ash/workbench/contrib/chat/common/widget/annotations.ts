import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { extractSelection } from '../../../../../platform/opener/common/opener.js';

/** Reads an explicit local file reference from a parsed response link. */
export function parseInlineFileReference(href: string): ReturnType<typeof extractSelection> | undefined {
	if (!/^file:\/\/\/[^/]/iu.test(href) || /[\\\u0000-\u001f]/u.test(href)) return undefined;
	try {
		const resource = URI.parse(href);
		if (resource.scheme.toLowerCase() !== Schemas.file || resource.authority || resource.query
			|| resource.path.startsWith('//') || /[\\\u0000-\u001f]/u.test(resource.path)) return undefined;
		const target = extractSelection(resource.with({ scheme: Schemas.file }));
		return target.uri.fragment ? undefined : target;
	} catch {
		return undefined;
	}
}
