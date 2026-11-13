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
const defaultTrustedDomains = [
	'https://www.microsoft.com',
	'https://learn.microsoft.com',
	'https://code.visualstudio.com',
	'https://openai.com',
	'https://chatgpt.com',
	'https://github.com',
];

/** Interprets one application-scoped document; parsed rules are a derived snapshot. */
export class TrustedDomainService extends Disposable implements ITrustedDomainService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeTrustedDomains = this.changed.event;
	private rules: readonly string[] = [];
	private source = '';

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.reload();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === storageKey) {
				this.reload();
				this.changed.fire();
			}
		}));
	}

	get content(): string { return this.source; }
	get trustedDomains(): readonly string[] { return this.rules; }

	isValid(resource: URI): boolean {
		return isURLDomainTrusted(resource, this.rules);
	}

	async setTrustedDomains(content: string, expectedContent?: string): Promise<void> {
		this.assertNotDisposed();
		// The parser validates the complete candidate before either storage or live trust changes.
		this.parseDocument(content);
		if (expectedContent !== undefined && this.source !== expectedContent) {
			throw new Error(localize('url.trust.conflict', 'Trusted domains changed. Reload the document before saving.'));
		}
		this.storage.store(storageKey, content, StorageScope.APPLICATION, StorageTarget.USER);
		await this.storage.flush();
	}

	async addTrustedDomain(pattern: string): Promise<void> {
		const content = this.source;
		const rules = this.parseDocument(content);
		const normalized = this.normalizeRuleInput(pattern);
		if (rules.includes(normalized)) return;
		await this.setTrustedDomains(applyEdits(content, setProperty(content, [rules.length], normalized, formatting)), content);
	}

	async updateTrustedDomain(original: string, pattern: string): Promise<string> {
		const content = this.source;
		const rules = this.parseDocument(content);
		if (!rules.includes(original)) {
			throw new Error(localize('url.trust.ruleChanged', 'This trusted domain rule has changed or been removed.'));
		}
		const normalized = this.normalizeRuleInput(pattern);
		if (normalized === original) return normalized;
		if (rules.includes(normalized)) {
			throw new Error(localize('url.trust.duplicatePattern', 'This trusted domain rule already exists.'));
		}
		// Update all equivalent spellings in one write and keep surrounding comments.
		const nodes = parseTree(content)?.children ?? [];
		const edits = nodes.flatMap((node, index) => rules[index] === original
			? [{ offset: node.offset, length: node.length, content: JSON.stringify(normalized) }]
			: []);
		await this.setTrustedDomains(applyEdits(content, edits), content);
		return normalized;
	}

	async removeTrustedDomain(pattern: string): Promise<void> {
		const content = this.source;
		const rules = this.parseDocument(content);
		let updated = content;
		// The table shows unique rules. Remove every equivalent entry from the JSONC source.
		for (let index = rules.length - 1; index >= 0; index--) {
			if (rules[index] === pattern) {
				updated = applyEdits(updated, removeProperty(updated, [index], formatting));
			}
		}
		if (updated !== content) await this.setTrustedDomains(updated, content);
	}

	private reload(): void {
		this.source = this.storage.get(storageKey, StorageScope.APPLICATION) ?? this.initialContent();
		try {
			this.rules = Object.freeze([...new Set(this.parseDocument(this.source))]);
		} catch (error) {
			// Invalid persisted input must revoke prior rules rather than preserve stale grants.
			this.rules = Object.freeze([]);
			this.notifications.error(error instanceof Error ? error.message : String(error));
		}
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

	private initialContent(): string {
		const help = [
			localize('url.trust.documentHelp', 'Add each rule as a quoted string in the array. Save to apply changes. Remove a rule to revoke trust.'),
			localize('url.trust.documentHost', '{0} allows HTTP and HTTPS on that host. {1} allows HTTPS only.', 'example.com', 'https://example.com'),
			localize('url.trust.documentPath', '{0} matches that path and its descendants. Remove any query (?) or fragment (#) from the rule.', 'https://example.com/docs'),
			localize('url.trust.documentWildcard', '{0} matches the host and its subdomains. {1} allows any HTTPS port on the host.', 'https://*.example.com', 'https://example.com:*'),
			localize('url.trust.documentAll', 'The rule "*" trusts all web domains.'),
		];
		return `${help.map(line => `// ${line}`).join('\n')}\n${JSON.stringify(defaultTrustedDomains, null, formatting.tabSize)}\n`;
	}
}
