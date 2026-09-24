import "./media/editorWelcome.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { appendIcon } from "../../../../base/browser/ui/icon/icon.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";

const MAX_VISIBLE_RECENT_PROJECTS = 5;

/** A host callback invoked by one welcome-page action. */
export type EditorWelcomeAction = () => void | Promise<void>;

/** A recent project shown by the editor welcome page. */
export interface IEditorWelcomeProject {
	readonly name: string;
	readonly path: string;
	readonly onOpen?: EditorWelcomeAction;
}

/** Host-owned actions and data projected into the editor welcome page. */
export interface EditorWelcomeOptions {
	readonly productName?: string;
	readonly actions?: {
		readonly openFolder?: EditorWelcomeAction;
		readonly cloneRepository?: EditorWelcomeAction;
		readonly connectViaSsh?: EditorWelcomeAction;
		readonly connectGitHub?: EditorWelcomeAction;
	};
	readonly recentProjects?: readonly IEditorWelcomeProject[];
	readonly shortcuts?: HTMLElement;
}

interface WelcomeCardOptions {
	readonly label: string;
	readonly icon: Parameters<typeof appendIcon>[0];
	readonly action: EditorWelcomeAction | undefined;
	readonly variant?: "default" | "featured";
	readonly external?: boolean;
}

/** Renders the empty-editor landing page used when no document is open. */
export class EditorWelcome extends Disposable {
	readonly element: HTMLElement;
	private readonly recentDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly recentSection: HTMLElement;
	private recentProjects: readonly IEditorWelcomeProject[];
	private showAllRecentProjects = false;

	constructor(
		container: HTMLElement,
		options: EditorWelcomeOptions = {},
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.recentProjects = options.recentProjects ?? [];
		this.element = h(ownerDocument, "section");
		// Keep the old watermark class as a compatibility hook for empty-editor hosts.
		this.element.className = "ash-editor-group-welcome ash-editor-group-watermark";
		this.element.setAttribute("role", "region");
		this.element.setAttribute("aria-label", "Welcome");
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const scroll = h(ownerDocument, "div");
		scroll.className = "ash-editor-group-welcome-scroll";
		const content = h(ownerDocument, "div");
		content.className = "ash-editor-group-welcome-content";
		scroll.append(content);
		this.element.append(scroll);

		content.append(this.createBrand(ownerDocument, options));
		content.append(this.createCards(ownerDocument, options.actions));
		this.recentSection = this.createRecentProjects(ownerDocument);
		content.append(this.recentSection);
		if (options.shortcuts) content.append(options.shortcuts);
	}

	setRecentProjects(projects: readonly IEditorWelcomeProject[]): void {
		this.recentProjects = projects;
		this.showAllRecentProjects = false;
		this.renderRecentProjects(this.recentSection);
	}

	private createBrand(
		ownerDocument: Document,
		options: EditorWelcomeOptions,
	): HTMLElement {
		const brand = h(ownerDocument, "header");
		brand.className = "ash-editor-group-welcome-brand";

		const mark = h(ownerDocument, "div");
		mark.className = "ash-editor-group-welcome-mark";
		mark.setAttribute("aria-hidden", "true");
		appendIcon(lxiconsLibrary.model, mark);

		const name = h(ownerDocument, "div");
		name.className = "ash-editor-group-welcome-name";
		name.textContent = (options.productName ?? "Ash").toUpperCase();
		brand.append(mark, name);

		const plan = h(ownerDocument, "div");
		plan.className = "ash-editor-group-welcome-plan";
		plan.append(
			this.createText(ownerDocument, "Local workspace"),
			this.createText(ownerDocument, "·", "ash-editor-group-welcome-plan-separator"),
			this.createText(ownerDocument, "Ready to build"),
		);

		const wrapper = h(ownerDocument, "div");
		wrapper.className = "ash-editor-group-welcome-intro";
		wrapper.append(brand, plan);
		return wrapper;
	}

	private createCards(
		ownerDocument: Document,
		actions: EditorWelcomeOptions["actions"],
	): HTMLElement {
		const cards = h(ownerDocument, "div");
		cards.className = "ash-editor-group-welcome-cards";
		const cardOptions: readonly WelcomeCardOptions[] = [
			{
				label: "Open folder",
				icon: lxiconsLibrary.folders,
				action: actions?.openFolder,
			},
			{
				label: "Clone repo",
				icon: lxiconsLibrary.gitBranch,
				action: actions?.cloneRepository,
			},
			{
				label: "Connect via SSH",
				icon: lxiconsLibrary.remote,
				action: actions?.connectViaSsh,
			},
			{
				label: "Connect GitHub",
				icon: lxiconsLibrary.github,
				action: actions?.connectGitHub,
				variant: "featured",
				external: true,
			},
		];
		for (const card of cardOptions) cards.append(this.createCard(ownerDocument, card));
		return cards;
	}

	private createCard(
		ownerDocument: Document,
		options: WelcomeCardOptions,
	): HTMLButtonElement {
		const card = h(ownerDocument, "button");
		card.type = "button";
		card.className = `ash-editor-group-welcome-card${options.variant === "featured" ? " featured" : ""}`;
		if (!options.action) {
			card.disabled = true;
			card.classList.add("is-disabled");
			card.title = `${options.label} is not available yet`;
		} else {
			this._register(addDisposableListener(card, "click", () => this.run(options.action)));
		}

		const icon = h(ownerDocument, "span");
		icon.className = "ash-editor-group-welcome-card-icon";
		icon.setAttribute("aria-hidden", "true");
		appendIcon(options.icon, icon);

		const label = h(ownerDocument, "span");
		label.className = "ash-editor-group-welcome-card-label";
		label.textContent = options.label;
		card.append(icon, label);
		if (options.external) {
			const arrow = h(ownerDocument, "span");
			arrow.className = "ash-editor-group-welcome-card-arrow";
			arrow.setAttribute("aria-hidden", "true");
			arrow.textContent = "↗";
			card.append(arrow);
		}
		return card;
	}

	private createRecentProjects(ownerDocument: Document): HTMLElement {
		const section = h(ownerDocument, "section");
		section.className = "ash-editor-group-welcome-recent";
		this.renderRecentProjects(section);
		return section;
	}

	private renderRecentProjects(section: HTMLElement): void {
		const ownerDocument = section.ownerDocument;
		const heading = h(ownerDocument, "div");
		heading.className = "ash-editor-group-welcome-section-heading";
		const title = h(ownerDocument, "h2");
		title.textContent = "Recent projects";
		heading.append(title);
		const projects = this.recentProjects;
		const viewAll = h(ownerDocument, "button");
		viewAll.type = "button";
		viewAll.className = "ash-editor-group-welcome-view-all";
		viewAll.disabled = projects.length <= MAX_VISIBLE_RECENT_PROJECTS;
		viewAll.setAttribute("aria-expanded", String(this.showAllRecentProjects));
		viewAll.textContent = this.showAllRecentProjects
			? "Show less"
			: `View all (${projects.length})`;
		if (!viewAll.disabled) {
			this.recentDisposables.value = new DisposableStore();
			this.recentDisposables.value?.add(addDisposableListener(viewAll, "click", () => {
				this.showAllRecentProjects = !this.showAllRecentProjects;
				this.renderRecentProjects(section);
			}));
		} else {
			this.recentDisposables.value = new DisposableStore();
		}
		heading.append(viewAll);
		section.replaceChildren(heading);

		if (projects.length === 0) {
			const empty = h(ownerDocument, "p");
			empty.className = "ash-editor-group-welcome-recent-empty";
			empty.textContent = "Your recent projects will appear here.";
			section.append(empty);
			return;
		}

		const list = h(ownerDocument, "div");
		list.className = "ash-editor-group-welcome-recent-list";
		const visibleProjects = this.showAllRecentProjects
			? projects
			: projects.slice(0, MAX_VISIBLE_RECENT_PROJECTS);
		const disposables = this.recentDisposables.value;
		for (const project of visibleProjects) {
			list.append(this.createRecentProject(ownerDocument, project, disposables));
		}
		section.append(list);
	}

	private createRecentProject(
		ownerDocument: Document,
		project: IEditorWelcomeProject,
		disposables: DisposableStore | undefined,
	): HTMLElement {
		if (project.onOpen) {
			const item = h(ownerDocument, "button");
			item.type = "button";
			item.className = "ash-editor-group-welcome-recent-item";
			const onOpen = project.onOpen;
			disposables?.add(addDisposableListener(item, "click", () => this.run(onOpen)));
			this.appendRecentProjectContent(ownerDocument, item, project);
			return item;
		}
		const item = h(ownerDocument, "div");
		item.className = "ash-editor-group-welcome-recent-item";
		this.appendRecentProjectContent(ownerDocument, item, project);
		return item;
	}

	private appendRecentProjectContent(
		ownerDocument: Document,
		item: HTMLElement,
		project: IEditorWelcomeProject,
	): void {
		const name = h(ownerDocument, "span");
		name.className = "ash-editor-group-welcome-recent-name";
		name.textContent = project.name;
		const path = h(ownerDocument, "span");
		path.className = "ash-editor-group-welcome-recent-path";
		path.textContent = project.path;
		item.append(name, path);
	}

	private createText(
		ownerDocument: Document,
		text: string,
		className = "ash-editor-group-welcome-plan-item",
	): HTMLSpanElement {
		const element = h(ownerDocument, "span");
		element.className = className;
		element.textContent = text;
		return element;
	}

	private run(action: EditorWelcomeAction | undefined): void {
		if (!action) return;
		try {
			void Promise.resolve(action()).catch((error: unknown) => {
				console.error("Editor welcome action failed", error);
			});
		} catch (error) {
			console.error("Editor welcome action failed", error);
		}
	}
}
