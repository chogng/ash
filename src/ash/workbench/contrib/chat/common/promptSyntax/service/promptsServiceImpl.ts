import { CancellationToken, throwIfCancelled } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../../base/common/map.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { URI } from '../../../../../../base/common/uri.js';
import { AppServerRemoteError } from '../../../../../../platform/agentHost/common/appServerError.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { IAppServerSkillApi, type SkillDescriptor, type SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { PromptFileParser, type ParsedPromptFile } from '../promptFileParser.js';
import { SkillManagementConflictError, type IAgentSkill, type IPromptsService, type SkillManagementSnapshot } from './promptsService.js';

/** Owns discovered Prompt identities and readable snapshots; Rust owns catalog and enablement. */
export class PromptsService extends Disposable implements IPromptsService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeSkills = this.changed.event;
	private readonly references = new ResourceMap<{ readonly reference: SkillReference; readonly sessionId: string | undefined; }>();
	private readonly parser = new PromptFileParser();
	private readonly reads = new Set<AbortController>();
	private epoch = 0;

	constructor(@IAppServerSkillApi private readonly backend: IAppServerSkillApi) {
		super();
		this._register(backend.onDidChangeSkills(() => {
			this.epoch++;
			for (const read of this.reads) read.abort();
			this.references.clear();
			this.changed.fire();
		}));
	}

	public async findAgentSkills(token: CancellationToken, sessionId?: string): Promise<readonly IAgentSkill[]> {
		throwIfCancelled(token);
		if (this.isDisposed) throw new CancellationError();
		const epoch = this.epoch;
		const catalog = await this.backend.list('cached', sessionId);
		throwIfCancelled(token);
		if (this.isDisposed || epoch !== this.epoch) throw new CancellationError();
		return Object.freeze(catalog.skills.map(skill => this.discover(skill, sessionId)));
	}

	public async readSkillManagement(sessionId?: string): Promise<SkillManagementSnapshot> {
		// Refresh may publish its own catalog invalidation before the response reaches this window.
		// Re-read once so revision and descriptors come from a settled backend snapshot; never spin.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (this.isDisposed) throw new CancellationError();
			const epoch = this.epoch;
			const snapshot = await this.backend.read(sessionId);
			if (this.isDisposed) throw new CancellationError();
			if (epoch !== this.epoch) continue;
			return { ...snapshot, catalog: { generation: snapshot.catalog.generation, skills: Object.freeze(snapshot.catalog.skills.map(skill => this.discover(skill, sessionId))) } };
		}
		throw new CancellationError();
	}

	public async setSkillEnablement(skillId: SkillDescriptor['id'], enabled: boolean, expectedRevision: number, sessionId?: string): Promise<void> {
		if (this.isDisposed) throw new CancellationError();
		// Do not retry a mutation: an expected-revision conflict must remain reviewable to the caller.
		try {
			await this.backend.setEnabled(skillId, enabled, expectedRevision, sessionId);
		} catch (error) {
			if (error instanceof AppServerRemoteError && error.errorName === 'ConfigRevisionConflict') throw new SkillManagementConflictError(expectedRevision);
			throw error;
		}
	}

	public async parseNew(uri: URI, token: CancellationToken = CancellationToken.None): Promise<ParsedPromptFile> {
		throwIfCancelled(token);
		const match = /^\/([^/]+)\/(.+)$/u.exec(uri.path);
		const instructions = match ? uri.with({ path: `/${match[1]}/SKILL.md`, fragment: '' }) : uri;
		const target = this.references.get(instructions);
		const path = match?.[2];
		if (!target || !path || (/[\x00-\x1f\x7f\\]/u.test(path)) || path.split('/').some(segment => segment === '..' || segment === '.' || !segment) || this.isDisposed) throw new ReferenceError('Prompt URI was not discovered in this window');
		const controller = new AbortController();
		this.reads.add(controller);
		const cancelled = token.onCancellationRequested(() => controller.abort());
		try {
			const content = await this.backend.readTextResource(target.reference, path, controller.signal, target.sessionId);
			throwIfCancelled(token);
			throwIfCancelled(controller.signal);
			return this.parser.parse(uri, content);
		} finally {
			cancelled.dispose();
			this.reads.delete(controller);
		}
	}

	private discover(skill: SkillDescriptor, sessionId: string | undefined): IAgentSkill {
		const reference: SkillReference = { id: skill.id, version: { type: 'pinnedDigest', digest: skill.contentDigest } };
		const uri = URI.from({ scheme: Schemas.internal, authority: 'skill', path: `/${skill.id.name}/SKILL.md`, query: JSON.stringify({ source: skill.id.source, digest: skill.contentDigest, sessionId }) });
		this.references.set(uri, { reference, sessionId });
		return Object.freeze({ ...skill, name: skill.id.name, uri });
	}

	public override dispose(): void {
		this.epoch++;
		for (const read of this.reads) read.abort();
		this.reads.clear();
		this.references.clear();
		super.dispose();
	}
}
