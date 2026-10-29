import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { isRemoteResource, withRemoteWorkspacePath } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export const enum DebugLinkHoverBehavior {
	Rich,
	Basic,
	None,
}
export type DebugLinkHoverBehaviorTypeData = { readonly type: DebugLinkHoverBehavior; readonly store: DisposableStore; };

/** The console's used linkification port; row owners supply the listener lifetime. */
export interface ILinkDetector {
	linkify(text: string, hoverBehavior: DebugLinkHoverBehaviorTypeData, splitLines?: boolean, workspaceFolder?: IWorkspaceFolder): HTMLElement;
}

/** Projects text into links. File identity and opening remain with the window services. */
export class LinkDetector implements ILinkDetector {
	constructor(
		@IEditorService private readonly editors: IEditorService,
		@IFileService private readonly files: IFileService,
		@IOpenerService private readonly openers: IOpenerService,
		@IHoverService private readonly hovers: IHoverService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { }

	linkify(text: string, hoverBehavior: DebugLinkHoverBehaviorTypeData, splitLines = false, workspaceFolder?: IWorkspaceFolder): HTMLElement {
		const root = h(document, 'span');
		const store = hoverBehavior.store;
		let current = !store.isDisposed;
		const workspaceId = this.workspace.getWorkspace().id;
		store.add(toDisposable(() => { current = false; }));
		const isCurrent = () => current && (!workspaceFolder || this.workspace.getWorkspace().id === workspaceId
			&& this.workspace.getWorkspace().folders.some(folder => folder.id === workspaceFolder.id && folder.uri.toString() === workspaceFolder.uri.toString()));
		const lines = splitLines ? text.match(/[^\n]*\n|[^\n]+$/g) ?? [] : [text];
		for (const line of lines) {
			const host = splitLines ? root.appendChild(h(document, 'span')) : root;
			let offset = 0;
			// URLs take precedence over embedded paths. A token boundary keeps long
			// unbroken output from retrying the relative-path pattern at every character.
			const candidates = /\b(?:https?:\/\/|mailto:|file:\/\/)[^\s<>"\x00-\x1f]+|(?<![\p{L}\p{N}_.-])(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\p{L}\p{N}_.-]+[\\/])[^\s<>"\x00-\x1f]+/giu;
			for (const match of line.matchAll(candidates)) {
				const value = match[0].length > 32768 ? match[0] : trimPunctuation(match[0]);
				host.append(document.createTextNode(line.slice(offset, match.index)));
				const label = h(document, 'span');
				label.textContent = value;
				host.append(label);
				offset = match.index + value.length;
				if (value.length > 32768) continue;
				if (/^(?:https?:\/\/|mailto:)/i.test(value)) {
					try {
						const uri = URI.parse(value);
						if (/^https?$/i.test(uri.scheme) && !uri.authority
							|| uri.scheme === 'mailto' && !uri.path.includes('@')) continue;
						this.activate(label, hoverBehavior, isCurrent, async side => {
							await this.openers.open(uri, { fromUserGesture: true, allowContributedOpeners: true, openToSide: side });
						});
					} catch { /* Malformed output remains plain text. */ }
				} else {
					const location = fileLocation(value, workspaceFolder);
					if (location) void this.files.stat(location.resource).then(stat => {
						if (isCurrent() && stat.kind === FileKind.File) this.activate(label, hoverBehavior, isCurrent, async side => {
							await this.editors.openEditor({ resource: location.resource }, { selection: location.selection }, side ? 'sideGroup' : 'activeGroup');
						});
					}, () => { /* Missing or inaccessible paths are ordinary output. */ });
				}
			}
			host.append(document.createTextNode(line.slice(offset)));
		}
		return root;
	}

	private activate(label: HTMLElement, hover: DebugLinkHoverBehaviorTypeData, isCurrent: () => boolean, open: (side: boolean) => Promise<void>): void {
		if (!isCurrent()) return;
		label.className = 'ash-debug-link';
		label.setAttribute('role', 'link');
		label.tabIndex = 0;
		const hint = localize('debug.repl.followLink', 'Ctrl/Cmd+click or Enter to follow link');
		label.setAttribute('aria-description', hint);
		if (hover.type === DebugLinkHoverBehavior.Rich) hover.store.add(this.hovers.setupDelayedHover(label, { content: hint }));
		else if (hover.type === DebugLinkHoverBehavior.Basic) label.title = hint;
		const follow = (side: boolean) => {
			if (!isCurrent()) return;
			void open(side).catch(error => {
				if (isCurrent()) this.notifications.error(error instanceof Error ? error.message : String(error));
			});
		};
		hover.store.add(addDisposableListener(label, 'click', event => {
			event.stopPropagation();
			if ((event.ctrlKey || event.metaKey) && !label.ownerDocument.getSelection()?.toString()) follow(event.shiftKey);
		}));
		hover.store.add(addDisposableListener(label, 'keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			follow(event.shiftKey);
		}));
	}
}

function trimPunctuation(text: string): string {
	let result = text.replace(/[.,;!?]+$/, '');
	for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
		let excess = result.split(close!).length - result.split(open!).length;
		while (excess > 0 && result.endsWith(close!)) {
			result = result.slice(0, -1);
			excess--;
		}
	}
	return result;
}

function fileLocation(text: string, folder: IWorkspaceFolder | undefined): { resource: URI; selection?: Range; } | undefined {
	const suffix = /:(\d+)(?::(\d+))?$/.exec(text);
	const line = suffix ? Number(suffix[1]) : 1;
	const column = suffix?.[2] ? Number(suffix[2]) : 1;
	if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return undefined;
	const path = suffix ? text.slice(0, suffix.index) : text;
	try {
		let resource: URI;
		if (/^file:\/\//i.test(path)) {
			resource = URI.parse(path);
			if (resource.query || resource.fragment) return undefined;
			if (folder && isRemoteResource(folder.uri)) resource = withRemoteWorkspacePath(folder.uri, resource.path);
		} else {
			// A bare path carries no execution authority; never guess a local filesystem.
			if (!folder) return undefined;
			const windows = /^[A-Za-z]:[\\/]/.test(path);
			if (path.startsWith('/') || windows) {
				resource = isRemoteResource(folder.uri) ? withRemoteWorkspacePath(folder.uri, path)
					: URI.from({ scheme: 'file', path: windows ? path.replaceAll('\\', '/') : path });
			} else resource = URI.joinPath(folder.uri, path.replaceAll('\\', '/'));
		}
		return { resource, selection: suffix ? new Range(line, column, line, column) : undefined };
	} catch { return undefined; }
}
