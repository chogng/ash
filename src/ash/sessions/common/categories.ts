import { localize2 } from '../../nls.js';

/** Metadata is resolved in the window's language when commands are registered. */
export const SessionsCategories = Object.freeze({
	get Sessions() { return localize2('sessions.category', 'Agents'); },
});
