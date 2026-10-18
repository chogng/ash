import './media/chatMarkdownPart.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IAgentThreadService } from '../../../../../../platform/agentHost/common/agentService.js';
import { type AgentAttachmentSource, type ChatContentPart } from '../../../../../../platform/agentHost/common/agent.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IChatResponseResourceFileSystemProvider } from '../../../common/widget/chatResponseResourceFileSystemProvider.js';

type Artifact = Extract<ChatContentPart, { readonly type: 'artifact'; }>['artifact'];

class ResourceRow extends Disposable {
	public readonly lifetime = this._register(new MutableDisposable<DisposableStore>());
	public identity = '';
	constructor(public readonly node: HTMLDetailsElement, public readonly summary: HTMLElement) {
		super();
		this._register(toDisposable(() => node.remove()));
	}
}

/** Displays only inert tool data. Resource URIs are labels; editors read the associated response bytes. */
export class ChatResourceGroupWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly rows = this._register(new DisposableMap<number, ResourceRow>());
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;

	constructor(document: Document,
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IChatResponseResourceFileSystemProvider private readonly files: IChatResponseResourceFileSystemProvider,
		@IEditorService private readonly editors: IEditorService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-resources';
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public render(content: readonly ChatContentPart[], source: string, coordinate?: AgentAttachmentSource): void {
		const indices = new Set<number>();
		let previous: HTMLElement | undefined;
		for (const [index, part] of content.entries()) {
			if (part.type !== 'artifact' || part.artifact.source.type === 'mcpApp' || part.artifact.source.type === 'viewMetadata') continue;
			indices.add(index);
			const artifact = part.artifact;
			const identity = JSON.stringify([source, index, artifact.source, artifact.mimeType, artifact.contentDigest, artifact.data.type, artifact.truncated]);
			const location = coordinate ? { sessionId: coordinate.sessionId, threadId: coordinate.threadId, itemId: coordinate.itemId, contentIndex: index } : undefined;
			let row = this.rows.get(index);
			if (!row) row = this.rows.set(index, this.renderResource(artifact, identity, location));
			else if (row.identity !== identity) this.renderResource(artifact, identity, location, row);
			const node = row.node;
			const next = previous ? previous.nextSibling : this.domNode.firstChild;
			if (node !== next) this.domNode.insertBefore(node, next);
			previous = node;
		}
		for (const [index] of this.rows) if (!indices.has(index)) this.rows.deleteAndDispose(index);
	}

	private renderResource(artifact: Artifact, identity: string, coordinate?: AgentAttachmentSource & { readonly contentIndex: number; }, previous?: ResourceRow): ResourceRow {
		const document = this.domNode.ownerDocument;
		const row = previous ?? new ResourceRow(h(document, 'details'), h(document, 'summary'));
		const { node, summary } = row;
		const active = document.activeElement;
		const focused = active === summary;
		const focusIndex = [...node.querySelectorAll('button, pre')].indexOf(active!);
		// Retire the old origin and its response bytes before binding updated content to the same disclosure.
		row.lifetime.clear();
		const lifetime = new DisposableStore();
		row.lifetime.value = lifetime;
		row.identity = identity;
		summary.textContent = 'uri' in artifact.source ? localize('chat.resource.title', 'Resource: {0}', artifact.source.uri) : localize('chat.resource.structured', 'Structured result');
		const metadata = h(document, 'p');
		metadata.textContent = artifact.truncated ? localize('chat.resource.truncated', '{0} · Truncated content', artifact.mimeType) : artifact.source.type === 'resourceLink' ? localize('chat.resource.linked', '{0} · Linked resource', artifact.mimeType) : artifact.mimeType;
		const body = h(document, 'pre');
		const text = artifact.data.type === 'text' ? artifact.data.text : artifact.data.type === 'json' ? artifact.data.json : undefined;
		body.tabIndex = 0;
		body.setAttribute('aria-label', summary.textContent);
		body.textContent = text === undefined ? localize('chat.resource.binary', 'Binary resource ({0} bytes)', artifact.data.type === 'bytes' ? artifact.data.bytes.length : 0) : artifact.data.type === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
		const bytes = artifact.data.type === 'bytes' ? artifact.data.bytes : new TextEncoder().encode(text!);
		let association = artifact.source.type === 'resourceLink' ? undefined : lifetime.add(this.files.associate(bytes, { id: identity, name: resourceName(artifact) }));
		const controller = new AbortController();
		lifetime.add(toDisposable(() => controller.abort()));
		const open = h(document, 'button');
		open.type = 'button';
		open.textContent = localize('chat.resource.open', 'Open resource');
		let opening = false;
		lifetime.add(addDisposableListener(open, 'click', () => {
			if (opening) return;
			opening = true;
			open.setAttribute('aria-busy', 'true');
			void (async () => {
				if (!association) {
					if (!coordinate) throw new Error(localize('chat.resource.originMissing', 'The originating tool is unavailable.'));
					const data = await this.threads.readToolResource(coordinate, controller.signal);
					if (controller.signal.aborted || lifetime.isDisposed) return;
					association = lifetime.add(this.files.associate(data.bytes, { name: resourceName({ ...artifact, mimeType: data.mimeType }) }));
				}
				if (controller.signal.aborted) return;
				await this.editors.openEditor({ resource: association.resource, readOnly: true, showBreadcrumbs: false }, { pinned: true });
			})().catch(error => {
				if (!lifetime.isDisposed && !this.isDisposed && node.isConnected) this.notifications.error(localize('chat.resource.openFailed', 'Could not open the response resource: {0}', String(error)));
			}).finally(() => { opening = false; open.removeAttribute('aria-busy'); });
		}));
		node.replaceChildren(summary, metadata, open);
		if (text !== undefined) {
			const copy = h(document, 'button');
			copy.type = 'button';
			copy.textContent = artifact.source.type === 'resourceLink' ? localize('chat.resource.copyDescription', 'Copy description') : localize('chat.resource.copy', 'Copy content');
			lifetime.add(addDisposableListener(copy, 'click', () => {
				void this.clipboard.writeText(text).then(() => { if (!this.isDisposed && node.isConnected) status(localize('chat.resource.copied', 'Resource content copied.')); }, error => {
					if (!this.isDisposed && node.isConnected) this.notifications.error(localize('chat.resource.copyFailed', 'Could not copy the response resource: {0}', String(error)));
				});
			}));
			node.append(copy);
		}
		node.append(body);
		lifetime.add(addDisposableListener(node, 'toggle', () => this.changedHeight.fire()));
		if (!previous) this.domNode.append(node);
		if (focused) summary.focus({ preventScroll: true });
		else if (focusIndex >= 0) node.querySelectorAll<HTMLElement>('button, pre')[focusIndex]?.focus({ preventScroll: true });
		return row;
	}
}

function resourceName(artifact: Artifact): string {
	const name = 'uri' in artifact.source ? artifact.source.uri.split(/[/?#]/u).filter(Boolean).at(-1)?.replace(/[\\:*"<>|]/gu, '_') ?? 'resource' : 'result.json';
	if (/\.[a-z0-9]+$/iu.test(name)) return name;
	const extension = artifact.mimeType.split(';', 1)[0] === 'application/pdf' ? '.pdf' : artifact.mimeType.startsWith('image/png') ? '.png' : artifact.mimeType.startsWith('image/jpeg') ? '.jpg' : artifact.mimeType.startsWith('image/webp') ? '.webp' : artifact.mimeType.startsWith('text/html') ? '.html' : artifact.mimeType.startsWith('text/markdown') ? '.md' : artifact.mimeType.startsWith('application/json') ? '.json' : '.txt';
	return name + extension;
}
