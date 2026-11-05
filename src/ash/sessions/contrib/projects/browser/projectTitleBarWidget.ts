import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button, type IButtonOptions } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISessionsTitlebarService } from '../../../browser/parts/titlebarPart.js';
import './media/projectTitleBarWidget.css';

interface ProjectTitleBarOptions extends Pick<IButtonOptions, 'icon' | 'size' | 'onClick'> {
	readonly editable?: boolean;
}

interface ProjectTitleRenameTarget {
	readonly id: string;
	readonly save: (name: string) => Promise<boolean>;
}

interface ProjectTitleNameOptions {
	readonly rename?: ProjectTitleRenameTarget;
	readonly busy?: boolean;
	readonly loading?: boolean;
}

/** Mounts a project name and any surrounding navigation in the window title bar. */
export class ProjectTitleBarWidget extends Disposable {
	private readonly nameButton: Button;
	private readonly mount = this._register(new MutableDisposable());
	private readonly renameInput: HTMLInputElement | undefined;
	private renameTarget: ProjectTitleRenameTarget | undefined;
	private busy = false;
	private draft: { target: ProjectTitleRenameTarget; originalName: string; saving: boolean; } | undefined;

	constructor(
		private readonly element: HTMLElement,
		options: ProjectTitleBarOptions,
		@ISessionsTitlebarService private readonly titlebar: ISessionsTitlebarService,
	) {
		super();
		element.classList.add('ash-project-titlebar');
		this.nameButton = this._register(new Button(element, {
			...defaultButtonStyles, label: '', icon: options.icon, size: options.size,
			onClick: options.editable ? () => this.beginRename() : options.onClick,
		}));
		this.nameButton.domNode.classList.add('ash-project-titlebar-name');
		if (options.editable) {
			this.nameButton.domNode.classList.add('ash-projects-breadcrumb-name');
			this.nameButton.domNode.setAttribute('aria-current', 'page');
			const input = this.renameInput = h(element.ownerDocument, 'input', {
				className: 'ash-projects-rename',
				properties: { type: 'text', maxLength: 200, hidden: true },
				attributes: {
					'aria-label': localize('projects.projectName', 'Project name'),
					'aria-description': localize('projects.renameHint', 'Enter to save, Escape to cancel.'),
				},
			});
			element.append(input);
			this._register(addDisposableListener(input, 'keydown', event => {
				if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
				event.preventDefault();
				event.stopPropagation();
				if (this.draft?.saving) return;
				if (event.key === 'Escape') this.finishRename(true);
				else void this.saveRename();
			}));
			this._register(addDisposableListener(input, 'blur', () => { void this.saveRename(); }));
		}
	}

	setName(name: string, { rename, busy = false, loading = false }: ProjectTitleNameOptions = {}): void {
		this.renameTarget = rename;
		this.busy = busy;
		if (this.draft && this.draft.target.id !== rename?.id) this.finishRename(false);
		const button = this.nameButton;
		const label = rename ? localize('projects.rename', 'Rename project {0}', name) : name;
		if (button.label !== name || button.domNode.getAttribute('aria-label') !== label) {
			button.label = name;
			button.setTitle(label || undefined);
		}
		button.hidden = (!name && !loading) || !!this.draft;
		button.enabled = !this.renameInput || !!rename && !busy;
		button.domNode.classList.toggle('ash-projects-placeholder', loading);
		button.domNode.setAttribute('aria-hidden', String(loading));
		button.domNode.setAttribute('aria-label', label);
	}

	setVisible(visible: boolean): void {
		if (visible) {
			this.mount.value ??= this.titlebar.setPageContent(this.element);
		} else {
			this.finishRename(false);
			this.mount.clear();
		}
	}

	private beginRename(): void {
		const input = this.renameInput;
		if (!input || !this.renameTarget || this.busy || this.draft) return;
		this.draft = { target: this.renameTarget, originalName: this.nameButton.label, saving: false };
		input.style.width = `${Math.max(160, this.nameButton.domNode.offsetWidth)}px`;
		input.value = this.nameButton.label;
		input.readOnly = false;
		input.hidden = false;
		this.nameButton.hidden = true;
		input.focus();
		input.select();
	}

	private finishRename(restoreFocus: boolean): void {
		if (!this.draft || !this.renameInput) return;
		this.draft = undefined;
		this.renameInput.hidden = true;
		this.nameButton.hidden = !this.nameButton.label;
		if (restoreFocus) this.nameButton.focus();
	}

	private async saveRename(): Promise<void> {
		const { draft, renameInput: input } = this;
		if (!input || !draft || draft.saving || this.busy) return;
		const name = input.value.trim();
		if (!name || name === draft.originalName) {
			this.finishRename(getActiveElement(input.ownerDocument) === input);
			return;
		}
		draft.saving = true;
		input.readOnly = true;
		const saved = await draft.target.save(name);
		if (this.isDisposed || this.draft !== draft) return;
		if (saved) {
			this.finishRename(getActiveElement(input.ownerDocument) === input);
			status(localize('projects.renamed', 'Project renamed to {0}.', name));
		} else {
			// The owner may have refreshed the project revision while preserving the draft.
			draft.target = this.renameTarget ?? draft.target;
			draft.originalName = this.nameButton.label;
			draft.saving = false;
			input.readOnly = false;
		}
	}
}
