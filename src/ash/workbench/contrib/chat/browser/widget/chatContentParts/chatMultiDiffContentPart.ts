import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatEditFileDiff, IChatEditPresentation } from './chatEditPresentation.js';
import { DefaultChatEditPresentation } from './defaultChatEditPresentation.js';

/** Shows one file at a time so a multi-file patch never combines unrelated hunks. */
export class ChatMultiDiffContentPart extends Disposable implements IChatEditPresentation {
	private readonly select: HTMLSelectElement;
	private readonly comparison = this._register(new MutableDisposable<IChatEditPresentation>());

	constructor(
		container: HTMLElement,
		files: readonly IChatEditFileDiff[],
		selected: number,
		onDidSelect: (index: number) => void,
		layout: (height: number) => void,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		this.select = h(document, 'select', { attributes: { 'aria-label': localize('chat.diff.selectFile', 'File in comparison') } });
		for (const [index, file] of files.entries()) {
			const option = h(document, 'option', file.path ?? localize('chat.diff.unnamedFile', 'File {0}', index + 1));
			option.value = String(index);
			this.select.append(option);
		}
		this.select.selectedIndex = Math.min(selected, files.length - 1);
		const controls = h(document, 'div', { className: 'ash-chat-multi-diff-controls' }, this.select);
		const host = h(document, 'div', { className: 'ash-chat-multi-diff-editor' });
		container.append(controls, host);
		this._register(toDisposable(() => { controls.remove(); host.remove(); }));
		const render = () => {
			this.comparison.clear();
			const index = this.select.selectedIndex;
			const file = files[index];
			if (!file) return;
			onDidSelect(index);
			this.comparison.value = instantiation.createInstance(DefaultChatEditPresentation, host, file, (height: number) => {
				host.style.blockSize = `${height}px`;
				layout(height + controls.offsetHeight);
			});
		};
		this._register(addDisposableListener(this.select, 'change', render));
		try { render(); } catch (error) { this.dispose(); throw error; }
	}

	focus(original = false): void {
		this.comparison.value?.focus(original);
	}
}
