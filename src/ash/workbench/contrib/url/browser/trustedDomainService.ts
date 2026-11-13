import product from '../../../../../../product.json' with { type: 'json' };
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { parse, parseTree, type ParseError } from '../../../../base/common/json.js';
import { applyEdits, removeProperty, setProperty } from '../../../../base/common/jsonEdit.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isURLDomainTrusted, normalizeURLPattern } from '../../../../platform/url/common/trustedDomains.js';
import { ITrustedDomainService } from '../common/trustedDomainService.js';

const storageKey = 'http.linkProtectionTrustedDomains';
const formatting = { insertSpaces: true, tabSize: 2 };
const defaultTrustedDomains = product.linkProtectionTrustedDomains.map(normalizeURLPattern);

/** Combines product policy with one application-scoped user document. */
export class TrustedDomainService extends Disposable implements ITrustedDomainService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeTrustedDomains = this.changed.event;
	private readonly defaultComments: string;
	private userRules: readonly string[] = [];
	private source = '';

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.defaultComments = this.createDefaultComments();
		this.reload();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === storageKey) {
				this.reload();
				this.changed.fire();
			}
		}));
	}

	get content(): string { return this.defaultCommentsFor(this.source) + this.source; }
	get trustedDomains(): readonly string[] { return Object.freeze([...defaultTrustedDomains, ...this.userRules]); }
	get userTrustedDomains(): readonly string[] { return this.userRules; }

	isValid(resource: URI): boolean {
		return isURLDomainTrusted(resource, this.trustedDomains);
	}

	async setTrustedDomains(content: string, expectedContent?: string): Promise<string> {
		this.assertNotDisposed();
		// Only the generated preamble is virtual. Preserve all user-authored comments.
		const defaultComments = this.defaultCommentsFor(content);
		const userContent = content.startsWith(defaultComments) ? content.slice(defaultComments.length) : content;
		const rules = this.parseDocument(userContent);
		if (expectedContent !== undefined && this.content !== expectedContent) {
			throw new Error(localize('url.trust.conflict', 'Trusted domains changed. Reload the document before saving.'));
		}
		const source = this.removeRules(userContent, rules, rule => defaultTrustedDomains.includes(rule));
		this.storage.store(storageKey, source, StorageScope.APPLICATION, StorageTarget.USER);
		await this.storage.flush();
		return this.defaultCommentsFor(source) + source;
	}

	async addTrustedDomain(pattern: string): Promise<void> {
		const content = this.source;
		const rules = this.parseDocument(content);
		const normalized = this.normalizeRuleInput(pattern);
		if (rules.includes(normalized) || defaultTrustedDomains.includes(normalized)) return;
		await this.setTrustedDomains(applyEdits(content, setProperty(content, [rules.length], normalized, formatting)), this.content);
	}

	async updateTrustedDomain(original: string, pattern: string): Promise<string> {
		const content = this.source;
		const rules = this.parseDocument(content);
		if (!rules.includes(original)) {
			throw new Error(localize('url.trust.ruleChanged', 'This trusted domain rule has changed or been removed.'));
		}
		const normalized = this.normalizeRuleInput(pattern);
		if (normalized === original) return normalized;
		if (rules.includes(normalized) || defaultTrustedDomains.includes(normalized)) {
			throw new Error(localize('url.trust.duplicatePattern', 'This trusted domain rule already exists.'));
		}
		// Update all equivalent spellings in one write and keep surrounding comments.
		const nodes = parseTree(content)?.children ?? [];
		const edits = nodes.flatMap((node, index) => rules[index] === original
			? [{ offset: node.offset, length: node.length, content: JSON.stringify(normalized) }]
			: []);
		await this.setTrustedDomains(applyEdits(content, edits), this.content);
		return normalized;
	}

	async removeTrustedDomain(pattern: string): Promise<void> {
		const content = this.source;
		const rules = this.parseDocument(content);
		const updated = this.removeRules(content, rules, rule => rule === pattern);
		if (updated !== content) await this.setTrustedDomains(updated, this.content);
	}

	private reload(): void {
		const content = this.storage.get(storageKey, StorageScope.APPLICATION) ?? this.initialContent();
		try {
			const rules = this.parseDocument(content);
			const userRules = rules.filter(rule => !defaultTrustedDomains.includes(rule));
			// Older documents could have the product defaults in their array. Project them
			// out on read and persist the user-only document on the next save.
			this.source = this.removeRules(content, rules, rule => defaultTrustedDomains.includes(rule));
			this.userRules = Object.freeze([...new Set(userRules)]);
		} catch (error) {
			// Keep invalid source available for repair and drop all prior user grants.
			this.source = content;
			this.userRules = Object.freeze([]);
			this.notifications.error(error instanceof Error ? error.message : String(error));
		}
	}

	private removeRules(content: string, rules: readonly string[], shouldRemove: (rule: string) => boolean): string {
		for (let index = rules.length - 1; index >= 0; index--) {
			if (shouldRemove(rules[index]!)) {
				content = applyEdits(content, removeProperty(content, [index], formatting));
			}
		}
		return content;
	}

	private parseDocument(content: string): readonly string[] {
		const invalidDocument = () => new TypeError(localize('url.trust.invalidDocument', 'Trusted domains must be a JSONC array of at most 1024 domain patterns, within 64 KiB.'));
		if (VSBuffer.fromString(content).byteLength > 65_536) throw invalidDocument();
		const errors: ParseError[] = [];
		const value: unknown = parse(content, errors, { allowTrailingComma: true });
		if (errors.length || !Array.isArray(value) || value.length > 1_024) {
			throw invalidDocument();
		}
		return value.map(rule => this.normalizeRule(rule));
	}

	private normalizeRule(rule: unknown): string {
		try {
			if (typeof rule !== 'string') throw new TypeError();
			return normalizeURLPattern(rule);
		} catch {
			throw new TypeError(localize('url.trust.invalidPattern', 'Invalid trusted domain pattern: {0}', String(rule)));
		}
	}

	private normalizeRuleInput(input: string): string {
		const pattern = input.trim();
		// A pasted web URL can carry a query and fragment, neither of which a rule matches.
		const rule = /^https?:\/\//iu.test(pattern) ? pattern.split(/[?#]/u, 1)[0]! : pattern;
		return this.normalizeRule(rule);
	}

	private createDefaultComments(): string {
		const domains = product.linkProtectionTrustedDomains;
		if (domains.length === 0) {
			return `// ${localize('url.trust.documentLocalhost', 'Ash trusts localhost by default.')}\n`;
		}
		const heading = localize('url.trust.documentDefaults', 'Ash trusts localhost and the following domains by default.');
		return [`// ${heading}`, ...domains.map(domain => `// - ${JSON.stringify(domain)}`), ''].join('\n');
	}

	private defaultCommentsFor(content: string): string {
		return /\r?\n/u.exec(content)?.[0] === '\r\n' ? this.defaultComments.replaceAll('\n', '\r\n') : this.defaultComments;
	}

	private initialContent(): string {
		const help = [
			localize('url.trust.documentHelp', 'Add your own rules as quoted strings in the array. Save to apply changes.'),
			localize('url.trust.documentHost', '{0} allows HTTP and HTTPS on that host. {1} allows HTTPS only.', 'example.com', 'https://example.com'),
			localize('url.trust.documentPath', '{0} matches that path and its descendants. Remove any query (?) or fragment (#) from the rule.', 'https://example.com/docs'),
			localize('url.trust.documentWildcard', '{0} matches the host and its subdomains. {1} allows any HTTPS port on the host.', 'https://*.example.com', 'https://example.com:*'),
			localize('url.trust.documentAll', 'The rule "*" trusts all web domains.'),
		];
		return `${help.map(line => `// ${line}`).join('\n')}\n[]\n`;
	}
}
