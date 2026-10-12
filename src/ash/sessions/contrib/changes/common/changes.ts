// Layout and accessibility consumers use identities without loading contribution registrations.
export const CHANGES_VIEW_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.changesContainer';
export const CHANGES_VIEW_ID = 'sessions.changes';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const CreatePullRequestFocusedContext = new RawContextKey<boolean>('sessions.createPullRequestFocused', false);

export const enum ChangesViewMode {
	List = 'list',
	Tree = 'tree',
}
