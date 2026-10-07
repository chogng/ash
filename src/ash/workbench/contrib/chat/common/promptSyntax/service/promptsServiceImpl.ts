import { CancellationToken, throwIfCancelled } from '../../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../../base/common/map.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { URI } from '../../../../../../base/common/uri.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { IAppServerSkillApi, type SkillDescriptor, type SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { PromptFileParser, type ParsedPromptFile } from '../promptFileParser.js';
import type { IAgentSkill, IPromptsService, SkillManagementSnapshot } from './promptsService.js';

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
		const epoch = this.epoch;
		const catalog = await this.backend.list('cached', sessionId);
		throwIfCancelled(token);
		if (this.isDisposed || epoch !== this.epoch) throw new CancellationError();
		return Object.freeze(catalog.skills.map(skill => this.discover(skill, sessionId)));
	}

	public async readSkillManagement(sessionId?: string): Promise<SkillManagementSnapshot> {
		const epoch = this.epoch;
		const snapshot = await this.backend.read(sessionId);
		if (this.isDisposed || epoch !== this.epoch) throw new CancellationError();
		return { ...snapshot, catalog: { generation: snapshot.catalog.generation, skills: snapshot.catalog.skills.map(skill => this.discover(skill, sessionId)) } };
	}

	public async setSkillEnablement(skillId: SkillDescriptor['id'], enabled: boolean, expectedRevision: number, sessionId?: string): Promise<void> {
		await this.backend.setEnabled(skillId, enabled, expectedRevision, sessionId);
	}

	public async parseNew(uri: URI, token: CancellationToken = CancellationToken.None): Promise<ParsedPromptFile> {
		throwIfCancelled(token);
		const target = this.references.get(uri);
		if (!target || this.isDisposed) throw new ReferenceError('Prompt URI was not discovered in this window');
		const controller = new AbortController();
		this.reads.add(controller);
		const cancelled = token.onCancellationRequested(() => controller.abort());
		try {
			const content = await this.backend.readInstructions(target.reference, controller.signal, target.sessionId);
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
