import './media/gettingStarted.css';
import './gettingStartedColors.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

/** A host callback invoked by one welcome-page action. */
type GettingStartedAction = () => void | Promise<void>;

/** A recent project shown by the Welcome page. */
export interface IGettingStartedProject {
	readonly name: string;
	readonly path: string;
	readonly onOpen?: GettingStartedAction;
	readonly onRemove?: GettingStartedAction;
}

/** Actions and data used by the Welcome page. */
interface GettingStartedOptions {
	readonly actions?: {
		readonly openFolder?: GettingStartedAction;
		readonly cloneRepository?: GettingStartedAction;
		readonly connectViaSsh?: GettingStartedAction;
		readonly connectGitHub?: GettingStartedAction;
	};
	readonly recentProjects?: readonly IGettingStartedProject[];
}

interface WelcomeCardOptions {
	readonly label: string;
	readonly labelKey: string;
	readonly icon: Parameters<typeof appendIcon>[0];
	readonly action: GettingStartedAction | undefined;
	readonly variant?: 'default' | 'featured';
}

/** Renders the Welcome editor content. */
export class GettingStarted extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly recentDisposables = this._register(new DisposableStore());
	private readonly recentSection: HTMLElement;
	private cloneAction: GettingStartedAction | undefined;
	private cloneCard: HTMLButtonElement | undefined;
	private recentProjects: readonly IGettingStartedProject[];

	constructor(container: HTMLElement, options: GettingStartedOptions = {}) {
		super();
		const ownerDocument = container.ownerDocument;
		this.recentProjects = options.recentProjects ?? [];
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-getting-started';
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('role', 'region');
		this.domNode.setAttribute('aria-label', localize('gettingStarted.title', 'Welcome'));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));

		const scroll = h(ownerDocument, 'div');
		scroll.className = 'ash-getting-started-scroll';
		const content = h(ownerDocument, 'div');
		content.className = 'ash-getting-started-content';
		scroll.append(content);
		this.domNode.append(scroll);

		content.append(this.createBrand(ownerDocument));
		content.append(this.createCards(ownerDocument, options.actions));
		this.recentSection = this.createRecentProjects(ownerDocument);
		content.append(this.recentSection);
	}

	public setRecentProjects(projects: readonly IGettingStartedProject[]): void {
		// Rebuilding the list must not strand keyboard focus on a removed action.
		const items = [...this.recentSection.querySelectorAll<HTMLElement>('.ash-getting-started-recent-item')];
		const activeElement = this.domNode.ownerDocument.activeElement;
		const focusedIndex = items.findIndex(item => item.contains(activeElement));
		const focusedAction = items[focusedIndex]
			?.querySelector('.ash-getting-started-recent-actions')
			?.contains(activeElement);
		const focusedPath = this.recentProjects[focusedIndex]?.path;
		this.recentProjects = projects;
		this.renderRecentProjects(this.recentSection);
		if (focusedIndex !== -1) {
			const nextItems = this.recentSection.querySelectorAll<HTMLElement>('.ash-getting-started-recent-item');
			const retainedIndex = projects.findIndex(project => project.path === focusedPath);
			const nextItem =
				nextItems[retainedIndex === -1 ? Math.min(focusedIndex, nextItems.length - 1) : retainedIndex];
			const target =
				retainedIndex !== -1 && focusedAction
					? nextItem?.querySelector<HTMLElement>('.ash-getting-started-recent-actions button')
					: nextItem?.querySelector<HTMLElement>('button');
			const fallback = this.domNode.querySelector<HTMLButtonElement>('.ash-getting-started-card:not(:disabled)');
			(target ?? fallback ?? this.domNode).focus();
		}
	}

	private createBrand(ownerDocument: Document): HTMLElement {
		const brand = h(ownerDocument, 'header');
		brand.className = 'ash-getting-started-brand';

		const mark = h(ownerDocument, 'div');
		mark.className = 'ash-getting-started-mark';
		mark.setAttribute('aria-hidden', 'true');
		appendIcon(Lxicon.ashMark, mark);

		const name = h(ownerDocument, 'div');
		name.className = 'ash-getting-started-name';
		name.textContent = 'ASH';
		brand.append(mark, name);

		const wrapper = h(ownerDocument, 'div');
		wrapper.className = 'ash-getting-started-intro';
		wrapper.append(brand);
		return wrapper;
	}

	private createCards(ownerDocument: Document, actions: GettingStartedOptions['actions']): HTMLElement {
		const cards = h(ownerDocument, 'div');
		cards.className = 'ash-getting-started-cards';
		const cardOptions: readonly WelcomeCardOptions[] = [
			{
				label: localize('editorWelcome.openFolder', 'Open folder'),
				labelKey: 'editorWelcome.openFolder',
				icon: Lxicon.folders,
				action: actions?.openFolder,
			},
			{
				label: localize('editorWelcome.cloneRepo', 'Clone repo'),
				labelKey: 'editorWelcome.cloneRepo',
				icon: Lxicon.gitBranch,
				action: actions?.cloneRepository,
			},
			{
				label: localize('editorWelcome.connectViaSsh', 'Connect via SSH'),
				labelKey: 'editorWelcome.connectViaSsh',
				icon: Lxicon.remote,
				action: actions?.connectViaSsh,
			},
			{
				label: localize('editorWelcome.connectGitHub', 'Connect GitHub'),
				labelKey: 'editorWelcome.connectGitHub',
				icon: Lxicon.github,
				action: actions?.connectGitHub,
				variant: 'featured',
			},
		];
		const renderedCards = cardOptions.map(card => this.createCard(ownerDocument, card));
		cards.append(...renderedCards);
		return cards;
	}

	private createCard(ownerDocument: Document, options: WelcomeCardOptions): HTMLButtonElement {
		const card = h(ownerDocument, 'button');
		card.type = 'button';
		card.className = `ash-getting-started-card${options.variant === 'featured' ? ' featured' : ''}`;
		if (options.labelKey === 'editorWelcome.cloneRepo') {
			this.cloneCard = card;
			this.setCloneRepositoryAction(options.action);
			this._register(
				addDisposableListener(card, 'click', () => {
					if (this.cloneAction) {
						this.run(this.cloneAction);
					}
				}),
			);
		} else if (!options.action) {
			card.disabled = true;
			card.classList.add('is-disabled');
		} else {
			this._register(addDisposableListener(card, 'click', () => this.run(options.action)));
		}

		const icon = h(ownerDocument, 'span');
		icon.className = 'ash-getting-started-card-icon';
		icon.setAttribute('aria-hidden', 'true');
		appendIcon(options.icon, icon);

		const label = h(ownerDocument, 'span');
		label.className = 'ash-getting-started-card-label';
		card.append(icon, label);
		this.updateCardLabel(card, options);
		return card;
	}

	public setCloneRepositoryAction(action: GettingStartedAction | undefined): void {
		this.cloneAction = action;
		if (this.cloneCard) {
			this.cloneCard.disabled = action === undefined;
			this.cloneCard.classList.toggle('is-disabled', action === undefined);
		}
	}

	private updateCardLabel(card: HTMLButtonElement, options: WelcomeCardOptions): void {
		const label = localize(options.labelKey, options.label);
		card.querySelector<HTMLElement>('.ash-getting-started-card-label')!.textContent = label;
		if (card.disabled) card.title = localize('editorWelcome.actionUnavailable', '{0} is not available yet', label);
	}

	private createRecentProjects(ownerDocument: Document): HTMLElement {
		const section = h(ownerDocument, 'section');
		section.className = 'ash-getting-started-recent';
		this.renderRecentProjects(section);
		return section;
	}

	private renderRecentProjects(section: HTMLElement): void {
		this.recentDisposables.clear();
		section.replaceChildren();
		section.hidden = this.recentProjects.length === 0;
		if (section.hidden) return;

		const ownerDocument = section.ownerDocument;
		const title = h(ownerDocument, 'h2');
		title.textContent = localize('gettingStarted.recents', 'Recents');

		const list = h(ownerDocument, 'div');
		list.className = 'ash-getting-started-recent-list';
		for (const project of this.recentProjects) {
			list.append(this.createRecentProject(ownerDocument, project));
		}
		section.append(title, list);
	}

	private createRecentProject(ownerDocument: Document, project: IGettingStartedProject): HTMLElement {
		const item = h(ownerDocument, 'div');
		item.className = 'ash-getting-started-recent-item';
		const content = h(ownerDocument, project.onOpen ? 'button' : 'div');
		content.className = 'ash-getting-started-recent-content';
		if (content.tagName === 'BUTTON') {
			(content as HTMLButtonElement).type = 'button';
		}
		if (project.onOpen) {
			const onOpen = project.onOpen;
			this.recentDisposables.add(addDisposableListener(content, 'click', () => this.run(onOpen)));
		}
		this.appendRecentProjectContent(ownerDocument, content, project);
		item.append(content);
		if (project.onRemove) {
			const actions = h(ownerDocument, 'div');
			actions.className = 'ash-getting-started-recent-actions';
			item.append(actions);
			const onRemove = project.onRemove;
			this.recentDisposables.add(
				new ActionBar(actions, {
					ariaLabel: localize('gettingStarted.recentActions', 'Actions for {0}', project.name),
					actionViewItemProvider: action =>
						new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
					actions: [
						{
							id: 'gettingStarted.removeRecent',
							label: localize('gettingStarted.removeRecent', 'Remove {0} from Recents', project.name),
							tooltip: localize('gettingStarted.removeRecentTooltip', 'Remove'),
							icon: Lxicon.close,
							enabled: true,
							run: () => this.run(onRemove),
						},
					],
				}),
			);
		}
		return item;
	}

	private appendRecentProjectContent(
		ownerDocument: Document,
		item: HTMLElement,
		project: IGettingStartedProject,
	): void {
		const name = h(ownerDocument, 'span');
		name.className = 'ash-getting-started-recent-name';
		name.textContent = project.name;
		this.recentDisposables.add(getHoverDelegate().setupDelayedHover(name, () => ({ content: project.name })));
		const path = h(ownerDocument, 'span');
		path.className = 'ash-getting-started-recent-path';
		path.textContent = project.path;
		this.recentDisposables.add(getHoverDelegate().setupDelayedHover(path, () => ({ content: project.path })));
		item.append(name, path);
	}

	private run(action: GettingStartedAction | undefined): void {
		if (!action) return;
		try {
			void Promise.resolve(action()).catch((error: unknown) => {
				console.error('Welcome action failed', error);
			});
		} catch (error) {
			console.error('Welcome action failed', error);
		}
	}
}
