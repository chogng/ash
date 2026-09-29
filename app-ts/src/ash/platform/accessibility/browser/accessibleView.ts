import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const enum AccessibleViewProviderId {
	Explorer = 'explorer',
	GettingStarted = 'gettingStarted',
	OpenEditors = 'openEditors',
	SessionsActivityBar = 'sessionsActivityBar',
	AgentSessions = 'agentSessions',
	ChatModelConfiguration = 'chatModelConfiguration',
	SessionsSettings = 'sessionsSettings',
	Notifications = 'notifications',
	ScmMerge = 'scmMerge',
	DiffEditor = 'diffEditor',
}

export const enum AccessibleViewType {
	Help = 'help',
	View = 'view',
}

export const enum AccessibilityVerbositySettingId {
	Explorer = 'accessibility.verbosity.explorer',
	GettingStarted = 'accessibility.verbosity.gettingStarted',
	OpenEditors = 'accessibility.verbosity.openEditors',
	SessionsActivityBar = 'accessibility.verbosity.sessionsActivityBar',
	AgentSessions = 'accessibility.verbosity.agentSessions',
	ChatModelConfiguration = 'accessibility.verbosity.chatModelConfiguration',
	SessionsSettings = 'accessibility.verbosity.sessionsSettings',
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
