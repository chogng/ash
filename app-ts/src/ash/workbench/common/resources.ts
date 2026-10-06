import { Emitter } from '../../base/common/event.js';
import { parse, type IExpression, type ParsedExpression } from '../../base/common/glob.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { equals } from '../../base/common/objects.js';
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import type { URI } from '../../base/common/uri.js';
import { IConfigurationService, type IConfigurationChangeEvent } from '../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';

interface RuleSet {
	readonly expression: IExpression;
	readonly matches: ParsedExpression;
	readonly hasAbsolutePath: boolean;
}

/** Keeps synchronous resource matching current with workspace and configuration changes. */
export class ResourceGlobMatcher extends Disposable {
	private readonly rules = new Map<string | undefined, RuleSet>();
	private readonly expressionChanged = this._register(new Emitter<void>());
	public readonly onExpressionChange = this.expressionChanged.event;

	constructor(
		private readonly getExpression: (folder?: URI) => IExpression | undefined,
		shouldUpdate: (event: IConfigurationChangeEvent) => boolean,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.refresh();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (shouldUpdate(event) && this.refresh()) {
				this.expressionChanged.fire();
			}
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			if (this.refresh()) {
				this.expressionChanged.fire();
			}
		}));
		this._register(toDisposable(() => this.rules.clear()));
	}

	public matches(resource: URI, hasSibling?: (name: string) => boolean): boolean {
		this.assertNotDisposed();
		const folder = this.workspace.getWorkspaceFolder(resource);
		const rules = this.rules.get(folder ? extUriBiasedIgnorePathCase.getComparisonKey(folder.uri) : undefined) ?? this.rules.get(undefined);
		if (!rules) {
			return false;
		}
		const absolute = normalizePath(resource.scheme === Schemas.file ? resource.fsPath : resource.path);
		// Use the workspace owner's containment decision, including nested roots and path casing.
		const relative = folder ? resource.path.slice(folder.uri.path.replace(/\/$/, '').length).replace(/^\//, '') : absolute;
		return rules.matches(relative, undefined, hasSibling) !== null || rules.hasAbsolutePath && relative !== absolute && rules.matches(absolute, undefined, hasSibling) !== null;
	}

	private refresh(): boolean {
		const next = new Map<string | undefined, RuleSet>();
		let changed = false;
		for (const folder of [undefined, ...this.workspace.getWorkspace().folders.map(folder => folder.uri)]) {
			const key = folder ? extUriBiasedIgnorePathCase.getComparisonKey(folder) : undefined;
			const configured = this.getExpression(folder);
			if (!configured || Object.keys(configured).length === 0) {
				continue;
			}
			const expression: IExpression = Object.fromEntries(Object.entries(configured).map(([pattern, value]) => [normalizePath(pattern), typeof value === 'object' ? { when: value.when } : value]));
			const previous = this.rules.get(key);
			if (previous && equals(previous.expression, expression)) {
				next.set(key, previous);
			} else {
				next.set(key, { expression, matches: parse(expression), hasAbsolutePath: Object.keys(expression).some(pattern => /^(?:\/|[a-z]:\/)/i.test(pattern)) });
				changed = true;
			}
		}
		changed ||= next.size !== this.rules.size || [...this.rules.keys()].some(key => !next.has(key));
		this.rules.clear();
		for (const [key, rules] of next) {
			this.rules.set(key, rules);
		}
		return changed;
	}
}

function normalizePath(path: string): string {
	return path.replaceAll('\\', '/').replace(/^[A-Z](?=:\/)/, letter => letter.toLowerCase());
}
