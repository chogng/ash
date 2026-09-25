import './releaseNotesEditor.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/openerService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { MarkdownDocumentView } from '../../markdown/browser/markdownDocumentRenderer.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { IOnboardingTryoutService } from '../../onboarding/common/onboardingTryout.js';
import { prepareReleaseNotesMarkdown, releaseNotesTryoutId } from './releaseNotesTryouts.js';
import packageMetadata from '../../../../../../package.json' with { type: 'json' };

export const releaseNotesEditorId = 'workbench.editor.releaseNotes';
export const releaseNotesResource = 'ash-release-notes:/current';

const releaseNotesByFile = import.meta.glob('../../../../../../release-notes/v*.md', { query: '?raw', import: 'default', eager: true }) as Readonly<Record<string, string>>;

export class ReleaseNotesEditor extends Disposable implements IEditorPane {
	readonly id = releaseNotesEditorId;
	private root!: HTMLElement;
	private documentView!: MarkdownDocumentView;

	constructor(
		@ILocaleService private readonly locale: ILocaleService,
		@IOnboardingTryoutService private readonly tryouts: IOnboardingTryoutService,
		@IOpenerService private readonly opener: IOpenerService,
	) { super(); }

	create(parent: HTMLElement): void {
		this.root = h(parent.ownerDocument, 'div');
		this.root.className = 'ash-release-notes-editor';
		parent.append(this.root);
		this._register(toDisposable(() => this.root.remove()));
		this.documentView = this._register(new MarkdownDocumentView(this.root, {
			title: localize('releaseNotes.title', 'Release Notes'),
			openLink: href => this.openLink(href),
		}));
		this._register(this.locale.onDidChangeLocale(() => this.render()));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (input.resource.toString() !== releaseNotesResource) throw new Error('Invalid release notes resource');
		this.render();
	}

	clearInput(): void {}
	layout(_dimension: IDimension): void {}
	setVisible(_visibility: EditorPaneVisibility): void {}
	focus(): void { this.documentView.focus(); }

	private render(): void {
		const match = /^(\d+\.\d+)\./.exec(packageMetadata.version);
		const basePath = match && `../../../../../../release-notes/v${match[1].replace('.', '_')}`;
		const suffix = this.locale.locale === 'zh-CN' ? '.zh-CN.md' : '.md';
		const notes = basePath && releaseNotesByFile[`${basePath}${suffix}`];
		if (!notes) {
			this.documentView.setMarkdown(localize('releaseNotes.unavailable', '# Release notes unavailable\n\nThere are no release notes for this version.'));
			return;
		}
		this.documentView.setMarkdown(prepareReleaseNotesMarkdown(notes));
	}

	private async openLink(href: string): Promise<void> {
		const id = releaseNotesTryoutId(href);
		if (id) {
			await this.tryouts.run(id);
			return;
		}
		if (/^https?:\/\//.test(href)) await this.opener.openExternal(href);
	}
}
