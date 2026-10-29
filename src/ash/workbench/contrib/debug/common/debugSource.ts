import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IDebugSource } from './debug.js';

/** Reference-backed sources belong to their live session, even when the adapter supplies a path. */
export function getUriFromSource(
	raw: IDebugSource,
	path: string | undefined,
	sessionId: string,
	uriIdentityService: IUriIdentityService,
	logService: ILogService,
): URI {
	const reference = raw.sourceReference ?? 0;
	if (!Number.isSafeInteger(reference) || reference < 0 || path?.includes('\0') || (path?.length ?? 0) > 32768) {
		throw new TypeError(
			localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.'),
		);
	}
	if (!reference && raw.resource) return uriIdentityService.asCanonicalUri(raw.resource);
	if (!reference && path) {
		let value = path;
		if (/^\\\\[?.]\\UNC\\/i.test(value)) value = '\\\\' + value.slice(8);
		else if (/^\\\\[?.]\\[a-z]:[\\/]/i.test(value)) value = value.slice(4);
		else if (/^\\\\[?.]\\/.test(value))
			throw new TypeError(
				localize(
					'debug.invalidSource',
					'The debug source needs a path or a source reference and a live session.',
				),
			);
		if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:/i.test(value)) {
			return uriIdentityService.asCanonicalUri(URI.parse(value));
		}
		if (value.startsWith('/') || /^(?:[a-z]:[\\/]|\\\\)/i.test(value)) {
			const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value);
			const slashes = windows ? value.replaceAll('\\', '/') : value;
			const share = windows ? /^\/\/([^/]+)(\/.*)$/.exec(slashes) : null;
			return uriIdentityService.asCanonicalUri(
				URI.from({ scheme: Schemas.file, authority: share?.[1] ?? '', path: share?.[2] ?? slashes }),
			);
		}
	}
	if (reference || path) {
		if (!/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) {
			throw new TypeError(
				localize(
					'debug.invalidSource',
					'The debug source needs a path or a source reference and a live session.',
				),
			);
		}
		const sourcePath = path || raw.name || `source-${reference}`;
		if (sourcePath.includes('\0') || sourcePath.length > 32768)
			throw new TypeError(
				localize(
					'debug.invalidSource',
					'The debug source needs a path or a source reference and a live session.',
				),
			);
		const resource = URI.from({
			scheme: 'debug',
			path: reference && !sourcePath.startsWith('/') ? `/${sourcePath}` : sourcePath,
			query: `session=${sessionId}&ref=${reference}`,
		});
		logService.debug('debug.source', `Resolving source reference ${reference} in session ${sessionId}.`);
		return resource;
	}
	throw new TypeError(
		localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.'),
	);
}
