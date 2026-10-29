import type {
	DebugSessionRelation,
	DebugConsoleEntry,
	DebugConsoleSnapshot,
	DebugExceptionsSnapshot,
	DebugWorkspaceSnapshot,
	DebugWorkspaceState,
	DebugWorkspaceEdit,
	DebugBreakpointIntent,
	DebugBreakpointBinding,
	DebugBreakpointUnsupported,
	DebugBreakpointsSnapshot,
	DebugInspection,
	DebugInspectionResult,
	DebugInspectionValue,
	DebugSessionSnapshot,
	IDebugAdapterProcessReadResult,
	IDebugAdapterProcessService,
} from '../../../../../platform/debug/common/debugAdapterProcessService.js';

type TransportFixture = Pick<
	IDebugAdapterProcessService,
	'start' | 'send' | 'read' | 'close' | 'getConnectionState' | 'onConnectionState'
>;
type ManagedMessage = { sequence: number; direction: 'incoming' | 'outgoing'; message: unknown };

/** Simulates the App Server request boundary around existing deterministic DAP
 * peers. Protocol correctness is tested against the real Rust client separately. */
export function installDebugClientFixture<T extends TransportFixture>(transport: T): T & IDebugAdapterProcessService {
	const start = transport.start.bind(transport);
	const send = transport.send.bind(transport);
	const read = transport.read.bind(transport);
	const close = transport.close.bind(transport);
	const sessions = new Map<
		string,
		{
			nextRequest: number;
			rawCursor: number;
			client: boolean;
			messages: ManagedMessage[];
			responses: Map<number, unknown>;
			status: IDebugAdapterProcessReadResult;
			closed?: boolean;
			publicId: string;
			noDebug?: boolean;
			bp: DebugBreakpointsSnapshot;
			sources: Map<string, DebugBreakpointIntent['location']>;
			bpQueue: Promise<void>;
			nextInspection: number;
			inspections: Map<number, { epoch: number; result: DebugInspectionResult }>;
			epoch: number;
			runtime: DebugSessionSnapshot;
			requests: Map<number, { command: string; revision: number; repl?: boolean }>;
			adapterId?: string;
			rawCapabilities: Record<string, unknown>;
			initialized: boolean;
			launch?: Promise<unknown>;
		}
	>();
	const empty: IDebugAdapterProcessReadResult = {
		messages: [],
		nextSequence: 0,
		outputGap: false,
		stderr: '',
		exited: false,
		exitCode: null,
		protocolError: null,
	};
	const session = (id: string) => {
		const state = sessions.get(id);
		if (!state) throw new Error('Fixture session not found');
		return state;
	};
	const relations = new Map<string, DebugSessionRelation>();
	let catalogRevision = 0;
	const consoleIds = () => [...new Set([...relations.values()].map(value => value.consoleId))];
	const consoles = new Map<string, DebugConsoleSnapshot>();
	const exceptions = new Map<string, DebugExceptionsSnapshot>();
	const consoleFor = (id: string): DebugConsoleSnapshot =>
		consoles.get(relations.get(id)?.consoleId ?? id) ?? { revision: 0, entries: [] };
	const append = (id: string, output: string, body: Partial<DebugConsoleEntry> = {}): void => {
		const key = relations.get(id)?.consoleId ?? id;
		const old = consoleFor(id);
		const entry: DebugConsoleEntry = {
			id: old.revision + 1,
			sessionId: id,
			kind: 'output',
			output,
			category: 'console',
			parentId: null,
			collapsed: false,
			variablesReference: null,
			source: null,
			line: null,
			column: null,
			data: null,
			...body,
		};
		consoles.set(key, { revision: old.revision + 1, entries: [...old.entries, entry].slice(-512) });
	};
	const end = (id: string): DebugSessionRelation => {
		const value = relations.get(id);
		if (!value) throw new Error('Fixture session admission not found');
		const descendants = [...relations.values()]
			.filter(candidate => candidate.parentId === id)
			.flatMap(child => [...end(child.id).descendants, child.id]);
		const result = { ...value, ended: true, descendants };
		relations.set(id, result);
		for (const [runtimeId, state] of sessions)
			if (descendants.includes(state.publicId) && state.runtime.phase !== 'ended')
				update(runtimeId, { state: 'terminated', phase: 'ended' });
		return result;
	};

	const capabilities = (value: Record<string, unknown>): DebugSessionSnapshot['capabilities'] => ({
		supportsRestart: value.supportsRestartRequest === true,
		supportsTerminate: value.supportsTerminateRequest === true || value.supportTerminateDebuggee === true,
		supportsSetVariable: value.supportsSetVariable === true,
		supportsConditionalBreakpoints: value.supportsConditionalBreakpoints === true,
		supportsHitConditionalBreakpoints: value.supportsHitConditionalBreakpoints === true,
		supportsLogPoints: value.supportsLogPoints === true,
		supportsFunctionBreakpoints: value.supportsFunctionBreakpoints === true,
		supportsDataBreakpoints: value.supportsDataBreakpoints === true,
		supportsInstructionBreakpoints: value.supportsInstructionBreakpoints === true,
		supportsDisassembleRequest: value.supportsDisassembleRequest === true,
		supportsSteppingGranularity: value.supportsSteppingGranularity === true,
		supportsReadMemoryRequest: value.supportsReadMemoryRequest === true,
		supportsWriteMemoryRequest: value.supportsWriteMemoryRequest === true,
		supportsLoadedSourcesRequest: value.supportsLoadedSourcesRequest === true,
		supportsExceptionInfoRequest: value.supportsExceptionInfoRequest === true,
		supportsCompletionsRequest: value.supportsCompletionsRequest === true,
		supportsCancelRequest: value.supportsCancelRequest === true,
		completionTriggerCharacters: (value.completionTriggerCharacters as string[] | undefined) ?? ['.'],
		exceptionBreakpointFilters:
			(
				value.exceptionBreakpointFilters as { filter: string; label: string; default?: boolean }[] | undefined
			)?.map(value => ({ ...value, default: value.default === true })) ?? [],
	});
	const update = (id: string, patch: Partial<DebugSessionSnapshot>) => {
		const state = session(id);
		state.runtime = {
			...state.runtime,
			...patch,
			inspectionRevision: state.epoch,
			revision: state.runtime.revision + 1,
		};
		if (patch.phase === 'ended' && relations.has(state.publicId) && !relations.get(state.publicId)!.ended)
			end(state.publicId);
	};
	const accept = (id: string, input: IDebugAdapterProcessReadResult): void => {
		const state = session(id);
		for (const entry of input.messages) {
			state.messages.push({ sequence: state.messages.length, direction: 'incoming', message: entry.message });
			const response = entry.message as {
				type?: string;
				request_seq?: number;
				event?: string;
				body?: { reason?: string; threadId?: number; capabilities?: Record<string, unknown> };
			};
			if (response.type === 'event') {
				if (['stopped', 'continued', 'invalidated'].includes(response.event ?? '')) state.epoch++;
				if (response.event === 'invalidated') update(id, {});
				if (response.event === 'breakpoint')
					acceptBreakpoint(
						id,
						(response.body ?? {}) as unknown as { reason: string; breakpoint: Record<string, unknown> },
					);
				if (response.event === 'output') {
					const body = response.body as unknown as {
						output?: string;
						category?: string;
						variablesReference?: number;
					};
					append(state.publicId, body?.output ?? '', body);
				}
				if (response.event === 'initialized') state.initialized = true;
				if (response.event === 'stopped')
					update(id, {
						state: 'stopped',
						reason: response.body?.reason ?? 'paused',
						stoppedThreadId: response.body?.threadId ?? null,
						executionRevision: state.runtime.executionRevision + 1,
					});
				if (response.event === 'continued')
					update(id, {
						state: 'running',
						reason: null,
						executionRevision: state.runtime.executionRevision + 1,
					});
				if (response.event === 'terminated' || response.event === 'exited')
					update(id, { state: 'terminated', phase: 'ended' });
				if (response.event === 'capabilities') {
					Object.assign(state.rawCapabilities, response.body?.capabilities);
					update(id, { capabilities: capabilities(state.rawCapabilities) });
				}
			}
			if (response.type === 'response' && response.request_seq !== undefined) {
				state.responses.set(response.request_seq, response);
				const request = state.requests.get(response.request_seq);
				state.requests.delete(response.request_seq);
				if (request?.repl) {
					const value = response as unknown as {
						success: boolean;
						body?: { result?: string; type?: string; variablesReference?: number };
						message?: string;
					};
					append(
						state.publicId,
						`${value.success ? (value.body?.result ?? '') + (value.body?.type ? ` : ${value.body.type}` : '') : (value.message ?? 'Evaluation failed')}\n`,
						{
							kind: 'evaluation',
							category: value.success ? 'console' : 'stderr',
							variablesReference: value.body?.variablesReference ?? null,
						},
					);
				}
				if ((response as { success?: boolean }).success && request) {
					if (request.command === 'disconnect') update(id, { state: 'terminated', phase: 'ended' });
					else if (
						['continue', 'next', 'stepIn', 'stepOut', 'restart'].includes(request.command) &&
						request.revision === state.runtime.executionRevision
					)
						update(id, {
							state: 'running',
							reason: null,
							executionRevision: state.runtime.executionRevision + 1,
						});
				}
			}
		}
		if (input.exited && input.messages.length < 128) update(id, { state: 'terminated', phase: 'ended' });
		state.status = {
			...input,
			stderr: state.status.stderr + input.stderr,
			exited: input.exited && input.messages.length < 128,
		};
	};
	const pump = async (id: string): Promise<void> => {
		const state = session(id);
		if (state.client) return;
		const input = await read(id, state.rawCursor, 128);
		state.rawCursor = input.nextSequence;
		accept(id, input);
	};
	const workspaces = new Map<string, { snapshot: DebugWorkspaceSnapshot; receipt?: string }>();
	const emptyWorkspace = (): DebugWorkspaceSnapshot => ({
		revision: 0,
		state: {
			breakpoints: [],
			functionBreakpoints: [],
			dataBreakpoints: [],
			watchExpressions: [],
			exceptionBreakpoints: {},
		},
	});
	const managed: IDebugAdapterProcessService = {
		prepareSession: async (id, noDebug) => {
			const relation = relations.get(id);
			if (!relation || relation.ended) throw new Error('Fixture session admission ended');
			const prepared = {
				...relation,
				noDebug: noDebug ?? null,
				consoleCatalogRevision: catalogRevision,
				consoleIds: consoleIds(),
			};
			relations.set(id, prepared);
			return prepared;
		},
		reserveSession: async options => {
			const parent = options.parentId ? relations.get(options.parentId) : undefined;
			if (options.parentId && (!parent || parent.ended)) throw new Error('Parent debug session ended');
			const relation: DebugSessionRelation = {
				id: options.id,
				parentId: options.parentId,
				consoleId: options.mergeConsole && parent ? parent.consoleId : options.id,
				lifecycleTargetId: options.lifecycleManagedByParent && parent ? parent.lifecycleTargetId : options.id,
				noDebug: options.noDebug ?? parent?.noDebug ?? null,
				ended: false,
				descendants: [],
				consoleCatalogRevision: ++catalogRevision,
				consoleIds: [...new Set([...relations.values()].map(value => value.consoleId).concat(options.id))],
			};
			relations.set(options.id, relation);
			return relation;
		},
		manageSession: async (id, action) => {
			if (action === 'end') return end(id);
			const value = relations.get(id);
			if (!value) throw new Error('Fixture session admission not found');
			return { ...value, consoleCatalogRevision: catalogRevision, consoleIds: consoleIds() };
		},
		readConsole: async (id, options) => {
			if (options?.clear)
				consoles.set(relations.get(id)?.consoleId ?? id, {
					revision: consoleFor(id).revision + 1,
					entries: [],
				});
			if (options?.diagnostic) append(id, options.diagnostic);
			return consoleFor(id);
		},
		readWorkspaceState: async (id, legacy) => {
			let current = workspaces.get(id);
			if (legacy) {
				const receipt = JSON.stringify(legacy);
				if (current?.receipt === receipt) return { status: 'current', snapshot: current.snapshot };
				if (current && JSON.stringify(current.snapshot.state) !== receipt)
					return { status: 'conflict', snapshot: current.snapshot };
				current = { snapshot: current?.snapshot ?? { revision: 1, state: structuredClone(legacy) }, receipt };
				workspaces.set(id, current);
			}
			return { status: legacy ? 'applied' : 'current', snapshot: current?.snapshot ?? emptyWorkspace() };
		},
		editWorkspaceState: async (id, revision, edits) => {
			const current = workspaces.get(id) ?? { snapshot: emptyWorkspace() };
			if (current.snapshot.revision !== revision) return { status: 'conflict', snapshot: current.snapshot };
			const state = structuredClone(current.snapshot.state) as {
				-readonly [K in keyof DebugWorkspaceState]: DebugWorkspaceState[K];
			};
			for (const edit of edits) applyWorkspaceEdit(state, edit);
			current.snapshot = { revision: revision + 1, state };
			workspaces.set(id, current);
			return { status: 'applied', snapshot: current.snapshot };
		},
		start: async options => {
			const id = await start(options);
			sessions.set(id, {
				nextRequest: 1,
				rawCursor: 0,
				client: options.connection?.type === 'client',
				messages: [],
				responses: new Map(),
				status: empty,
				publicId: id,
				bp: { revision: 0, version: 0, appliedVersion: 0, bindings: [], error: null },
				sources: new Map(),
				bpQueue: Promise.resolve(),
				nextInspection: 1,
				inspections: new Map(),
				epoch: 0,
				requests: new Map(),
				rawCapabilities: {},
				initialized: false,
				runtime: {
					revision: 0,
					executionRevision: 0,
					inspectionRevision: 0,
					state: 'starting',
					phase: 'uninitialized',
					reason: null,
					stoppedThreadId: null,
					capabilities: capabilities({}),
				},
			});
			return id;
		},
		send: async (id, message) => {
			const state = session(id);
			state.messages.push({ sequence: state.messages.length, direction: 'outgoing', message });
			if (!state.client) await send(id, message);
		},
		initializeSession: async (id, options) => {
			update(id, { phase: 'initializing' });
			const state = session(id);
			state.noDebug = options.arguments.noDebug === true;
			state.publicId = options.publicId;
			state.adapterId = options.adapterId;
			const task = async () => {
				const initialized = await request(id, 'initialize', {
					clientID: 'ash',
					clientName: 'Ash Code',
					adapterID: options.adapterId,
					pathFormat: 'path',
					linesStartAt1: true,
					columnsStartAt1: true,
					supportsVariableType: true,
					supportsVariablePaging: true,
					supportsMemoryReferences: true,
					supportsRunInTerminalRequest: options.runInTerminal,
					supportsArgsCanBeInterpretedByShell: options.runInTerminal,
					supportsStartDebuggingRequest: options.startDebugging,
				});
				Object.assign(state.rawCapabilities, initialized.body);
				update(id, { capabilities: capabilities(state.rawCapabilities) });
				state.launch = request(id, options.request, options.arguments);
				void state.launch.catch(error => update(id, { state: 'error', phase: 'ended', reason: String(error) }));
				while (!state.initialized && state.runtime.phase !== 'ended')
					await new Promise(resolve => setTimeout(resolve, 1));
				if (state.runtime.phase !== 'ended') update(id, { phase: 'configuring' });
			};
			void task().catch(error => update(id, { state: 'error', phase: 'ended', reason: String(error) }));
		},
		completeConfiguration: async (id, exceptionFilters) => {
			const state = session(id);
			update(id, { phase: 'launching' });
			const task = async () => {
				const filters = state.runtime.capabilities.exceptionBreakpointFilters;
				const selected = [
					...new Set(
						(exceptionFilters ?? filters.filter(filter => filter.default).map(filter => filter.filter))
							.map(filter => filter.trim())
							.filter(Boolean),
					),
				];
				if (!state.noDebug && selected.some(filter => !filters.some(candidate => candidate.filter === filter)))
					throw new Error('Invalid exception filter');
				await request(id, 'setExceptionBreakpoints', { filters: state.noDebug ? [] : selected });
				exceptions.set(id, {
					version: 1,
					appliedVersion: 1,
					appliedFilters: selected,
					filters: selected,
					error: null,
				});
				if (state.rawCapabilities.supportsConfigurationDoneRequest === true)
					await request(id, 'configurationDone');
				await state.launch;
				if (state.runtime.phase !== 'ended')
					update(id, {
						phase: 'active',
						...(state.runtime.state === 'starting' ? { state: 'running' } : {}),
					});
			};
			void task().catch(error => update(id, { state: 'error', phase: 'ended', reason: String(error) }));
		},
		setExceptionBreakpoints: async (id, filters) => {
			const state = session(id);
			const selected = [...new Set(filters.map(filter => filter.trim()).filter(Boolean))];
			if (
				!state.noDebug &&
				selected.some(
					filter =>
						!state.runtime.capabilities.exceptionBreakpointFilters.some(value => value.filter === filter),
				)
			)
				throw new Error('Invalid exception filter');
			await request(id, 'setExceptionBreakpoints', { filters: state.noDebug ? [] : selected });
			const version = (exceptions.get(id)?.version ?? 0) + 1;
			exceptions.set(id, {
				version,
				appliedVersion: version,
				appliedFilters: selected,
				filters: selected,
				error: null,
			});
			return version;
		},
		setBreakpoints: async (id, version, intents) => {
			const state = session(id);
			const old = state.bp.bindings;
			state.bp = {
				revision: state.bp.revision + 1,
				version,
				appliedVersion: state.bp.appliedVersion,
				error: null,
				bindings: intents.map(
					intent =>
						(() => {
							const oldPoint = old.find(
								value => JSON.stringify(value.intent) === JSON.stringify(intent) && !value.removed,
							);
							return oldPoint ? { ...oldPoint, created: false } : undefined;
						})() ?? {
							intent,
							verified: false,
							applicable: true,
							pending: true,
							removed: false,
							created: false,
							unsupported: null,
							message: null,
							protocol: null,
						},
				),
			};
			state.bpQueue = state.bpQueue
				.then(async () => {
					if (state.closed) return;
					const groups = new Map<
						string,
						{ source?: unknown; command: string; points: DebugBreakpointIntent[] }
					>();
					for (const [key, location] of state.sources)
						if (location.kind === 'source')
							groups.set(key, { source: location.source, command: 'setBreakpoints', points: [] });
					const caps = state.runtime.capabilities;
					for (const intent of intents) {
						const location = intent.location;
						const applies =
							location.kind === 'data'
								? location.canPersist
									? location.adapterType === state.adapterId
									: location.sessionId === state.publicId
								: location.kind !== 'instruction' || location.sessionId === state.publicId;
						if (!intent.enabled || state.noDebug || !applies) {
							state.bp = {
								...state.bp,
								revision: state.bp.revision + 1,
								bindings: state.bp.bindings.map(binding =>
									binding.intent.id === intent.id
										? {
												...binding,
												pending: false,
												applicable: applies && !state.noDebug,
												protocol: null,
												verified: false,
											}
										: binding,
								),
							};
							continue;
						}
						const command =
							location.kind === 'source'
								? 'setBreakpoints'
								: location.kind === 'function'
									? 'setFunctionBreakpoints'
									: location.kind === 'data'
										? 'setDataBreakpoints'
										: 'setInstructionBreakpoints';
						const key = location.kind === 'source' ? JSON.stringify(location.source) : command;
						if (location.kind === 'source')
							groups.set(key, groups.get(key) ?? { command, source: location.source, points: [] });
						const unsupported: DebugBreakpointUnsupported | null =
							intent.condition && !caps.supportsConditionalBreakpoints
								? 'conditional'
								: intent.hitCondition && !caps.supportsHitConditionalBreakpoints
									? 'hitConditional'
									: intent.logMessage && !caps.supportsLogPoints
										? 'logPoint'
										: location.kind === 'function' && !caps.supportsFunctionBreakpoints
											? 'function'
											: location.kind === 'data' && !caps.supportsDataBreakpoints
												? 'data'
												: location.kind === 'instruction' &&
													  !caps.supportsInstructionBreakpoints
													? 'instruction'
													: null;
						if (unsupported) {
							state.bp = {
								...state.bp,
								bindings: state.bp.bindings.map(value =>
									value.intent.id === intent.id
										? { ...value, unsupported, pending: false, verified: false, protocol: null }
										: value,
								),
								revision: state.bp.revision + 1,
							};
							continue;
						}
						const group = groups.get(key) ?? { command, points: [] };
						group.points.push(intent);
						groups.set(key, group);
						if (location.kind === 'source') state.sources.set(key, location);
					}
					if (!state.noDebug)
						for (const [command, supported] of [
							['setFunctionBreakpoints', caps.supportsFunctionBreakpoints],
							['setDataBreakpoints', caps.supportsDataBreakpoints],
							['setInstructionBreakpoints', caps.supportsInstructionBreakpoints],
						] as const)
							if (supported && !groups.has(command)) groups.set(command, { command, points: [] });
					for (const [key, group] of groups) {
						const result = await request(id, group.command, {
							...(group.source ? { source: group.source } : {}),
							breakpoints: group.points.map(pointArguments),
						});
						const values = result.body?.breakpoints as unknown[] | undefined;
						state.bp = {
							...state.bp,
							revision: state.bp.revision + 1,
							bindings: state.bp.bindings.map(binding => {
								const index = group.points.findIndex(
									point => JSON.stringify(point) === JSON.stringify(binding.intent),
								);
								if (index < 0) return binding;
								const protocol = values?.[index] as
									{ verified?: boolean; message?: string } | undefined;
								return {
									...binding,
									pending: false,
									protocol: protocol ?? null,
									verified: protocol?.verified === true,
									message: protocol?.message ?? null,
								};
							}),
						};
						if (group.source && !group.points.length) state.sources.delete(key);
					}
					state.bp = { ...state.bp, revision: state.bp.revision + 1, appliedVersion: version };
				})
				.catch(error => {
					state.bp = {
						...state.bp,
						error: String(error),
						appliedVersion: version,
						revision: state.bp.revision + 1,
					};
				});
		},
		readBreakpoints: async id => {
			await pump(id);
			return session(id).bp;
		},
		startInspection: async (id, query) => {
			const state = session(id);
			const inspectionId = state.nextInspection++;
			const entry = { epoch: state.epoch, result: { state: 'pending' } as DebugInspectionResult };
			state.inspections.set(inspectionId, entry);
			void inspect(id, query).then(
				value => {
					entry.result = { state: 'complete', value };
				},
				error => {
					entry.result = { state: 'failed', message: String(error) };
				},
			);
			return inspectionId;
		},
		readInspection: async (id, inspectionId) => {
			await pump(id);
			const state = session(id);
			const entry = state.inspections.get(inspectionId)!;
			return entry.epoch === state.epoch ? entry.result : { state: 'invalidated' };
		},
		startRequest: async (id, command, args) => {
			const state = session(id);
			const request = state.nextRequest++;
			const repl = command === 'evaluate' && (args as { context?: string } | undefined)?.context === 'repl';
			state.requests.set(request, { command, revision: state.runtime.executionRevision, repl });
			if (repl) append(state.publicId, `> ${(args as { expression: string }).expression}\n`, { kind: 'input' });
			await managed.send(id, {
				seq: request,
				type: 'request',
				command,
				...(args === undefined ? {} : { arguments: args }),
			});
			return request;
		},
		readResponse: async (id, request) => {
			await pump(id);
			const state = session(id);
			if (!state.responses.has(request)) return { state: 'pending' };
			const response = state.responses.get(request);
			state.responses.delete(request);
			return { state: 'complete', response };
		},
		acceptInput: async (id, input) => {
			accept(id, input);
		},
		read: async (id, afterSequence, maxMessages) => {
			await pump(id);
			const state = session(id);
			const messages = state.messages.slice(afterSequence, afterSequence + maxMessages);
			const result = {
				...state.status,
				session: state.runtime,
				consoleRevision: consoleFor(state.publicId).revision,
				exceptions: exceptions.get(id),
				breakpointRevision: state.bp.revision,
				messages,
				nextSequence: messages.at(-1)?.sequence !== undefined ? messages.at(-1)!.sequence + 1 : afterSequence,
			};
			state.status = { ...state.status, stderr: '' };
			return result;
		},
		close: async id => {
			const state = sessions.get(id);
			if (state) state.closed = true;
			await close(id);
		},
		getConnectionState: transport.getConnectionState.bind(transport),
		onConnectionState: transport.onConnectionState.bind(transport),
	};
	const request = async (
		id: string,
		command: string,
		args?: unknown,
	): Promise<{ body?: Record<string, unknown> }> => {
		if (session(id).closed) throw new Error('Fixture session closed');
		const request = await managed.startRequest(id, command, args);
		while (!session(id).closed) {
			const response = await managed.readResponse(id, request);
			if (response.state === 'complete') {
				const result = response.response as {
					success: boolean;
					message?: string;
					body?: Record<string, unknown>;
				};
				if (!result.success) throw new Error(result.message);
				return result;
			}
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		throw new Error('Fixture session closed');
	};
	const pointArguments = (intent: DebugBreakpointIntent): Record<string, unknown> => {
		const location = intent.location;
		return {
			...(location.kind === 'source'
				? { line: location.line, ...(location.column === undefined ? {} : { column: location.column }) }
				: location.kind === 'function'
					? { name: location.name }
					: location.kind === 'data'
						? { dataId: location.dataId, accessType: location.accessType }
						: {
								instructionReference: location.instructionReference,
								...(location.offset === undefined ? {} : { offset: location.offset }),
							}),
			...(intent.condition === undefined ? {} : { condition: intent.condition }),
			...(intent.hitCondition === undefined ? {} : { hitCondition: intent.hitCondition }),
			...(intent.logMessage === undefined ? {} : { logMessage: intent.logMessage }),
		};
	};
	const acceptBreakpoint = (id: string, event: { reason: string; breakpoint: Record<string, unknown> }) => {
		const state = session(id);
		const protocol = event.breakpoint;
		if (!protocol) return;
		let matched = false;
		let bindings = state.bp.bindings.map(binding => {
			if (
				protocol.id === undefined ||
				!binding.intent.enabled ||
				binding.removed ||
				(binding.protocol as { id?: unknown } | null)?.id !== protocol.id
			)
				return binding;
			matched = true;
			return {
				...binding,
				pending: false,
				protocol: event.reason === 'removed' ? null : protocol,
				removed: event.reason === 'removed',
				verified: event.reason !== 'removed' && protocol.verified === true,
				message: typeof protocol.message === 'string' ? protocol.message : null,
			};
		});
		if (event.reason === 'removed')
			for (const binding of bindings) {
				if (binding.removed && binding.intent.location.kind === 'source') {
					const key = JSON.stringify(binding.intent.location.source);
					if (
						!bindings.some(
							point =>
								!point.removed &&
								point.intent.location.kind === 'source' &&
								JSON.stringify(point.intent.location.source) === key,
						)
					)
						state.sources.delete(key);
				}
			}
		const inputSource = protocol.source as { path?: string; sourceReference?: number } | undefined;
		const source = inputSource
			? {
					...(inputSource.path === undefined ? {} : { path: inputSource.path }),
					...(inputSource.sourceReference === undefined
						? {}
						: { sourceReference: inputSource.sourceReference }),
				}
			: undefined;
		if (
			!matched &&
			event.reason === 'new' &&
			source &&
			(source.path || source.sourceReference) &&
			Number.isSafeInteger(protocol.line)
		) {
			const intent: DebugBreakpointIntent = {
				id: `${state.publicId}:adapter-breakpoint-${bindings.length}`,
				enabled: true,
				location: {
					kind: 'source',
					source,
					line: protocol.line as number,
					...(protocol.column === undefined ? {} : { column: protocol.column as number }),
				},
			};
			bindings = [
				...bindings,
				{
					intent,
					protocol,
					removed: false,
					created: true,
					applicable: true,
					pending: false,
					verified: protocol.verified === true,
					unsupported: null,
					message: null,
				},
			];
			state.sources.set(JSON.stringify(source), intent.location);
		}
		state.bp = { ...state.bp, bindings, revision: state.bp.revision + 1 };
	};
	const inspect = async (id: string, query: DebugInspection): Promise<DebugInspectionValue> => {
		if (query.kind === 'stack') {
			const threads = (await request(id, 'threads')).body?.threads as { id: number }[];
			const selected = threads.find(thread => thread.id === query.threadId) ?? threads[0];
			const frames = selected
				? ((await request(id, 'stackTrace', { threadId: selected.id, startFrame: 0, levels: 100 })).body
						?.stackFrames as unknown[])
				: [];
			return { kind: 'stack', threads, frames, threadId: selected?.id ?? null };
		}
		if (query.kind === 'frame') {
			const scopes = (await request(id, 'scopes', { frameId: query.frameId })).body?.scopes as {
				variablesReference: number;
				expensive?: boolean;
			}[];
			const initial = scopes.find(scope => !scope.expensive && scope.variablesReference > 0);
			return {
				kind: 'frame',
				scopes: await Promise.all(
					scopes.map(async scope => ({
						scope,
						variables:
							scope === initial
								? ((await request(id, 'variables', { variablesReference: scope.variablesReference }))
										.body?.variables as unknown[])
								: [],
						variablesLoaded: scope === initial,
						error: null,
					})),
				),
			};
		}
		if (query.kind === 'variables')
			return {
				kind: 'variables',
				variables: (await request(id, 'variables', { variablesReference: query.variablesReference })).body
					?.variables as unknown[],
			};
		return {
			kind: 'watch',
			values: await Promise.all(
				query.expressions.map(async expression => {
					try {
						return {
							expression,
							result: (
								await request(id, 'evaluate', {
									expression,
									context: 'watch',
									...(query.frameId === undefined ? {} : { frameId: query.frameId }),
								})
							).body,
							error: null,
						};
					} catch (error) {
						return { expression, result: null, error: String(error) };
					}
				}),
			),
		};
	};
	return Object.assign(transport, managed);
}

function applyWorkspaceEdit(
	state: { -readonly [K in keyof DebugWorkspaceState]: DebugWorkspaceState[K] },
	edit: DebugWorkspaceEdit,
): void {
	if (edit.kind === 'clearBreakpoints') {
		state.breakpoints = [];
		state.functionBreakpoints = [];
		state.dataBreakpoints = [];
	} else if (edit.kind === 'setEnabled') {
		state.breakpoints = state.breakpoints.map(point => ({ ...point, enabled: edit.enabled }));
		state.functionBreakpoints = state.functionBreakpoints.map(point => ({ ...point, enabled: edit.enabled }));
		state.dataBreakpoints = state.dataBreakpoints.map(point => ({ ...point, enabled: edit.enabled }));
	} else if (edit.kind === 'source')
		state.breakpoints = [...state.breakpoints.filter(point => point.id !== edit.point.id), edit.point];
	else if (edit.kind === 'function')
		state.functionBreakpoints = [
			...state.functionBreakpoints.filter(point => point.id !== edit.point.id),
			edit.point,
		];
	else if (edit.kind === 'data')
		state.dataBreakpoints = [...state.dataBreakpoints.filter(point => point.id !== edit.point.id), edit.point];
	else if (edit.kind === 'remove') {
		state.breakpoints = state.breakpoints.filter(point => !edit.ids.includes(point.id));
		state.functionBreakpoints = state.functionBreakpoints.filter(point => !edit.ids.includes(point.id));
		state.dataBreakpoints = state.dataBreakpoints.filter(point => !edit.ids.includes(point.id));
	} else if (edit.kind === 'addWatch')
		state.watchExpressions = [...new Set([...state.watchExpressions, edit.expression])];
	else if (edit.kind === 'removeWatch')
		state.watchExpressions = state.watchExpressions.filter(value => value !== edit.expression);
	else if (edit.kind === 'exceptions')
		state.exceptionBreakpoints = { ...state.exceptionBreakpoints, [edit.adapterType]: [...edit.filters] };
}
