import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IDebugSource } from '../../../services/debug/common/debugService.js';

/** Reference-backed sources belong to their live session, even when the adapter supplies a path. */
export function getUriFromSource(raw: IDebugSource, path: string | undefined, sessionId: string, uriIdentityService: IUriIdentityService, logService: ILogService): URI {
	if (raw.sourceReference !== undefined && raw.sourceReference > 0) {
		if (!Number.isSafeInteger(raw.sourceReference) || !/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) {
			throw new TypeError(localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.'));
		}
		const sourcePath = path || raw.name || `source-${raw.sourceReference}`;
		if (sourcePath.includes('\0') || sourcePath.length > 32768) throw new TypeError(localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.'));
		const resource = URI.from({
			scheme: 'debug', path: sourcePath.startsWith('/') ? sourcePath : `/${sourcePath}`,
			query: `session=${sessionId}&ref=${raw.sourceReference}`,
		});
		logService.debug('debug.source', `Resolving source reference ${raw.sourceReference} in session ${sessionId}.`);
		return resource;
	}
	if (path && !path.includes('\0') && path.length <= 32768) return uriIdentityService.asCanonicalUri(URI.file(/^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replaceAll('\\', '/') : path));
	throw new TypeError(localize('debug.invalidSource', 'The debug source needs a path or a source reference and a live session.'));
}
