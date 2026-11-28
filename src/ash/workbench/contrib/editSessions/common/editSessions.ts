import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { workspaceResourceFromPath } from '../../../../platform/workspace/common/workspace.js';

export const IEditSessionsStorageService = createDecorator<IEditSessionsStorageService>('editSessionsStorageService');

export interface IEditSessionsStorageService {
	read(repositoryId: string): Promise<EditSessionSlot>;
	write(repositoryId: string, session: EditSession, expectedRevision: string | undefined): Promise<void>;
	clear(repositoryId: string, expectedRevision: string): Promise<boolean>;
}

export type EditSessionSlot =
	| { readonly kind: 'empty'; readonly revision: string | undefined; }
	| { readonly kind: 'saved'; readonly session: EditSession; readonly revision: string; }
	| { readonly kind: 'invalid'; readonly error: unknown; readonly revision: string; };

export const EDIT_SESSIONS_SCHEME = 'ash-edit-sessions';

/** Byte-exact sides of a saved working change. Null denotes a missing file. */
export interface WorkingChange {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
}

export interface EditSession {
	readonly version: 1;
	readonly head: string;
	readonly changes: readonly WorkingChange[];
}

export const editSessionFileLimit = 512;
export const editSessionSizeLimit = 12 * 1024 * 1024;

export function editSessionResource(root: URI, path: string): URI | undefined {
	return isEditSessionPath(path) ? workspaceResourceFromPath(root, path) : undefined;
}

function isEditSessionPath(path: string): boolean {
	// The same data may be opened on a case-insensitive or Windows filesystem.
	// Exclude Git administrative paths, alternate streams and ambiguous aliases.
	return path.length <= 2048 && !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
		path.split('/').every(segment => segment.length > 0 && !/^\.git$/iu.test(segment) && !/[ .]$/u.test(segment));
}

export function parseEditSession(text: string): EditSession {
	const session: unknown = JSON.parse(text);
	if (typeof session !== 'object' || session === null || !('version' in session) || session.version !== 1 ||
		!('head' in session) || typeof session.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(session.head) ||
		!('changes' in session) || !Array.isArray(session.changes) || session.changes.length === 0 ||
		session.changes.length > editSessionFileLimit) {
		throw new TypeError('Invalid edit session');
	}
	const paths = new Set<string>();
	const changes: WorkingChange[] = [];
	for (const entry of session.changes as readonly unknown[]) {
		if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string' ||
			!isEditSessionPath(entry.path) || paths.has(entry.path) ||
			!('before' in entry) || !isFileContents(entry.before) || !('after' in entry) || !isFileContents(entry.after) ||
			entry.before === entry.after) {
			throw new TypeError('Invalid edit session change');
		}
		paths.add(entry.path);
		changes.push({ path: entry.path, before: entry.before, after: entry.after });
	}
	return { version: 1, head: session.head, changes };
}

function isFileContents(value: unknown): value is string | null {
	return value === null || typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value);
}
