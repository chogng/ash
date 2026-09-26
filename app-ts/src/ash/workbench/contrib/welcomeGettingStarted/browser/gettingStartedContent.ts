import './media/gettingStarted.css';
import './gettingStartedColors.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../nls.js';

/** A host callback invoked by one welcome-page action. */
type GettingStartedAction = () => void | Promise<void>;

/** A recent project shown by the Welcome page. */
export interface IGettingStartedProject {
	readonly name: string;
	readonly path: string;
	readonly onOpen?: GettingStartedAction;
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
	readonly external?: boolean;
}

/** Renders the Welcome editor content. */
export class GettingStarted extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly recentDisposables = this._register(new DisposableStore());
	private readonly recentSection: HTMLElement;
	private recentProjects: readonly IGettingStartedProject[];

	constructor(
		container: HTMLElement,
		options: GettingStartedOptions = {},
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.recentProjects = options.recentProjects ?? [];
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-getting-started';
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
		this._register(onDidChangeNls(() => {
			this.domNode.setAttribute('aria-label', localize('gettingStarted.title', 'Welcome'));
			this.renderRecentProjects(this.recentSection);
		}));
	}

	public setRecentProjects(projects: readonly IGettingStartedProject[]): void {
		this.recentProjects = projects;
		this.renderRecentProjects(this.recentSection);
	}

	private createBrand(ownerDocument: Document): HTMLElement {
		const brand = h(ownerDocument, 'header');
		brand.className = 'ash-getting-started-brand';

		const mark = h(ownerDocument, 'div');
		mark.className = 'ash-getting-started-mark';
		mark.setAttribute('aria-hidden', 'true');

		const name = h(ownerDocument, 'div');
		name.className = 'ash-getting-started-name';
		name.textContent = 'ASH';
		brand.append(mark, name);

		const wrapper = h(ownerDocument, 'div');
		wrapper.className = 'ash-getting-started-intro';
		wrapper.append(brand);
		return wrapper;
	}

	private createCards(
		ownerDocument: Document,
		actions: GettingStartedOptions['actions'],
	): HTMLElement {
		const cards = h(ownerDocument, 'div');
		cards.className = 'ash-getting-started-cards';
		const cardOptions: readonly WelcomeCardOptions[] = [
			{
				label: 'Open folder',
				labelKey: 'editorWelcome.openFolder',
				icon: Lxicon.folders,
				action: actions?.openFolder,
			},
			{
				label: 'Clone repo',
				labelKey: 'editorWelcome.cloneRepo',
				icon: Lxicon.gitBranch,
				action: actions?.cloneRepository,
			},
			{
				label: 'Connect via SSH',
				labelKey: 'editorWelcome.connectViaSsh',
				icon: Lxicon.remote,
				action: actions?.connectViaSsh,
			},
			{
				label: 'Connect GitHub',
				labelKey: 'editorWelcome.connectGitHub',
				icon: Lxicon.github,
				action: actions?.connectGitHub,
				variant: 'featured',
				external: true,
			},
		];
		const renderedCards = cardOptions.map(card => this.createCard(ownerDocument, card));
		cards.append(...renderedCards);
		this._register(onDidChangeNls(() => {
			for (let index = 0; index < cardOptions.length; index += 1) {
				this.updateCardLabel(renderedCards[index], cardOptions[index]);
			}
		}));
		return cards;
	}

	private createCard(
		ownerDocument: Document,
		options: WelcomeCardOptions,
	): HTMLButtonElement {
		const card = h(ownerDocument, 'button');
		card.type = 'button';
		card.className = `ash-getting-started-card${options.variant === 'featured' ? ' featured' : ''}`;
		if (!options.action) {
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
		if (options.external) {
			const arrow = h(ownerDocument, 'span');
			arrow.className = 'ash-getting-started-card-arrow';
			arrow.setAttribute('aria-hidden', 'true');
			arrow.textContent = '↗';
			card.append(arrow);
		}
		this.updateCardLabel(card, options);
		return card;
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
		title.textContent = localize('gettingStarted.recentProjects', 'Recent projects');

		const list = h(ownerDocument, 'div');
		list.className = 'ash-getting-started-recent-list';
		for (const project of this.recentProjects) {
			list.append(this.createRecentProject(ownerDocument, project));
		}
		section.append(title, list);
	}

	private createRecentProject(
		ownerDocument: Document,
		project: IGettingStartedProject,
	): HTMLElement {
		if (project.onOpen) {
			const item = h(ownerDocument, 'button');
			item.type = 'button';
			item.className = 'ash-getting-started-recent-item';
			const onOpen = project.onOpen;
			this.recentDisposables.add(addDisposableListener(item, 'click', () => this.run(onOpen)));
			this.appendRecentProjectContent(ownerDocument, item, project);
			return item;
		}
		const item = h(ownerDocument, 'div');
		item.className = 'ash-getting-started-recent-item';
		this.appendRecentProjectContent(ownerDocument, item, project);
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
		name.title = project.name;
		const path = h(ownerDocument, 'span');
		path.className = 'ash-getting-started-recent-path';
		path.textContent = project.path;
		path.title = project.path;
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
