import { Emitter, type Event } from '../../../../base/common/event.js';
import type { IExpression } from '../../../../base/common/glob.js';
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
for (const key of ['files.readonlyInclude', 'files.readonlyExclude', 'files.exclude', 'search.exclude', 'explorer.autoRevealExclude', 'workbench.localHistory.exclude']) {
	registry.registerConfiguration<IExpression>({
		key,
		defaultValue: {},
		scope: ConfigurationScope.RESOURCE,
		schema: { type: 'object', additionalProperties: { anyOf: [{ type: 'boolean' }, { type: 'object', required: ['when'], properties: { when: { type: 'string' } }, additionalProperties: false }] } },
		parse: value => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new TypeError(`${key} must be a glob expression`);
			}
			for (const [pattern, rule] of Object.entries(value)) {
				if (!pattern || typeof rule !== 'boolean' && (typeof rule !== 'object' || rule === null || Array.isArray(rule) || Object.keys(rule).length !== 1 || !('when' in rule) || typeof rule.when !== 'string')) {
					throw new TypeError(`Invalid glob rule in ${key}: ${pattern}`);
				}
			}
			return value as IExpression;
		},
	});
}
registry.registerConfiguration({ key: 'explorer.autoReveal', defaultValue: true, parse(value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw new TypeError('explorer.autoReveal must be boolean');
	}
	return value;
}, scope: ConfigurationScope.WINDOW });

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
