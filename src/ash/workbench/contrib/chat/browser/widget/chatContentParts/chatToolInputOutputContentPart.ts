import type { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import './media/chatCollapsibleContentPart.css';

interface ToolTextSection {
	readonly details: HTMLDetailsElement;
	readonly summary: HTMLElement;
	readonly content: HTMLElement;
	readonly text: Text;
}

/** Projects tool evidence into independently scrollable disclosures without interpreting its contents. */
export class ChatCollapsibleInputOutputContentPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly sections = new Map<'input' | 'stdout' | 'stderr' | 'result', ToolTextSection>();
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;

	constructor(document: Document) {
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

	public render(invocation: IChatToolInvocation): void {
		const result = invocation.result;
		const textParts = result?.content?.filter(part => part.type === 'text');
		const resultText = textParts?.length ? textParts.map(part => part.text).join('\n') : result?.text ?? '';
		const values = {
			input: { label: localize('chat.tool.input', 'Input'), text: invocation.call.argumentsJson },
			stdout: { label: localize('chat.tool.stdout', 'Standard output'), text: invocation.output.filter(part => part.stream === 'stdout').map(part => part.text).join('\n') },
			stderr: { label: localize('chat.tool.stderr', 'Standard error'), text: invocation.output.filter(part => part.stream === 'stderr').map(part => part.text).join('\n') },
			result: { label: result?.isError ? localize('chat.tool.error', 'Error') : localize('chat.tool.result', 'Result'), text: resultText },
		};
		let changed = false;
		for (const [key, section] of this.sections) {
			const value = values[key];
			if (section.summary.textContent !== value.label) {
				section.summary.textContent = value.label;
				section.content.setAttribute('aria-label', value.label);
			}
			section.details.classList.toggle('error', key === 'stderr' || key === 'result' && result?.isError === true);
			section.details.hidden = !value.text;
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
