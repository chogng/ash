import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const enum AccessibleViewProviderId {
	BulkEditPreview = 'bulkEditPreview',
	ActionWidget = 'actionWidget',
	InspectEditorTokens = 'inspectEditorTokens',
	Explorer = 'explorer',
	GettingStarted = 'gettingStarted',
	OpenEditors = 'openEditors',
	SessionsActivityBar = 'sessionsActivityBar',
	DesignCanvas = 'designCanvas',
	Library = 'library',
	ImagePreview = 'imagePreview',
	AgentSessions = 'agentSessions',
	ChatModelConfiguration = 'chatModelConfiguration',
	ChatEditing = 'chatEditing',
	SessionsChat = 'sessionsChat',
	SessionsSettings = 'sessionsSettings',
	HooksSettings = 'hooksSettings',
	NetworkSettings = 'networkSettings',
	LanguageServers = 'languageServers',
	Dictation = 'dictation',
	DictationModels = 'dictationModels',
	DictationOnboarding = 'dictationOnboarding',
	SessionsChanges = 'sessionsChanges',
	Notifications = 'notifications',
	ScmMerge = 'scmMerge',
	ScmHistoryDetails = 'scmHistoryDetails',
	ScmRepositories = 'scmRepositories',
	DiffEditor = 'diffEditor',
	Testing = 'testing',
	Browser = 'browser',
	Marketplace = 'marketplace',
	Skills = 'skills',
	Calls = 'calls',
	Memories = 'memories',
	Trace = 'trace',
	IssueReporter = 'issueReporter',
}

export const enum AccessibleViewType {
	Help = 'help',
	View = 'view',
}

export const enum AccessibilityVerbositySettingId {
	BulkEditPreview = 'accessibility.verbosity.bulkEditPreview',
	ActionWidget = 'accessibility.verbosity.actionWidget',
	InspectEditorTokens = 'accessibility.verbosity.inspectEditorTokens',
	Explorer = 'accessibility.verbosity.explorer',
	GettingStarted = 'accessibility.verbosity.gettingStarted',
	OpenEditors = 'accessibility.verbosity.openEditors',
	SessionsActivityBar = 'accessibility.verbosity.sessionsActivityBar',
	DesignCanvas = 'accessibility.verbosity.designCanvas',
	Library = 'accessibility.verbosity.library',
	ImagePreview = 'accessibility.verbosity.imagePreview',
	AgentSessions = 'accessibility.verbosity.agentSessions',
	ChatModelConfiguration = 'accessibility.verbosity.chatModelConfiguration',
	ChatEditing = 'accessibility.verbosity.chatEditing',
	Chat = 'accessibility.verbosity.chat',
	SessionsSettings = 'accessibility.verbosity.sessionsSettings',
	HooksSettings = 'accessibility.verbosity.hooksSettings',
	NetworkSettings = 'accessibility.verbosity.networkSettings',
	LanguageServers = 'accessibility.verbosity.languageServers',
	Dictation = 'accessibility.verbosity.dictation',
	DictationModels = 'accessibility.verbosity.dictationModels',
	DictationOnboarding = 'accessibility.verbosity.dictationOnboarding',
	SessionsChanges = 'accessibility.verbosity.sessionsChanges',
	Notifications = 'accessibility.verbosity.notifications',
	ScmMerge = 'accessibility.verbosity.scmMerge',
	ScmHistoryDetails = 'accessibility.verbosity.scmHistoryDetails',
	ScmRepositories = 'accessibility.verbosity.scmRepositories',
	DiffEditor = 'accessibility.verbosity.diffEditor',
	Testing = 'accessibility.verbosity.testing',
	Browser = 'accessibility.verbosity.browser',
	Marketplace = 'accessibility.verbosity.marketplace',
	Skills = 'accessibility.verbosity.skills',
	Calls = 'accessibility.verbosity.calls',
	Memories = 'accessibility.verbosity.memories',
	Trace = 'accessibility.verbosity.trace',
	IssueReporter = 'accessibility.verbosity.issueReporter',
}

export interface IAccessibleViewOptions {
	readonly type: AccessibleViewType;
}

export interface IAccessibleViewContentProvider extends IDisposable {
	readonly id: AccessibleViewProviderId;
	readonly options: IAccessibleViewOptions;
	readonly verbositySettingKey: string;
	provideContent(): string;
}

/** One invocation of an accessibility provider, released when its dialog closes. */
export class AccessibleContentProvider extends AbstractDisposable implements IAccessibleViewContentProvider {
	constructor(
		public readonly id: AccessibleViewProviderId,
		public readonly options: IAccessibleViewOptions,
		public readonly provideContent: () => string,
		private readonly onClose: () => void,
		public readonly verbositySettingKey: string,
	) {
		super();
	}

	protected override disposeCore(): void {
		this.onClose();
	}
}

export interface IAccessibleViewService extends IDisposable {
	show(type: AccessibleViewType): boolean;
	getOpenAriaHint(verbositySettingKey: string): string | undefined;
}

export const IAccessibleViewService = createServiceIdentifier<IAccessibleViewService>('accessibleViewService');
