import type { URI } from '../../../base/common/uri.js';
import { testUrlMatchesGlob } from './urlGlob.js';

/** Trust decisions use the browser's interpretation of web URLs. */
export function isURLSafeForTrust(resource: URI): boolean {
	// URI owns browser normalization and credential rejection. Escaped control
	// characters still require a decision even when the domain has a trust rule.
	return (resource.scheme === 'http' || resource.scheme === 'https') && !!resource.authority && !/[\u0000-\u001f\u007f]/u.test(resource.toString(true));
}

/** Validates a user rule without widening its scheme, authority, or path. */
export function normalizeURLPattern(pattern: string): string {
	if (pattern === '*') return pattern;
	if (!pattern || /[\s\\?#@\u0000-\u001f\u007f]/u.test(pattern)) throw new TypeError('Invalid trusted domain pattern');
	const explicitScheme = /^[^/]+:\/\//u.test(pattern);
	const authority = /^(?:https?:\/\/)?([^/]+)/iu.exec(pattern)?.[1];
	if (!authority || !/^(?:[\p{L}\p{N}*._-]+|\[[\da-f:]+\])(?::(?:\d+|\*))?$/iu.test(authority)) {
		throw new TypeError('Invalid trusted domain pattern');
	}
	const anyPort = authority.endsWith(':*');
	const input = anyPort ? pattern.replace(authority, authority.slice(0, -2)) : pattern;
	const url = new URL(explicitScheme ? input : `https://${input}`);
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new TypeError('Invalid trusted domain pattern');
	}
	const rawPath = pattern.slice(pattern.indexOf(authority) + authority.length);
	if (rawPath.split('/').some(segment => /^\.{1,2}$/u.test(segment.replace(/%2e/giu, '.')))) {
		throw new TypeError('Invalid trusted domain pattern');
	}
	const port = /:(\d+)$/u.exec(authority)?.[1];
	// A scheme-less :443 rule also applies to HTTP, where 443 is not the default.
	const host = anyPort ? `${url.hostname}:*` : !explicitScheme && port ? `${url.hostname}:${Number(port)}` : url.host;
	return explicitScheme ? `${url.protocol}//${host}${url.pathname}` : `${host}${url.pathname}`;
}

export function isURLDomainTrusted(resource: URI, trustedDomains: readonly string[]): boolean {
	if (!isURLSafeForTrust(resource)) return false;
	const hostname = new URL(resource.toString()).hostname;
	if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]') {
		return true;
	}
	return trustedDomains.some(pattern => {
		try {
			return pattern === '*' || testUrlMatchesGlob(resource, pattern);
		} catch {
			return false;
		}
	});
}
