import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const enum AccessibleViewProviderId {
	Disassembly = 'disassembly',
	GitHub = 'github',
	GitHubEditor = 'githubEditor',
	Editor = 'editor',
	WebviewEditor = 'webviewEditor',
	ColorPicker = 'colorPicker',
	BulkEditPreview = 'bulkEditPreview',
	ActionWidget = 'actionWidget',
	InspectEditorTokens = 'inspectEditorTokens',
	Explorer = 'explorer',
	SearchHelp = 'searchHelp',
	SearchEditorHelp = 'searchEditorHelp',
	GettingStarted = 'gettingStarted',
	OpenEditors = 'openEditors',
	Outline = 'outline',
	Timeline = 'timeline',
	SessionsActivityBar = 'sessionsActivityBar',
	DesignCanvas = 'designCanvas',
	Library = 'library',
	Symphony = 'symphony',
	Creator = 'creator',
	ImagePreview = 'imagePreview',
	MediaPreview = 'mediaPreview',
	AgentSessions = 'agentSessions',
	ChatModelConfiguration = 'chatModelConfiguration',
	ChatEditing = 'chatEditing',
	SessionsChat = 'sessionsChat',
	SessionsSettings = 'sessionsSettings',
	HooksSettings = 'hooksSettings',
	NetworkSettings = 'networkSettings',
	GitHubSettings = 'githubSettings',
	ContentSearchSettings = 'contentSearchSettings',
	LanguageServers = 'languageServers',
	Dictation = 'dictation',
	DictationModels = 'dictationModels',
	DictationOnboarding = 'dictationOnboarding',
	SessionsChanges = 'sessionsChanges',
	Notifications = 'notifications',
	ScmMerge = 'scmMerge',
	ScmHistoryDetails = 'scmHistoryDetails',
	ScmRepositories = 'scmRepositories',
	ScmInput = 'scmInput',
	Scm = 'scm',
	DiffEditor = 'diffEditor',
	Testing = 'testing',
	Browser = 'browser',
	Marketplace = 'marketplace',
	Skills = 'skills',
	Calls = 'calls',
	Memories = 'memories',
	Trace = 'trace',
	AgentTrace = 'agentTrace',
	TraceSettings = 'traceSettings',
	ExecutionSettings = 'executionSettings',
	IssueReporter = 'issueReporter',
	Output = 'output',
	TerminalFindHelp = 'terminalFindHelp',
	Terminal = 'terminal',
	TerminalHelp = 'terminal-help',
}

export const enum AccessibleViewType {
	Help = 'help',
	View = 'view',
}

export const enum AccessibilityVerbositySettingId {
	Disassembly = 'accessibility.verbosity.disassembly',
	GitHub = 'accessibility.verbosity.github',
	GitHubEditor = 'accessibility.verbosity.githubEditor',
	Editor = 'accessibility.verbosity.editor',
	WebviewEditor = 'accessibility.verbosity.webviewEditor',
	ColorPicker = 'accessibility.verbosity.colorPicker',
	BulkEditPreview = 'accessibility.verbosity.bulkEditPreview',
	ActionWidget = 'accessibility.verbosity.actionWidget',
	InspectEditorTokens = 'accessibility.verbosity.inspectEditorTokens',
	Explorer = 'accessibility.verbosity.explorer',
	Find = 'accessibility.verbosity.find',
	GettingStarted = 'accessibility.verbosity.gettingStarted',
	OpenEditors = 'accessibility.verbosity.openEditors',
	Outline = 'accessibility.verbosity.outline',
	Timeline = 'accessibility.verbosity.timeline',
	SessionsActivityBar = 'accessibility.verbosity.sessionsActivityBar',
	DesignCanvas = 'accessibility.verbosity.designCanvas',
	Library = 'accessibility.verbosity.library',
	Symphony = 'accessibility.verbosity.symphony',
	Creator = 'accessibility.verbosity.creator',
	ImagePreview = 'accessibility.verbosity.imagePreview',
	MediaPreview = 'accessibility.verbosity.mediaPreview',
	AgentSessions = 'accessibility.verbosity.agentSessions',
	ChatModelConfiguration = 'accessibility.verbosity.chatModelConfiguration',
	ChatEditing = 'accessibility.verbosity.chatEditing',
	Chat = 'accessibility.verbosity.chat',
	SessionsSettings = 'accessibility.verbosity.sessionsSettings',
	HooksSettings = 'accessibility.verbosity.hooksSettings',
	NetworkSettings = 'accessibility.verbosity.networkSettings',
	GitHubSettings = 'accessibility.verbosity.githubSettings',
	ContentSearchSettings = 'accessibility.verbosity.contentSearchSettings',
	LanguageServers = 'accessibility.verbosity.languageServers',
	Dictation = 'accessibility.verbosity.dictation',
	DictationModels = 'accessibility.verbosity.dictationModels',
	DictationOnboarding = 'accessibility.verbosity.dictationOnboarding',
	SessionsChanges = 'accessibility.verbosity.sessionsChanges',
	Notifications = 'accessibility.verbosity.notifications',
	ScmMerge = 'accessibility.verbosity.scmMerge',
	ScmHistoryDetails = 'accessibility.verbosity.scmHistoryDetails',
	ScmRepositories = 'accessibility.verbosity.scmRepositories',
	ScmInput = 'accessibility.verbosity.scmInput',
	Scm = 'accessibility.verbosity.scm',
	DiffEditor = 'accessibility.verbosity.diffEditor',
	Testing = 'accessibility.verbosity.testing',
	Browser = 'accessibility.verbosity.browser',
	Marketplace = 'accessibility.verbosity.marketplace',
	Skills = 'accessibility.verbosity.skills',
	Calls = 'accessibility.verbosity.calls',
	Memories = 'accessibility.verbosity.memories',
	Trace = 'accessibility.verbosity.trace',
	AgentTrace = 'accessibility.verbosity.agentTrace',
	TraceSettings = 'accessibility.verbosity.traceSettings',
	ExecutionSettings = 'accessibility.verbosity.executionSettings',
	IssueReporter = 'accessibility.verbosity.issueReporter',
	Output = 'accessibility.verbosity.output',
	Terminal = 'accessibility.verbosity.terminal',
}

export interface IAccessibleViewOptions {
	readonly type: AccessibleViewType;
}

export interface IAccessibleViewContentProvider extends IDisposable {
	readonly id: AccessibleViewProviderId;
	readonly options: IAccessibleViewOptions;
	readonly verbositySettingKey: string;
	provideContent(): string;
	readonly onDidChangeContent?: Event<void>;
}

/** One invocation of an accessibility provider, released when its dialog closes. */
export class AccessibleContentProvider extends AbstractDisposable implements IAccessibleViewContentProvider {
	public onDidChangeContent?: Event<void>;

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
	disableHint(): Promise<void>;
	showAccessibleViewHelp(): void;
}

export const IAccessibleViewService = createServiceIdentifier<IAccessibleViewService>('accessibleViewService');
