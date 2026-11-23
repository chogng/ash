import { localize } from '../../../../nls.js';

export const NEW_SESSION_WELCOME_NAME_PLACEHOLDER = '${name}';

export interface INewSessionWelcomeMessagesConfiguration {
	readonly mode?: 'replace' | 'append';
	readonly phrases?: readonly string[];
}

/** Custom phrases are plain text. Names are inserted literally, including dollar signs. */
export function resolveWelcomePhraseTemplate(phrase: string, accountName: string | undefined): string {
	const parts = phrase.split(/\$?\{name\}/u);
	if (accountName) {
		return parts.join(accountName).trim();
	}
	if (parts.length === 1) {
		return phrase.trim();
	}
	const text = parts.map((part, index) => {
		if (index > 0) { part = part.replace(/^[\s,\u2013\u2014-]+/u, ''); }
		if (index < parts.length - 1) { part = part.replace(/[\s,\u2013\u2014-]+$/u, ''); }
		return part.trim();
	})
		.filter(Boolean).join(' ').replace(/\s+([!?.,;:])/gu, '$1');
	return parts[0].trim() ? text : text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** The caller supplies configuration already validated by the settings boundary. */
export function getNewSessionWelcomePhrases(configuration: INewSessionWelcomeMessagesConfiguration | undefined, accountName: string | undefined): string[] {
	const phrases = (configuration?.phrases ?? []).map(phrase => resolveWelcomePhraseTemplate(phrase, accountName)).filter(Boolean);
	if (configuration?.mode === 'replace') {
		return phrases;
	}
	const defaults = [
		accountName ? localize('newSession.welcome.named.building', 'What are we building, {0}?', accountName) : localize('newSession.welcome.building', 'What are we building?'),
		accountName ? localize('newSession.welcome.named.move', 'What\u2019s the move, {0}?', accountName) : localize('newSession.welcome.move', 'What\u2019s the move?'),
		accountName ? localize('newSession.welcome.named.cook', 'Let\u2019s cook, {0}', accountName) : localize('newSession.welcome.cook', 'Let\u2019s cook'),
		accountName ? localize('newSession.welcome.named.lockIn', 'Time to lock in, {0}', accountName) : localize('newSession.welcome.lockIn', 'Time to lock in'),
		accountName ? localize('newSession.welcome.named.ship', 'Let\u2019s ship something, {0}', accountName) : localize('newSession.welcome.ship', 'Let\u2019s ship something'),
	];
	return defaults.concat(phrases);
}
