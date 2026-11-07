import type { IAction } from '../../../../../base/common/actions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import type { IObservable } from '../../../../../base/common/observable.js';
import type { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { ISessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';
import type { SessionListOrganization } from './sessionsListActions.js';

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
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly pinned?: boolean;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	organization(): SessionListOrganization | undefined;
	open(threadId?: string): void;
	getActions(signal: AbortSignal, restoreFocus: () => void): readonly IAction[] | Promise<readonly IAction[]>;
}

export interface SessionsCatalogProject {
	readonly key: string;
	readonly title: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly loading: boolean;
	readonly history?: { readonly label: string; readonly action?: () => void; };
	readonly onExpand?: () => void;
	readonly loadMore?: () => void;
}

interface SessionsCatalogSection {
	readonly key: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly projects: readonly SessionsCatalogProject[];
}

export interface SessionsCatalogSnapshot {
	readonly sections: readonly SessionsCatalogSection[];
	readonly loading: boolean;
}

export interface SessionsCatalogListInput {
	readonly snapshot: IObservable<SessionsCatalogSnapshot>;
	loadMore(): void;
}
