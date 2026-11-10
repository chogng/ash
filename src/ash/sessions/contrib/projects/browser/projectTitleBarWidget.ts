import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IAction } from '../../../../base/common/actions.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, autorunWithStore, derived, observableFromEvent, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { Menus } from '../../../browser/menus.js';
import { renderInlineRenameInput, showInlineRenameInput } from '../../../browser/parts/titlebar/inlineRenameInput.js';
import { ReplyChatEditor } from '../../chat/browser/replyChatEditor.js';
import { ProjectsEditorPane } from './projectsEditor.js';
import './media/projectTitleBarWidget.css';

interface ProjectTitleRenameTarget {
	readonly id: string;
	readonly save: (name: string, signal: AbortSignal) => Promise<boolean>;
}

interface ProjectBreadcrumbContent {
	readonly kind: 'breadcrumb';
	readonly name: string;
	readonly open: () => void;
	readonly editor: HTMLElement;
	readonly showSeparator: boolean;
	readonly catalogCurrent: boolean;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly rename: ProjectTitleRenameTarget | undefined;
}

export type ProjectTitleBarContent = ProjectBreadcrumbContent | {
	readonly kind: 'shortcut';
	readonly name: string;
	readonly open: () => void;
};

class ProjectTitleBarWidget extends ActionViewItem {
	private tabbable = false;
	private buttons: readonly Button[] = [];

	constructor(
		action: IAction,
		options: ActionViewItemOptions,
		private readonly content: IObservable<ProjectTitleBarContent | undefined>,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		const kind = derived(reader => this.content.read(reader)?.kind);
		this._register(autorunWithStore((reader, store) => {
			switch (kind.read(reader)) {
				case 'breadcrumb':
					this.buttons = this.renderBreadcrumb(container, store);
					break;
				case 'shortcut':
					this.buttons = [this.renderShortcut(container, store)];
					break;
				default:
					this.buttons = [];
			}
			this.setTabbable(this.tabbable);
		}));
	}

	override focus(): void {
		this.buttons[0]?.focus();
	}

	override setTabbable(tabbable: boolean): void {
		this.tabbable = tabbable;
		// Both breadcrumb buttons remain individually reachable with Tab.
		for (const button of this.buttons) button.domNode.tabIndex = tabbable ? 0 : -1;
	}

	private renderShortcut(container: HTMLElement, store: DisposableStore): Button {
		const element = h(container.ownerDocument, 'div', { className: 'ash-project-titlebar' });
		container.append(element);
		store.add(toDisposable(() => element.remove()));
		const button = store.add(new Button(element, {
			...defaultButtonStyles,
			label: '',
			icon: Lxicon.projects,
			onClick: () => this.content.get()?.open(),
		}));
		button.domNode.classList.add('ash-project-titlebar-name');
		store.add(autorun(reader => {
			const content = this.content.read(reader);
			if (content?.kind !== 'shortcut') return;
			if (button.label !== content.name) {
				button.label = content.name;
				button.setTitle(content.name || undefined);
				button.domNode.setAttribute('aria-label', content.name);
			}
			button.hidden = !content.name;
		}));
		return button;
	}

	private renderBreadcrumb(container: HTMLElement, store: DisposableStore): readonly Button[] {
		const document = container.ownerDocument;
		const nav = h(document, 'nav', {
			className: 'ash-projects-breadcrumb ash-project-titlebar',
			attributes: { 'aria-label': localize('projects.breadcrumb', 'Project navigation') },
		});
		container.append(nav);
		store.add(this.contextKeys.createScoped(nav)).createKey('sessionsProjectsFocused', true);
		const readBreadcrumb = (): ProjectBreadcrumbContent | undefined => {
			const content = this.content.get();
			return content?.kind === 'breadcrumb' ? content : undefined;
		};
		const back = store.add(new Button(nav, {
			...defaultButtonStyles,
			label: localize('projects.title', 'Projects'),
			onClick: () => readBreadcrumb()?.open(),
		}));
		const separator = h(document, 'span', {
			className: 'ash-projects-breadcrumb-separator',
			attributes: { 'aria-hidden': 'true' },
		}, '/');
		const title = h(document, 'div', { className: 'ash-projects-breadcrumb-title' });
		nav.append(separator, title);
		const nameButton = store.add(new Button(title, {
			...defaultButtonStyles,
			label: '',
			size: 'small',
			onClick: () => beginRename(),
		}));
		nameButton.domNode.classList.add('ash-project-titlebar-name', 'ash-projects-breadcrumb-name');
		nameButton.domNode.setAttribute('aria-current', 'page');
		let edit: { target: ProjectTitleRenameTarget; originalName: string; saving: boolean; controller: AbortController; } | undefined;
		store.add(toDisposable(() => edit?.controller.abort()));
		const input = renderInlineRenameInput(title, {
			label: localize('projects.projectName', 'Project name'),
			description: localize('projects.renameHint', 'Enter to save, Escape to cancel.'),
			maxLength: 200,
			onAccept: () => { void saveRename(); },
			onCancel: () => { if (!edit?.saving) finishRename(true); },
			onBlur: () => { void saveRename(); },
		}, store);
		const beginRename = (): void => {
			const content = readBreadcrumb();
			if (!content?.rename || content.busy || edit) return;
			edit = { target: content.rename, originalName: nameButton.label, saving: false, controller: new AbortController() };
			showInlineRenameInput(input, edit.originalName);
			nameButton.hidden = true;
		};
		const finishRename = (restoreFocus: boolean): void => {
			if (!edit) return;
			const { controller } = edit;
			edit = undefined;
			controller.abort();
			input.hidden = true;
			nameButton.hidden = !nameButton.label;
			if (restoreFocus) nameButton.focus();
		};
		const saveRename = async (): Promise<void> => {
			const draft = edit;
			const current = readBreadcrumb();
			if (!draft || draft.saving || current?.rename?.id !== draft.target.id || current.busy) return;
			const name = input.value.trim();
			if (!name || name === draft.originalName) {
				finishRename(getActiveElement(document) === input);
				return;
			}
			draft.saving = true;
			input.readOnly = true;
			try {
				const saved = await draft.target.save(name, draft.controller.signal);
				if (edit !== draft || !input.isConnected) return;
				if (saved) {
					finishRename(getActiveElement(document) === input);
					status(localize('projects.renamed', 'Project renamed to {0}.', name));
				} else {
					// Retry against the refreshed revision while preserving the user's text.
					const refreshed = readBreadcrumb()?.rename;
					if (refreshed?.id === draft.target.id) draft.target = refreshed;
					draft.originalName = nameButton.label;
				}
			} catch (error) {
				onUnexpectedError(error);
			} finally {
				if (edit === draft && input.isConnected) {
					draft.saving = false;
					input.readOnly = false;
				}
			}
		};
		store.add(toDisposable(() => nav.remove()));
		store.add(addDisposableListener(nav, 'focusin', event => {
			const from = event.relatedTarget as Node | null;
			if (!nav.contains(from) && !readBreadcrumb()?.editor.contains(from) &&
				this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Projects)) {
				status(localize('projects.helpHint', 'Press Alt+F1 for Projects accessibility help.'));
			}
		}));
		store.add(autorun(reader => {
			const content = this.content.read(reader);
			if (content?.kind !== 'breadcrumb') return;
			const { name, rename, loading, busy, showSeparator, catalogCurrent } = content;
			if (edit && edit.target.id !== rename?.id) finishRename(false);
			const label = rename ? localize('projects.rename', 'Rename project {0}', name) : name;
			if (nameButton.label !== name || nameButton.domNode.getAttribute('aria-label') !== label) {
				nameButton.label = name;
				nameButton.setTitle(label || undefined);
			}
			nameButton.hidden = (!name && !loading) || !!edit;
			nameButton.enabled = !!rename && !busy;
			nameButton.domNode.classList.toggle('ash-projects-placeholder', loading);
			nameButton.domNode.setAttribute('aria-hidden', String(loading));
			nameButton.domNode.setAttribute('aria-label', label);
			separator.hidden = !showSeparator;
			if (catalogCurrent) back.domNode.setAttribute('aria-current', 'page');
			else back.domNode.removeAttribute('aria-current');
		}));
		return [back, nameButton];
	}
}

const projectTitleVisible = new RawContextKey<boolean>('sessions.projectTitleVisible', false);
const openProjectsAction = 'sessions.open.projects';

MenusRegistry.appendMenuItem(Menus.TitleBarPageContent, {
	command: { id: openProjectsAction, title: localize('projects.title', 'Projects') },
	when: projectTitleVisible.isEqualTo(true),
});

/** Registers the project title presentation for this window's title bar menu. */
export class ProjectTitleBarContribution extends Disposable {
	static readonly ID = 'sessions.contrib.projectTitleBar';

	constructor(
		@IActionViewItemService presentations: IActionViewItemService,
		@IEditorPart editorPart: IEditorPart,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		// A modal editor does not replace the product page under it.
		const activePane = observableFromEvent(this, editorPart.onDidChangeEditors, () => editorPart.activeGroup.activePane);
		const content = derived(reader => {
			const pane = activePane.read(reader);
			return pane instanceof ProjectsEditorPane || pane instanceof ReplyChatEditor
				? pane.projectTitleBarContent.read(reader) : undefined;
		});
		const visible = projectTitleVisible.bindTo(contextKeys);
		this._register(toDisposable(() => visible.reset()));
		this._register(presentations.register(Menus.TitleBarPageContent, openProjectsAction, (action, options, instantiation) =>
			instantiation.createInstance(ProjectTitleBarWidget, action, options, content)));
		this._register(autorun(reader => visible.set(!!content.read(reader))));
	}
}
