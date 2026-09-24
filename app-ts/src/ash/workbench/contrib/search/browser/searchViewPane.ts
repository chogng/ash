import { toDisposable } from "../../../../base/common/lifecycle.js";
import { addDisposableListener, h, text as createText } from "../../../../base/browser/dom.js";
import { Checkbox } from "../../../../base/browser/ui/toggle/toggle.js";
import type { IContentSearchQuery, IContentSearchService, ContentSearchMatch, ContentSearchMatchRange } from "../../../../platform/search/common/search.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry, type IRegisteredConfiguration } from "../../../../platform/configuration/common/configurationRegistry.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { ContentSearchConfiguration } from "../common/searchConfiguration.js";

interface SearchFileGroup {
	readonly matches: HTMLUListElement;
	readonly count: HTMLSpanElement;
	resultCount: number;
}

/** Workspace content-search form and incrementally populated result tree. */
export class SearchViewPane extends ViewPane {
	private readonly searchService: IContentSearchService;
	private readonly queryInput: HTMLInputElement;
	private readonly caseSensitiveInput: HTMLInputElement;
	private readonly regexInput: HTMLInputElement;
	private readonly includeInput: HTMLInputElement;
	private readonly excludeInput: HTMLInputElement;
	private readonly submitButton: HTMLButtonElement;
	private readonly statusElement: HTMLDivElement;
	private readonly resultsElement: HTMLUListElement;
	private readonly groups = new Map<string, SearchFileGroup>();
	private searchController: AbortController | undefined;
	private searchRevision = 0;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		searchService: IContentSearchService,
		private readonly configurationService?: IConfigurationService,
	) {
		super(container, options);
		this.searchService = searchService;
		this.contentElement.classList.add("ash-search");
		const document = container.ownerDocument;
		const form = h(document, "form");
		form.className = "ash-search-form";
		this.queryInput = input(document, {
			className: "ash-search-query",
			placeholder: "Search",
			ariaLabel: "Search workspace",
		});
		this.submitButton = h(document, "button");
		this.submitButton.type = "submit";
		this.submitButton.className = "ash-search-submit";
		this.submitButton.textContent = "Search";
		const toggles = h(document, "div");
		toggles.className = "ash-search-toggles";
		const caseSensitive = this._register(checkbox(
			document,
			toggles,
			"Match Case",
		));
		this.caseSensitiveInput = caseSensitive.input;
		const regex = this._register(checkbox(document, toggles, "Use Regex"));
		this.regexInput = regex.input;
		const filters = h(document, "div");
		filters.className = "ash-search-filters";
		this.includeInput = input(document, {
			className: "ash-search-filter",
			placeholder: "files to include (for example src/**)",
			ariaLabel: "Files to include",
		});
		this.excludeInput = input(document, {
			className: "ash-search-filter",
			placeholder: "files to exclude",
			ariaLabel: "Files to exclude",
		});
		filters.append(this.includeInput, this.excludeInput);
		this.applyConfiguration();
		form.append(
			this.queryInput,
			this.submitButton,
			toggles,
			filters,
		);
		this.statusElement = h(document, "div");
		this.statusElement.className = "ash-search-status";
		this.statusElement.setAttribute("role", "status");
		this.statusElement.setAttribute("aria-live", "polite");
		this.statusElement.textContent = "Type a query and press Enter.";
		this.resultsElement = h(document, "ul");
		this.resultsElement.className = "ash-search-results";
		this.resultsElement.setAttribute("role", "tree");
		this.contentElement.append(
			form,
			this.statusElement,
			this.resultsElement,
		);
		this._register(addDisposableListener(form, "submit", (event) => {
			event.preventDefault();
			void this.startSearch();
		}));
		if (configurationService) this._register(configurationService.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration(ContentSearchConfiguration.matchCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.smartCase) ||
				event.affectsConfiguration(ContentSearchConfiguration.regularExpression) ||
				event.affectsConfiguration(ContentSearchConfiguration.includePatterns) ||
				event.affectsConfiguration(ContentSearchConfiguration.excludePatterns)
			) this.applyConfiguration();
		}));
		this._register(toDisposable(() => {
			this.searchController?.abort();
			this.groups.clear();
		}));
	}

	private async startSearch(): Promise<void> {
		const text = this.queryInput.value.trim();
		if (!text) {
			this.statusElement.textContent = "Enter text to search.";
			this.queryInput.focus();
			return;
		}
		this.searchController?.abort();
		const AbortControllerConstructor =
			this.element.ownerDocument.defaultView?.AbortController ??
			AbortController;
		const controller = new AbortControllerConstructor();
		this.searchController = controller;
		const revision = ++this.searchRevision;
		this.groups.clear();
		this.resultsElement.replaceChildren();
		this.submitButton.disabled = true;
		this.statusElement.textContent = "Searching workspace…";
		try {
			const complete = await this.searchService.search(
				this.query(text),
				{
					signal: controller.signal,
					onProgress: (matches) => {
						if (
							this.isDisposed ||
							revision !== this.searchRevision
						) return;
						this.appendMatches(matches);
						this.statusElement.textContent =
							`${resultCount(this.groups)} results…`;
					},
				},
			);
			if (this.isDisposed || revision !== this.searchRevision) return;
			if (complete.error) {
				this.statusElement.textContent = complete.error;
			} else if (complete.resultCount === 0) {
				this.statusElement.textContent = "No results found.";
			} else {
				this.statusElement.textContent =
					`${complete.resultCount} results` +
					(complete.limitHit ? " (result limit reached)" : "");
			}
		} catch (error) {
			if (
				this.isDisposed ||
				revision !== this.searchRevision ||
				isAbortError(error)
			) return;
			this.statusElement.textContent = error instanceof Error
				? error.message
				: "Workspace search failed.";
		} finally {
			if (!this.isDisposed && revision === this.searchRevision) {
				this.submitButton.disabled = false;
				this.searchController = undefined;
			}
		}
	}

	private query(text: string): IContentSearchQuery {
		return {
			text,
			patternKind: this.regexInput.checked ? "regex" : "literal",
			caseSensitivity: this.caseSensitiveInput.checked
				? "sensitive"
				: this.configurationValue(ContentSearchConfiguration.smartCase) ? "smart" : "insensitive",
			includePatterns: patterns(this.includeInput.value),
			excludePatterns: patterns(this.excludeInput.value),
			maxResults: this.configurationValue(ContentSearchConfiguration.maxResults),
		};
	}

	private applyConfiguration(): void {
		this.caseSensitiveInput.checked = this.configurationValue(ContentSearchConfiguration.matchCase);
		this.regexInput.checked = this.configurationValue(ContentSearchConfiguration.regularExpression);
		this.includeInput.value = this.configurationValue(ContentSearchConfiguration.includePatterns);
		this.excludeInput.value = this.configurationValue(ContentSearchConfiguration.excludePatterns);
	}

	private configurationValue<T>(key: string): T {
		const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(key) as IRegisteredConfiguration<T> | undefined;
		if (!configuration) throw new RangeError(`Unknown configuration: ${key}`);
		return this.configurationService?.getValue<T>(key) ?? configuration.defaultValue;
	}

	private appendMatches(matches: readonly ContentSearchMatch[]): void {
		const document = this.element.ownerDocument;
		for (const match of matches) {
			const groupId = `${match.dirId ?? ""}\0${match.path}`;
			let group = this.groups.get(groupId);
			if (!group) {
				const item = h(document, "li");
				item.className = "ash-search-file";
				item.setAttribute("role", "treeitem");
				item.setAttribute("aria-expanded", "true");
				const heading = h(document, "div");
				heading.className = "ash-search-file-heading";
				const path = h(document, "span");
				path.className = "ash-search-file-path";
				path.textContent = match.dirName
					? `${match.dirName} • ${match.path}`
					: match.path;
				const count = h(document, "span");
				count.className = "ash-search-file-count";
				const resultList = h(document, "ul");
				resultList.className = "ash-search-file-matches";
				resultList.setAttribute("role", "group");
				heading.append(path, count);
				item.append(heading, resultList);
				this.resultsElement.append(item);
				group = {
					matches: resultList,
					count,
					resultCount: 0,
				};
				this.groups.set(groupId, group);
			}
			group.resultCount += 1;
			group.count.textContent = String(group.resultCount);
			group.matches.append(renderMatch(document, match));
		}
	}
}

function input(
	document: Document,
	options: {
		readonly className: string;
		readonly placeholder: string;
		readonly ariaLabel: string;
	},
): HTMLInputElement {
	const element = h(document, "input");
	element.type = "text";
	element.className = options.className;
	element.placeholder = options.placeholder;
	element.setAttribute("aria-label", options.ariaLabel);
	element.autocomplete = "off";
	element.spellcheck = false;
	return element;
}

function checkbox(
	document: Document,
	parent: HTMLElement,
	text: string,
): Checkbox {
	const control = new Checkbox(parent, {
		label: text,
	});
	control.element.classList.add("ash-search-toggle");
	return control;
}

function patterns(value: string): readonly string[] {
	return value
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0);
}

function renderMatch(
	document: Document,
	match: ContentSearchMatch,
): HTMLLIElement {
	const item = h(document, "li");
	item.className = "ash-search-match";
	item.setAttribute("role", "treeitem");
	const line = h(document, "span");
	line.className = "ash-search-line-number";
	line.textContent = String(match.lineNumber);
	const preview = h(document, "code");
	preview.className = "ash-search-preview";
	appendHighlightedPreview(
		document,
		preview,
		match.preview,
		match.ranges,
	);
	item.append(line, preview);
	return item;
}

function appendHighlightedPreview(
	document: Document,
	container: HTMLElement,
	text: string,
	ranges: readonly ContentSearchMatchRange[],
): void {
	let offset = 0;
	for (const range of normalizedRanges(ranges, text.length)) {
		if (range.start > offset) {
			container.append(createText(document, text.slice(offset, range.start)));
		}
		const mark = h(document, "mark");
		mark.textContent = text.slice(range.start, range.end);
		container.append(mark);
		offset = range.end;
	}
	if (offset < text.length) {
		container.append(createText(document, text.slice(offset)));
	}
}

function normalizedRanges(
	ranges: readonly ContentSearchMatchRange[],
	length: number,
): readonly ContentSearchMatchRange[] {
	const normalized: ContentSearchMatchRange[] = [];
	for (const range of [...ranges].sort((left, right) =>
		left.start - right.start || left.end - right.end
	)) {
		const start = Math.max(0, Math.min(length, range.start));
		const end = Math.max(start, Math.min(length, range.end));
		const previous = normalized.at(-1);
		if (previous && start <= previous.end) {
			previous.end = Math.max(previous.end, end);
		} else if (start !== end) {
			normalized.push({ start, end });
		}
	}
	return normalized;
}

function resultCount(groups: ReadonlyMap<string, SearchFileGroup>): number {
	let count = 0;
	for (const group of groups.values()) count += group.resultCount;
	return count;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
