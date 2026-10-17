import { Emitter, type Event } from '../../../../base/common/event.js';
import { parse, type IExpression } from '../../../../base/common/glob.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IFileStat } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ResourceGlobMatcher } from '../../../common/resources.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
const expressionSettings = [
	['files.readonlyInclude', localize('files.readonlyIncludeTitle', 'Read-only file patterns'), localize('files.readonlyIncludeDescription', 'Open matching files as read-only. Add writable exceptions below to allow editing specific files.')],
	['files.readonlyExclude', localize('files.readonlyExcludeTitle', 'Writable file exceptions'), localize('files.readonlyExcludeDescription', 'Allow editing matching files even when they match a read-only rule. Filesystem permissions still apply.')],
	['files.exclude', localize('files.excludeTitle', 'File exclusion patterns'), localize('files.excludeDescription', 'Hide matching files and folders in Explorer. Removing a default rule makes those files visible again.')],
	['search.exclude', localize('files.searchExcludeTitle', 'Search exclusion patterns'), localize('files.searchExcludeDescription', 'Skip matching files and folders when searching the workspace.')],
	['explorer.autoRevealExclude', localize('files.autoRevealExcludeTitle', 'Auto-reveal exclusion patterns'), localize('files.autoRevealExcludeDescription', 'Keep Explorer from automatically revealing and selecting matching files when you open them. The files remain visible in Explorer.')],
	['workbench.localHistory.exclude', localize('files.historyExcludeTitle', 'Local history exclusion patterns'), localize('files.historyExcludeDescription', 'Do not save local history entries for matching files.')],
] as const;
for (const [key, title, description] of expressionSettings) {
	const conditional = key === 'files.exclude' || key === 'search.exclude' || key === 'explorer.autoRevealExclude';
	registry.registerConfiguration<IExpression>({
		key,
		defaultValue: key === 'files.exclude' ? {
			'**/.git': true,
			'**/.svn': true,
			'**/.hg': true,
			'**/.jj': true,
			'**/.DS_Store': true,
			'**/Thumbs.db': true,
		} : {},
		scope: ConfigurationScope.RESOURCE,
		schema: { type: 'object', additionalProperties: conditional ? { anyOf: [{ type: 'boolean' }, { type: 'object', required: ['when'], properties: { when: { type: 'string' } }, additionalProperties: false }] } : { type: 'boolean' } },
		parse: value => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new TypeError(localize('files.invalidGlobExpression', '{0} must be an object containing path patterns.', key));
			}
			for (const [pattern, rule] of Object.entries(value)) {
				if (!pattern || typeof rule !== 'boolean' && (!conditional || typeof rule !== 'object' || rule === null || Array.isArray(rule) || Object.keys(rule).length !== 1 || !('when' in rule) || typeof rule.when !== 'string')) {
					throw new TypeError(conditional ? localize('files.invalidGlobRule', 'Invalid rule for {0} in {1}. Use true, false, or an object with a when string.', pattern, key) : localize('files.invalidBooleanGlobRule', 'Invalid rule for {0} in {1}. Use true or false.', pattern, key));
				}
			}
			parse(value as IExpression);
			return value as IExpression;
		},
		setting: {
			valueType: 'stringMap', structuredValues: true, title,
			description,
			keyLabel: localize('files.globPattern', 'Path pattern'),
			valueLabel: localize('files.globRule', 'Rule'),
			addLabel: localize('files.globAdd', 'Add pattern'),
			removeLabel: localize('files.globRemove', 'Remove pattern'),
			incompleteMessage: localize('files.globIncomplete', 'Enter a path pattern and a rule.'),
			duplicateMessage: localize('files.globDuplicate', 'Each path pattern must be unique.'),
		},
	});
}
registry.registerConfiguration({
	key: 'explorer.autoReveal', defaultValue: true as boolean | 'focusNoScroll', parse(value: unknown): boolean | 'focusNoScroll' {
		if (typeof value !== 'boolean' && value !== 'focusNoScroll') {
			throw new TypeError(localize('files.invalidAutoReveal', 'Auto reveal must be true, false, or focusNoScroll.'));
		}
		return value;
	}, scope: ConfigurationScope.WINDOW, schema: { enum: [true, false, 'focusNoScroll'] }, setting: {
		valueType: 'select', title: localize('files.autoRevealTitle', 'Auto reveal'),
		description: localize('files.autoRevealDescription', 'Select the active editor file in Explorer without moving keyboard focus.'),
		options: [
			{ value: true, label: localize('files.autoRevealOn', 'Reveal and select') },
			{ value: false, label: localize('files.autoRevealOff', 'Off') },
			{ value: 'focusNoScroll', label: localize('files.autoRevealNoScroll', 'Select without scrolling') },
		],
	}
});

export interface IFilesConfigurationService {
	readonly onDidChangeReadonly: Event<void>;
	isReadonly(resource: URI, stat?: IFileStat): boolean | string;
}

export const IFilesConfigurationService = createDecorator<IFilesConfigurationService>('filesConfigurationService');

/** Interprets editor file policies; filesystem permissions remain with the file provider. */
export class FilesConfigurationService extends Disposable implements IFilesConfigurationService {
	private readonly readonlyChanged = this._register(new Emitter<void>());
	public readonly onDidChangeReadonly = this.readonlyChanged.event;
	private readonly include: ResourceGlobMatcher;
	private readonly exclude: ResourceGlobMatcher;

	constructor(
		@IConfigurationService configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this.include = this._register(new ResourceGlobMatcher(() => configuration.getValue<IExpression>('files.readonlyInclude'), event => event.affectsConfiguration('files.readonlyInclude'), workspace, configuration));
		this.exclude = this._register(new ResourceGlobMatcher(() => configuration.getValue<IExpression>('files.readonlyExclude'), event => event.affectsConfiguration('files.readonlyExclude'), workspace, configuration));
		this._register(this.include.onExpressionChange(() => this.readonlyChanged.fire()));
		this._register(this.exclude.onExpressionChange(() => this.readonlyChanged.fire()));
	}

	public isReadonly(resource: URI, stat?: IFileStat): boolean | string {
		if (stat?.readonly) {
			return true;
		}
		return this.include.matches(resource) && !this.exclude.matches(resource) ? localize('files.configuredReadonly', 'This file is read-only because it matches the configured read-only patterns.') : false;
	}
}

registerSingleton(IFilesConfigurationService, FilesConfigurationService, InstantiationType.Delayed);
