import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { DisposableMap, DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import type { ChatContentPart } from '../../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../../../nls.js';
import { ChatMarkdownContentPart } from '../chatMarkdownContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** Opt-in formatted previews of explicitly typed Markdown resources, alongside their exact raw bytes. */
export class ChatInputOutputMarkdownProgressPart extends BaseChatToolInvocationSubPart<HTMLDetailsElement> {
	private readonly parts = this._register(new DisposableMap<number, DisposableStore & { part: ChatMarkdownContentPart; }>());
	private visible = true;

	constructor(document: Document, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super(h(document, 'details'));
		const summary = h(document, 'summary');
		summary.textContent = localize('chat.tool.markdownPreview', 'Preview formatted results');
		this.domNode.append(summary);
		this._register(addDisposableListener(this.domNode, 'toggle', () => {
			for (const [, entry] of this.parts) entry.part.setVisible(this.visible && this.domNode.open);
			this.changedHeight.fire();
		}));
	}

	public get codeblocks() {
		return [...this.parts].flatMap(([, entry]) => entry.part.codeblocks.map(info => ({
			...info, focus: () => {
				if (this.isDisposed || !this.visible) return;
				this.domNode.open = true;
				entry.part.setVisible(true);
				info.focus();
			}
		})));
	}

	public render(content: readonly ChatContentPart[]): void {
		const used = new Set<number>();
		let previous: HTMLElement = this.domNode.firstElementChild as HTMLElement;
		for (const [index, value] of content.entries()) {
			if (value.type !== 'artifact' || value.artifact.source.type === 'mcpApp' || value.artifact.source.type === 'viewMetadata'
				|| value.artifact.mimeType.split(';', 1)[0].trim().toLowerCase() !== 'text/markdown' || value.artifact.data.type !== 'text') continue;
			used.add(index);
			const markdown = { value: value.artifact.data.text, isTrusted: false, supportHtml: false };
			let entry = this.parts.get(index);
			if (!entry) {
				const part = this.instantiation.createInstance(ChatMarkdownContentPart, { ownerDocument: this.domNode.ownerDocument, markdown, visible: this.visible && this.domNode.open });
				entry = this.parts.set(index, Object.assign(new DisposableStore(), { part }));
				entry.add(part);
				entry.add(part.onDidChangeHeight(() => this.changedHeight.fire()));
			} else entry.part.tryIncrementalUpdate(markdown);
			const next = previous.nextSibling;
			if (entry.part.domNode !== next) this.domNode.insertBefore(entry.part.domNode, next);
			previous = entry.part.domNode;
		}
		for (const index of this.parts.keys()) if (!used.has(index)) this.parts.deleteAndDispose(index);
		this.domNode.hidden = used.size === 0;
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		for (const [, entry] of this.parts) entry.part.setVisible(visible && this.domNode.open);
	}
}
