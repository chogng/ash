import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Opens validated external HTTP(S) resources through the current host. */
export interface IOpenerService {
	openExternal(target: string): Promise<void>;
}

export const IOpenerService = createServiceIdentifier<IOpenerService>("openerService");

export function normalizeExternalUrl(target: string): string {
	let url: URL;
	try { url = new URL(target); }
	catch { throw new TypeError("External URL must be absolute"); }
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`External URL scheme is not allowed: ${url.protocol}`);
	if (!url.hostname) throw new TypeError("External URL must include a host");
	return url.toString();
}
