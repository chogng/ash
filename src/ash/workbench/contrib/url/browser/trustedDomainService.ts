import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { parse, type ParseError } from '../../../../base/common/json.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isURLDomainTrusted, normalizeURLPattern } from '../../../../platform/url/common/trustedDomains.js';
import { ITrustedDomainService } from '../common/trustedDomainService.js';

const storageKey = 'http.linkProtectionTrustedDomains';

/** Interprets one application-scoped document; parsed rules are a derived snapshot. */
export class TrustedDomainService extends Disposable implements ITrustedDomainService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeTrustedDomains = this.changed.event;
	private rules: readonly string[] = [];
	private source = this.emptyContent();

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.reload();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.APPLICATION && event.key === storageKey) {
					this.reload();
					this.changed.fire();
				}
			}),
		);
	}

	get content(): string {
		return this.source;
	}
	get trustedDomains(): readonly string[] {
		return this.rules;
	}

	isValid(resource: URI): boolean {
		return isURLDomainTrusted(resource, this.rules);
	}

	async setTrustedDomains(content: string, expectedContent?: string): Promise<void> {
		this.assertNotDisposed();
		// The parser validates the complete candidate before either storage or live trust changes.
		this.parseRules(content);
		if (expectedContent !== undefined && this.source !== expectedContent) {
			throw new Error(
				localize('url.trust.conflict', 'Trusted domains changed. Reload the document before saving.'),
			);
		}
		this.storage.store(storageKey, content, StorageScope.APPLICATION, StorageTarget.USER);
		await this.storage.flush();
	}

	private reload(): void {
		this.source = this.storage.get(storageKey, StorageScope.APPLICATION) ?? this.emptyContent();
		try {
			this.rules = this.parseRules(this.source);
		} catch (error) {
			// Invalid persisted input must revoke prior rules rather than preserve stale grants.
			this.rules = Object.freeze([]);
			this.notifications.error(error instanceof Error ? error.message : String(error));
		}
	}

	private parseRules(content: string): readonly string[] {
		const invalidDocument = () =>
			new TypeError(
				localize(
					'url.trust.invalidDocument',
					'Trusted domains must be a JSONC array of at most 1024 domain patterns, within 64 KiB.',
				),
			);
		if (VSBuffer.fromString(content).byteLength > 65_536) throw invalidDocument();
		const errors: ParseError[] = [];
		const value: unknown = parse(content, errors, { allowTrailingComma: true });
		if (errors.length || !Array.isArray(value) || value.length > 1_024) {
			throw invalidDocument();
		}
		const rules = value.map((rule: unknown) => {
			try {
				if (typeof rule !== 'string') throw new TypeError();
				return normalizeURLPattern(rule);
			} catch {
				throw new TypeError(
					localize('url.trust.invalidPattern', 'Invalid trusted domain pattern: {0}', String(rule)),
				);
			}
		});
		return Object.freeze([...new Set(rules)]);
	}

	private emptyContent(): string {
		return `// ${localize('url.trust.documentHelp', 'List trusted web domains as strings. Rules may include http:// or https://, *.subdomains, :* ports, and paths. Use "*" to trust all domains. Save to apply; remove a rule to revoke trust.')}\n[]\n`;
	}
}
