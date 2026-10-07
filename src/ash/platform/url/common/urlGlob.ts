import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';

/** Matches URL host/port and path patterns; queries and fragments do not select an opener. */
export function testUrlMatchesGlob(uri: string | URI, globUrl: string): boolean {
	const resource = typeof uri === 'string' ? URI.parse(uri) : uri;
	const isWebUrl = resource.scheme === Schemas.http || resource.scheme === Schemas.https;
	const hasScheme = /^[^/:]+:\/\//u.test(globUrl);
	if (!hasScheme && !isWebUrl) {
		return false;
	}
	// Glob ports and dot segments are pattern syntax, not a URL to normalize.
	const pattern = /^([^:/]+):\/\/([^/?#]*)([^?#]*)/u.exec(hasScheme ? globUrl : `${resource.scheme}://${globUrl}`);
	if (!pattern || !matchPart(resource.scheme, pattern[1]!.toLowerCase())) {
		return false;
	}
	// URL parsing accounts for browser authority separators and IDN spelling. Wildcard
	// patterns retain their literal paths so normalization cannot broaden their scope.
	const effective = isWebUrl ? new URL(resource.toString()) : undefined;
	const authority = effective ? effective.host : resource.authority;
	let patternAuthority = pattern[2]!;
	const anyPort = patternAuthority.endsWith(':*');
	if (anyPort) {
		patternAuthority = patternAuthority.slice(0, -2);
	}
	const patternHost = isWebUrl ? new URL(`${resource.scheme}://${patternAuthority}`).host : patternAuthority;
	const targetAuthority = anyPort ? (effective?.hostname ?? authority.replace(/:\d+$/u, '')) : authority;
	const authorityPattern = patternHost.startsWith('*.') ? patternHost.slice(2) : patternHost;
	const labels = targetAuthority.split('.');
	const authorities = patternHost.startsWith('*.') ? labels.map((_label, index) => labels.slice(index).join('.')) : [targetAuthority];
	if (!authorities.some(candidate => matchPart(candidate.toLowerCase(), authorityPattern.toLowerCase()))) {
		return false;
	}
	const pathPattern = matchingPath(pattern[3]!);
	const path = matchingPath(effective?.pathname ?? resource.path);
	if (!matchPart(path, pathPattern)) {
		return false;
	}
	return true;
}

function matchingPath(path: string): string {
	return encodeURI(path).replace(/%25([\da-f]{2})/giu, '%$1').replace(/%[\da-f]{2}/giu, escape => {
		const character = String.fromCharCode(parseInt(escape.slice(1), 16));
		return /^[\w.~-]$/u.test(character) ? character : escape.toUpperCase();
	}).replace(/\/+$/u, '');
}

/** A trailing star consumes at least one character; completed paths include descendants. */
function matchPart(value: string, pattern: string): boolean {
	let offset = 0;
	let patternOffset = 0;
	let starOffset = -1;
	let starEnd = 0;
	while (offset < value.length) {
		if (patternOffset === pattern.length) {
			if (value[offset] === '/') {
				return true;
			}
		} else if (pattern[patternOffset] === '*') {
			if (patternOffset === pattern.length - 1) {
				return true;
			}
			starOffset = patternOffset++;
			starEnd = offset;
			continue;
		} else if (value[offset] === pattern[patternOffset]) {
			offset++;
			patternOffset++;
			continue;
		}
		if (starOffset < 0) {
			return false;
		}
		offset = ++starEnd;
		patternOffset = starOffset + 1;
	}
	return patternOffset === pattern.length;
}
