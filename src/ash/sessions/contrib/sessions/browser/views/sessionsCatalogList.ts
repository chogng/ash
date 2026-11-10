import type { IAction } from '../../../../../base/common/actions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import type { IObservable } from '../../../../../base/common/observable.js';
import type { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ProjectSummary } from '../../../../../platform/projects/common/projectService.js';
import type { ISessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import type { CatalogProjectAppearance } from '../../../projects/browser/projectsService.js';
import type { SessionListOrganization } from './sessionsListActions.js';

export type SessionGroupingContext = Pick<ISession, 'sessionId' | 'workspace' | 'management'> & Partial<Pick<ISession, 'providerLabel'>>;

export interface SessionsCatalogAccessibility {
	readonly focusContext: string;
	readonly verbositySetting: AccessibilityVerbositySettingId;
	hint(): string;
}

export interface SessionsCatalogRow {
	readonly id: string;
	/** Canonical Session identity for rows backed by the Sessions catalog. */
	readonly sessionId?: string;
	readonly title: string;
	readonly groupingContext?: SessionGroupingContext;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	readonly forkSource?: { readonly id: string; readonly title: string; readonly open?: () => void; };
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly pinned?: boolean;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	readonly rename?: (title: string) => Promise<void>;
	readonly validateRename?: (title: string) => string | undefined;
	organization(): SessionListOrganization | undefined;
	open(threadId?: string): void;
	getActions(signal: AbortSignal): readonly IAction[] | Promise<readonly IAction[]>;
}

export interface SessionsCatalogProject {
	readonly key: string;
	readonly title: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly loading: boolean;
	readonly localProject?: ProjectSummary;
	readonly appearance?: CatalogProjectAppearance;
	readonly operations?: SessionsCatalogProjectOperations;
	readonly history?: { readonly label: string; readonly action: () => void; };
	readonly onExpand?: () => void;
	readonly loadMore?: () => void;
}

export interface ConversationProjectEditor {
	readonly details: { readonly name: string; readonly description: string; };
	save(details: ConversationProjectEditor['details']): Promise<void>;
}

export interface CatalogProjectCreator {
	readonly label: string;
	readonly description: string;
	create(details: ConversationProjectEditor['details']): Promise<{ readonly id: string; readonly preferenceKey?: string; readonly warning?: string; }>;
}

export interface SessionsCatalogProjectOperations {
	readonly editDetails?: (signal: AbortSignal) => Promise<ConversationProjectEditor>;
	readonly archive?: () => Promise<boolean>;
	readonly remove?: { readonly removesContents: boolean; run(): Promise<void>; };
}

interface SessionsCatalogSection {
	readonly key: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly projects: readonly SessionsCatalogProject[];
}

export interface SessionsCatalogSnapshot {
	readonly sections: readonly SessionsCatalogSection[];
	readonly forkEntries?: readonly SessionsCatalogRow[];
	readonly loading: boolean;
}

export interface SessionsCatalogListInput {
	readonly snapshot: IObservable<SessionsCatalogSnapshot>;
	loadMore(): void;
}
