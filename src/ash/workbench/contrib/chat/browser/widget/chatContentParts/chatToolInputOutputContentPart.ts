import type { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import type { ToolResultTextPage } from '../../../../../../platform/agentHost/common/agent.js';
import type { IAgentThreadService } from '../../../../../../platform/agentHost/common/agentService.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import './media/chatCollapsibleContentPart.css';

interface ToolTextSection {
	readonly details: HTMLDetailsElement;
	readonly summary: HTMLElement;
	readonly content: HTMLElement;
	readonly text: Text;
}

export interface IToolOutputPresentation {
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string;
}

/** Projects tool evidence into independently scrollable disclosures without interpreting its contents. */
export class ChatCollapsibleInputOutputContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly sections = new Map<'input' | 'stdout' | 'stderr' | 'result', ToolTextSection>();
	private readonly pager = this._register(new MutableDisposable<ToolResultPager>());
	private previewText = '';
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;

	constructor(document: Document, private readonly threadService: IAgentThreadService) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-tool-io';
		for (const key of ['input', 'stdout', 'stderr', 'result'] as const) {
			const details = h(document, 'details');
			details.className = 'ash-chat-tool-io-section';
			details.dataset.toolSection = key;
			details.hidden = true;
			const summary = h(document, 'summary');
			const content = h(document, 'pre');
			content.tabIndex = 0;
			content.setAttribute('role', 'region');
			const text = document.createTextNode('');
			content.append(text);
			details.append(summary, '\n', content);
			this.domNode.append(details);
			this.sections.set(key, { details, summary, content, text });
			this._register(addDisposableListener(details, 'toggle', () => this.changedHeight.fire()));
		}
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public render(invocation: IChatToolInvocation, presentation?: IToolOutputPresentation, source?: IChatListItem['attachmentSource']): void {
		const result = invocation.result;
		const textParts = result?.content?.flatMap(part => part.type === 'text' ? [part.text] : []);
		if (result?.outputPreview) {
			// Empty placeholders keep the original content indexes for attachment reads.
			while (textParts?.length && textParts.at(-1) === '') textParts.pop();
		}
		const resultText = textParts?.length ? textParts.join('\n') : result?.text ?? '';
		this.previewText = presentation?.result ?? resultText;
		if (source && result?.outputPreview) {
			const coordinate = { sessionId: source.sessionId, threadId: source.threadId, turnId: result.turnId, itemId: result.itemId, itemOrdinal: result.outputPreview.itemOrdinal };
			const identity = JSON.stringify(coordinate);
			if (this.pager.value?.identity !== identity) {
				const section = this.sections.get('result')!;
				const pager = new ToolResultPager(section.details.ownerDocument, identity,
					(offset, signal) => this.threadService.readToolResultText(coordinate, offset, signal),
					text => {
						section.text.data = text ?? this.previewText;
						section.content.scrollTop = 0;
						section.content.scrollLeft = 0;
						this.changedHeight.fire();
					});
				this.pager.value = pager;
				section.details.insertBefore(pager.domNode, section.content);
			}
		} else {
			this.pager.clear();
		}
		const values = {
			input: { label: localize('chat.tool.input', 'Input'), text: invocation.call.argumentsJson },
			stdout: { label: localize('chat.tool.stdout', 'Standard output'), text: presentation?.stdout ?? invocation.output.filter(part => part.stream === 'stdout').map(part => part.text).join('\n') },
			stderr: { label: localize('chat.tool.stderr', 'Standard error'), text: presentation?.stderr ?? invocation.output.filter(part => part.stream === 'stderr').map(part => part.text).join('\n') },
			result: { label: result?.isError ? localize('chat.tool.error', 'Error') : localize('chat.tool.result', 'Result'), text: this.pager.value?.text ?? this.previewText },
		};
		let changed = false;
		for (const [key, section] of this.sections) {
			const value = values[key];
			if (section.summary.textContent !== value.label) {
				section.summary.textContent = value.label;
				section.content.setAttribute('aria-label', value.label);
			}
			section.details.classList.toggle('error', key === 'stderr' || key === 'result' && result?.isError === true);
			section.details.hidden = !value.text && !(key === 'result' && this.pager.value);
			if (section.text.data === value.text) {
				continue;
			}
			// Append to the existing text node so selecting earlier output survives streaming.
			if (value.text.startsWith(section.text.data)) {
				section.text.appendData(value.text.slice(section.text.length));
			} else {
				section.text.data = value.text;
			}
			changed = true;
		}
		if (changed) {
			this.changedHeight.fire();
		}
	}
}

/** Keeps one literal page in the row. Retiring the row also retires its pending read. */
class ToolResultPager extends Disposable {
	readonly domNode: HTMLElement;
	private readonly status: HTMLElement;
	private readonly previous: Button;
	private readonly next: Button;
	private readonly abort = new AbortController();
	private readonly offsets: number[] = [];
	private page: ToolResultTextPage | undefined;
	private pending = false;

	get text(): string | undefined { return this.page?.text; }

	constructor(
		document: Document,
		readonly identity: string,
		private readonly read: (offset: number, signal: AbortSignal) => Promise<ToolResultTextPage>,
		private readonly updateText: (text?: string) => void,
	) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-tool-result-pager';
		this.status = h(document, 'span');
		this.status.setAttribute('role', 'status');
		this.domNode.append(this.status);
		const buttonOptions = { ...defaultButtonStyles, size: 'small', presentation: 'quiet', label: '' } as const;
		this.previous = this._register(new Button(this.domNode, { ...buttonOptions, onClick: () => this.back() }));
		this.next = this._register(new Button(this.domNode, {
			...buttonOptions,
			onClick: () => {
				const offset = this.page ? this.page.nextOffset : 0;
				if (offset !== undefined) void this.load(offset, this.offsets.length);
			},
		}));
		this._register(toDisposable(() => {
			this.abort.abort();
			this.domNode.remove();
		}));
		this.renderControls();
	}

	private back(): void {
		if (this.pending || !this.page) return;
		const previousIndex = this.offsets.length - 2;
		if (previousIndex >= 0) {
			void this.load(this.offsets[previousIndex], previousIndex);
			return;
		}
		this.page = undefined;
		this.offsets.length = 0;
		this.next.domNode.focus();
		this.renderControls();
		this.updateText();
	}

	private async load(offset: number, index: number): Promise<void> {
		if (this.pending) return;
		this.pending = true;
		this.renderControls(localize('chat.tool.outputLoading', 'Loading output…'));
		let status: string | undefined;
		try {
			const page = await this.read(offset, this.abort.signal);
			if (this.abort.signal.aborted) return;
			this.page = page;
			this.offsets.splice(index, this.offsets.length - index, offset);
			this.updateText(page.text);
		} catch {
			status = localize('chat.tool.outputReadFailed', 'Could not read output. Try again.');
		} finally {
			this.pending = false;
			if (!this.abort.signal.aborted) this.renderControls(status);
		}
	}

	private renderControls(status?: string): void {
		this.status.textContent = status ?? (this.page
			? localize('chat.tool.outputPage', 'Output page {0}', this.offsets.length)
			: localize('chat.tool.outputPreview', 'Output preview'));
		this.previous.domNode.hidden = !this.page;
		this.previous.label = this.offsets.length > 1
			? localize('chat.tool.outputPreviousPage', 'Previous page')
			: localize('chat.tool.outputBackToPreview', 'Back to preview');
		this.previous.domNode.setAttribute('aria-disabled', String(this.pending));
		this.next.label = this.page
			? localize('chat.tool.outputNextPage', 'Next page')
			: localize('chat.tool.outputRead', 'Read full output');
		this.next.domNode.setAttribute('aria-disabled', String(this.pending || !!this.page && this.page.nextOffset === undefined));
	}
}
