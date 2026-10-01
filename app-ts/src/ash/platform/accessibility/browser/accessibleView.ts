import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const enum AccessibleViewProviderId {
	InspectEditorTokens = 'inspectEditorTokens',
	Explorer = 'explorer',
	GettingStarted = 'gettingStarted',
	OpenEditors = 'openEditors',
	SessionsActivityBar = 'sessionsActivityBar',
	DesignCanvas = 'designCanvas',
	AgentSessions = 'agentSessions',
	ChatModelConfiguration = 'chatModelConfiguration',
	SessionsChat = 'sessionsChat',
	SessionsSettings = 'sessionsSettings',
	HooksSettings = 'hooksSettings',
	DictationModels = 'dictationModels',
	SessionsChanges = 'sessionsChanges',
	Notifications = 'notifications',
	ScmMerge = 'scmMerge',
	DiffEditor = 'diffEditor',
}

export const enum AccessibleViewType {
	Help = 'help',
	View = 'view',
}

export const enum AccessibilityVerbositySettingId {
	InspectEditorTokens = 'accessibility.verbosity.inspectEditorTokens',
	Explorer = 'accessibility.verbosity.explorer',
	GettingStarted = 'accessibility.verbosity.gettingStarted',
	OpenEditors = 'accessibility.verbosity.openEditors',
	SessionsActivityBar = 'accessibility.verbosity.sessionsActivityBar',
	DesignCanvas = 'accessibility.verbosity.designCanvas',
	AgentSessions = 'accessibility.verbosity.agentSessions',
	ChatModelConfiguration = 'accessibility.verbosity.chatModelConfiguration',
	Chat = 'accessibility.verbosity.chat',
	SessionsSettings = 'accessibility.verbosity.sessionsSettings',
	HooksSettings = 'accessibility.verbosity.hooksSettings',
	DictationModels = 'accessibility.verbosity.dictationModels',
	SessionsChanges = 'accessibility.verbosity.sessionsChanges',
	Notifications = 'accessibility.verbosity.notifications',
	ScmMerge = 'accessibility.verbosity.scmMerge',
	DiffEditor = 'accessibility.verbosity.diffEditor',
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
