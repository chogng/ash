import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING } from '../common/constants.js';
import { getNewSessionWelcomePhrases, type INewSessionWelcomeMessagesConfiguration } from '../common/welcomePhrases.js';

/** Projects the Chat greeting for either reply source. An Ash handoff keeps the current phrase. */
export class ChatWelcomeTitle extends Disposable {
	readonly title = observableValue<string | null>(this, null);

	constructor(
		readDraft: (reader: IReader) => { readonly id: string; readonly revision: number; } | undefined,
		shown: IObservable<boolean>,
		advancePhrase: boolean,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IAccessibilityService accessibility: IAccessibilityService,
	) {
		super();
		const enabled = observableConfigValue(NEW_SESSION_WELCOME_PHRASES_SETTING, true, configuration);
		const name = observableConfigValue(NEW_SESSION_WELCOME_NAME_SETTING, '', configuration);
		const messages = observableConfigValue<INewSessionWelcomeMessagesConfiguration | undefined>(NEW_SESSION_WELCOME_MESSAGES_SETTING, undefined, configuration);
		const verbosityKey = 'accessibility.verbosity.newSessionWelcome';
		const verbosity = observableConfigValue(verbosityKey, true, configuration);
		const screenReader = observableFromEvent(this, accessibility.onDidChangeScreenReaderOptimized, () => accessibility.isScreenReaderOptimized());
		let identity: string | undefined;
		let draftRevision = -1;
		let index = 0;
		let announced = false;
		this._register(autorun(reader => {
			const draft = readDraft(reader);
			if (draft && (identity !== draft.id || draftRevision !== draft.revision)) {
				identity = draft.id;
				draftRevision = draft.revision;
				announced = false;
				const key = 'agentSessions.newSession.welcomePhraseIndex';
				const stored = storage.getNumber(key, StorageScope.PROFILE, 0);
				const next = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
				index = advancePhrase ? next : Math.max(0, next - 1);
				if (advancePhrase) storage.store(key, next < Number.MAX_SAFE_INTEGER - 1 ? next + 1 : 0, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			const phrases = getNewSessionWelcomePhrases(messages.read(reader), name.read(reader).trim() || undefined);
			const phrase = draft && enabled.read(reader) && phrases.length ? phrases[index % phrases.length] : undefined;
			this.title.set(phrase ?? null, undefined);
			if (shown.read(reader) && phrase && !announced && screenReader.read(reader) && verbosity.read(reader)) {
				announced = true;
				accessibility.status(localize('newSession.welcome.announcement', '{0}\nTo disable this announcement, set {1} to false.', phrase, verbosityKey));
			}
		}));
	}
}
