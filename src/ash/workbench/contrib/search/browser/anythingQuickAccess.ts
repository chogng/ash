import {
	PickerQuickAccessProvider,
	type IPickerQuickAccessItem,
	type FastAndSlowPicks,
	type Picks,
} from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { match } from '../../../../base/common/glob.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { AnythingQuickAccessProviderRunOptions } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { untildify } from '../../../../base/common/labels.js';
import { Schemas } from '../../../../base/common/network.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContentSearchConfiguration } from '../common/searchConfiguration.js';

export interface IAnythingQuickPickItem extends IPickerQuickAccessItem {
	readonly resource: URI;
	readonly kind: FileKind;
}

/** Discovers resources through the search owner; callers may accept them as attachments instead of opening editors. */
export class AnythingQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	public static readonly PREFIX = '';

	constructor(
		@ISearchService private readonly search: ISearchService,
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IHistoryService private readonly history: IHistoryService,
		@INotificationService private readonly notifications: INotificationService,
		@IPathService private readonly paths: IPathService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(AnythingQuickAccessProvider.PREFIX, { canAcceptInBackground: true });
	}

	protected override _getPicks(
		query: string,
		_resources: DisposableStore,
		token: CancellationToken,
		options: AnythingQuickAccessProviderRunOptions = {},
	): Picks<IPickerQuickAccessItem> | FastAndSlowPicks<IPickerQuickAccessItem> {
		const itemFor = (resource: URI, kind = FileKind.File): IAnythingQuickPickItem => ({
			label: basename(resource) || resource.path,
			description: dirname(resource).path,
			iconClass: ThemeIcon.asClassName(kind === FileKind.Directory ? Lxicon.folders : Lxicon.file),
			resource,
			kind,
			accept: () => {
				void this.editors
					.openEditor({ resource }, { pinned: true })
					.catch(error => this.notifications.error(String(error)));
			},
		});
		const folders = this.workspace.getWorkspace().folders;
		const seen = new Set<string>();
		const eligible = (item: IAnythingQuickPickItem): boolean => {
			const key = extUri.getComparisonKey(item.resource);
			if (seen.has(key) || !this.files.hasProvider(item.resource) || options.filter?.(item) === false)
				return false;
			seen.add(key);
			return true;
		};
		const recent = filterQuickPickItems(
			[
				...this.history.getHistory().map(input => itemFor(input.resource)),
				...this.groups.groups.flatMap(group => group.inputs).map(input => itemFor(input.resource)),
			],
			query,
		).filter(eligible);
		const picks: (IQuickPickItem | IQuickPickSeparator)[] = [
			...filterQuickPickItems(
				(options.additionPicks ?? []).filter((item): item is IQuickPickItem => !('type' in item)),
				query,
			),
			...(recent.length
				? [
						{
							type: 'separator' as const,
							label: localize('quickAccess.recentlyOpened', 'Recently opened'),
						},
						...recent,
					]
				: []),
		];
		if (!query && !options.includeFolders) return picks;
		const additionalPicks = async (): Promise<Picks<IPickerQuickAccessItem>> => {
			try {
				const isGlob = /[*?{[]/.test(query);
				const candidates: IAnythingQuickPickItem[] = [];
				const folder = folders[0]?.uri;
				const target = query.startsWith('/@browser/')
					? URI.from({ scheme: Schemas.file, path: query })
					: (folder ?? URI.from({ scheme: Schemas.file, path: '/' }));
				const resolvedHome = this.paths.resolvedUserHome;
				// An SSH or browser workspace must not expand ~ against the App Server's OS home.
				const home =
					target.scheme === resolvedHome?.scheme &&
					target.authority === resolvedHome.authority &&
					!target.path.startsWith('/@browser/')
						? resolvedHome
						: undefined;
				const path = await this.paths.getPath(target);
				if (token.isCancellationRequested) return [];
				const homePath =
					query === '~' || query.startsWith('~/') || (path?.sep === '\\' && query.startsWith('~\\'));
				const expanded =
					home && homePath
						? untildify(
								query,
								home.authority
									? `//${home.authority}${home.path}`
									: home.path.replace(/^\/(?=[a-z]:[\\/])/i, ''),
							)
						: query;
				const absolute = !isGlob && path?.isAbsolute(expanded);
				if (absolute && path) {
					const normalized = path.normalize(expanded);
					const resource =
						target?.scheme === Schemas.ashRemote || normalized.startsWith('/@browser/')
							? (target ?? URI.from({ scheme: Schemas.file, path: '/' })).with({ path: normalized })
							: await this.paths.fileURI(normalized);
					try {
						const stat = await this.files.stat(resource);
						if (stat.kind === FileKind.File || (options.includeFolders && stat.kind === FileKind.Directory))
							candidates.push(itemFor(resource, stat.kind));
					} catch {
						// Absolute-path candidates may not exist or may be outside authorized file roots.
					}
				}
				if (options.includeFolders && !absolute) {
					for (const folder of folders) {
						candidates.push(itemFor(folder.uri, FileKind.Directory));
						for (const entry of await this.files.readDirectory(folder.uri)) {
							if (entry.kind === FileKind.Directory)
								candidates.push(itemFor(entry.resource, FileKind.Directory));
						}
					}
				}
				if (query && !absolute) {
					const found = await this.search.fileSearch(
						new QueryBuilder().file(
							folders.map(folder => folder.uri),
							{
								filePattern: query,
								shouldGlobMatchFilePattern: isGlob,
								sortByScore: !isGlob,
								maxResults: 100,
								includePattern: this.configuration.getValue<string>(
									ContentSearchConfiguration.includePatterns,
								),
								excludePattern: this.configuration.getValue<string>(
									ContentSearchConfiguration.excludePatterns,
								),
							},
						),
						token,
					);
					for (const file of found.results) {
						if (options.includeFolders) {
							const folder = [...folders]
								.sort((a, b) => b.uri.path.length - a.uri.path.length)
								.find(folder => extUri.isEqualOrParent(file.resource, folder.uri));
							let parent = dirname(file.resource);
							while (folder && extUri.isEqualOrParent(parent, folder.uri)) {
								candidates.push(itemFor(parent, FileKind.Directory));
								if (extUri.isEqual(parent, folder.uri)) break;
								parent = dirname(parent);
							}
						}
						candidates.push(itemFor(file.resource));
					}
				}
				if (token.isCancellationRequested) return [];
				const eligibleCandidates = candidates
					.filter(item => {
						if (absolute || item.kind !== FileKind.Directory || !query) return true;
						return /[*?{[]/.test(query)
							? match(query, item.resource.path)
							: filterQuickPickItems([item], query).length > 0;
					})
					.filter(eligible);
				return [
					...(eligibleCandidates.length
						? [
								{
									type: 'separator' as const,
									label: localize('quickAccess.workspaceResources', 'Workspace'),
								},
								...eligibleCandidates,
							]
						: []),
				];
			} catch (error) {
				if (!token.isCancellationRequested)
					this.notifications.error(
						localize('quickAccess.fileSearchFailed', 'Could not search files: {0}', String(error)),
					);
				return [];
			}
		};
		return { picks, additionalPicks: additionalPicks() };
	}
}
