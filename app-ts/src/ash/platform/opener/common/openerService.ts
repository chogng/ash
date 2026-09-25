import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Opens validated HTTP(S) and mailto resources through the current host. */
export interface IOpenerService {
	openExternal(target: string): Promise<void>;
}

export const IOpenerService = createServiceIdentifier<IOpenerService>("openerService");

export function normalizeExternalUrl(target: string): string {
	if (/[\r\n\u0000]/u.test(target)) throw new TypeError("External URL contains a line break or NUL");
	let url: URL;
	try { url = new URL(target); }
	catch { throw new TypeError("External URL must be absolute"); }
	if (url.protocol === "mailto:") {
		if (!url.pathname) throw new TypeError("Mailto URL must include a recipient");
		return url.toString();
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`External URL scheme is not allowed: ${url.protocol}`);
	if (!url.hostname) throw new TypeError("External URL must include a host");
	return url.toString();
}
