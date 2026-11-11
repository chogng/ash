import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatTurnFileChange } from '../../chatResponseFileChangesService.js';
import { DefaultChatEditPresentation } from './defaultChatEditPresentation.js';

/** Lazily shows a revision-bound file comparison in the response that produced it. */
export class ChatTextEditContentPart extends Disposable {
	private readonly button: Button;
	private readonly panel: HTMLElement;
	private readonly status: HTMLElement;
	private readonly host: HTMLElement;
	private readonly preview = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		actions: HTMLElement,
		row: HTMLElement,
		private file: ChatTurnFileChange & { readonly preview: NonNullable<ChatTurnFileChange['preview']>; },
		private readonly onDidChangeHeight: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILanguageService private readonly languages: ILanguageService,
	) {
		super();
		const document = row.ownerDocument;
		const label = localize('chat.turnChanges.previewFile', 'Preview changes for {0}', file.path);
		this.button = this._register(new Button(actions, { ...defaultButtonStyles, label, title: label, icon: Lxicon.diff, iconOnly: true, presentation: 'quiet', size: 'small' }));
		this.status = h(document, 'p', { className: 'ash-chat-edit-preview-status', attributes: { role: 'status' } });
		this.host = h(document, 'div', { className: 'ash-chat-edit-preview-editor' });
		this.panel = h(document, 'div', { className: 'ash-chat-edit-preview' }, this.status, this.host);
		this.panel.id = createUuid();
		this.panel.hidden = true;
		this.button.domNode.setAttribute('aria-controls', this.panel.id);
		this.button.domNode.setAttribute('aria-expanded', 'false');
		row.append(this.panel);
		this._register(toDisposable(() => { this.panel.remove(); this.button.domNode.remove(); }));
		this._register(this.button.onDidClick(() => { void this.toggle(); }));
	}

	updateFile(file: ChatTurnFileChange & { readonly preview: NonNullable<ChatTurnFileChange['preview']>; }): void {
		this.file = file;
	}

	private async toggle(): Promise<void> {
		if (!this.panel.hidden) {
			this.preview.clear();
			this.panel.hidden = true;
			this.button.domNode.setAttribute('aria-expanded', 'false');
			this.onDidChangeHeight();
			return;
		}
		const resources = this.preview.value = new DisposableStore();
		const controller = new AbortController();
		resources.add(toDisposable(() => controller.abort()));
		this.panel.hidden = false;
		this.status.hidden = false;
		this.status.textContent = localize('chat.turnChanges.previewLoading', 'Loading file changes…');
		this.host.hidden = true;
		this.button.domNode.setAttribute('aria-expanded', 'true');
		this.onDidChangeHeight();
		try {
			const contents = await this.file.preview.read(controller.signal);
			if (controller.signal.aborted) return;
			const path = this.file.path.replace(/\\/g, '/');
			const resource = URI.from({ scheme: 'ash-chat-edit', path: path.startsWith('/') ? path : `/${path}` });
			const languageId = this.languages.guessLanguageIdByFilepathOrFirstLine(resource) ?? 'plaintext';
			this.status.hidden = true;
			this.host.hidden = false;
			resources.add(this.instantiation.createInstance(DefaultChatEditPresentation, this.host, { ...contents, languageId }, (height: number) => {
				const size = `${height}px`;
				if (this.host.style.blockSize !== size) {
					this.host.style.blockSize = size;
					this.onDidChangeHeight();
				}
			}));
		} catch (error) {
			if (controller.signal.aborted || isCancellationError(error)) return;
			this.host.hidden = true;
			this.status.hidden = false;
			this.status.textContent = localize('chat.turnChanges.previewFailed', 'Could not preview changes. {0}', error instanceof Error ? error.message : String(error));
		}
		this.onDidChangeHeight();
	}
}
