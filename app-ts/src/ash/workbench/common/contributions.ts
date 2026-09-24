import {
	Disposable,
	type IDisposable,
	toDisposable,
} from "../../base/common/lifecycle.js";
import type {
	ServicesAccessor,
} from "../../platform/instantiation/common/instantiation.js";

/** Startup point at which a workbench contribution is instantiated. */
export enum WorkbenchPhase {
	BlockStartup = 1,
	BlockRestore,
	AfterRestored,
	Eventually,
}

/**
 * A window-scoped feature created and owned by the workbench.
 *
 * Implementations should install their listeners and projections during
 * construction and release all window-owned state from `dispose`.
 */
export interface IWorkbenchContribution extends IDisposable {}

/** Creates one contribution from the services of a workbench window. */
export type WorkbenchContributionFactory =
	(accessor: ServicesAccessor) => IWorkbenchContribution;

interface IWorkbenchContributionRegistration {
	readonly id: string;
	readonly phase: WorkbenchPhase;
	readonly factory: WorkbenchContributionFactory;
	readonly order: number;
}

/**
 * Realm-wide declarations used to create a separate contribution host for
 * each workbench window.
 */
export class WorkbenchContributionRegistry {
	private readonly registrations =
		new Map<string, IWorkbenchContributionRegistration>();
	private nextOrder = 1;

	register(
		id: string,
		phase: WorkbenchPhase,
		factory: WorkbenchContributionFactory,
	): IDisposable {
		const registration = this.add(id, phase, factory);
		return toDisposable(() => {
			if (this.registrations.get(id) === registration) {
				this.registrations.delete(id);
			}
		});
	}

	/** Registers a declaration that intentionally lives for the realm. */
	registerStatic(
		id: string,
		phase: WorkbenchPhase,
		factory: WorkbenchContributionFactory,
	): void {
		this.add(id, phase, factory);
	}

	private add(
		id: string,
		phase: WorkbenchPhase,
		factory: WorkbenchContributionFactory,
	): IWorkbenchContributionRegistration {
		validateContributionId(id);
		validateWorkbenchPhase(phase);
		if (this.registrations.has(id)) {
			throw new Error(`Workbench contribution is already registered: ${id}`);
		}
		const registration: IWorkbenchContributionRegistration = {
			id,
			phase,
			factory,
			order: this.nextOrder++,
		};
		this.registrations.set(id, registration);
		return registration;
	}

	/**
	 * Creates a window host from the contributions registered at this moment.
	 */
	createHost(
		accessor: ServicesAccessor,
		onError: WorkbenchContributionErrorHandler = defaultErrorHandler,
	): WorkbenchContributionHost {
		return new WorkbenchContributionHost(
			accessor,
			[...this.registrations.values()].sort(
				(left, right) => left.order - right.order,
			),
			onError,
		);
	}
}

/** Receives an isolated contribution construction failure. */
export type WorkbenchContributionErrorHandler = (
	error: unknown,
	contributionId: string,
) => void;

/**
 * Owns the contribution instances of one workbench window and advances their
 * startup phases monotonically.
 */
export class WorkbenchContributionHost extends Disposable {
	private readonly accessor: ServicesAccessor;
	private readonly registrations:
		readonly IWorkbenchContributionRegistration[];
	private readonly onError: WorkbenchContributionErrorHandler;
	private readonly instantiated = new Set<string>();
	private _phase = 0;

	constructor(
		accessor: ServicesAccessor,
		registrations: readonly IWorkbenchContributionRegistration[],
		onError: WorkbenchContributionErrorHandler,
	) {
		super();
		this.accessor = accessor;
		this.registrations = registrations;
		this.onError = onError;
	}

	get phase(): WorkbenchPhase | undefined {
		return this._phase === 0
			? undefined
			: this._phase as WorkbenchPhase;
	}

	/**
	 * Instantiates every pending contribution through the requested phase.
	 */
	advance(phase: WorkbenchPhase): void {
		validateWorkbenchPhase(phase);
		if (phase < this._phase) {
			throw new Error("Workbench contribution phases cannot move backwards");
		}
		if (phase === this._phase) return;
		this._phase = phase;

		for (const registration of this.registrations) {
			if (
				registration.phase > phase ||
				this.instantiated.has(registration.id)
			) {
				continue;
			}
			this.instantiated.add(registration.id);
			try {
				this._register(registration.factory(this.accessor));
			} catch (error) {
				this.onError(error, registration.id);
			}
		}
	}
}

/** Realm-wide workbench contribution declarations. */
export const WorkbenchContributionsRegistry =
	new WorkbenchContributionRegistry();

/**
 * Registers a process-lifetime contribution declaration.
 *
 * Contribution modules should call this during module evaluation, before a
 * workbench host is created.
 */
export function registerWorkbenchContribution(
	id: string,
	phase: WorkbenchPhase,
	factory: WorkbenchContributionFactory,
): void {
	WorkbenchContributionsRegistry.registerStatic(id, phase, factory);
}

function validateContributionId(id: string): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id)) {
		throw new TypeError(`Invalid workbench contribution ID: ${id}`);
	}
}

function validateWorkbenchPhase(phase: WorkbenchPhase): void {
	if (
		!Number.isInteger(phase) ||
		phase < WorkbenchPhase.BlockStartup ||
		phase > WorkbenchPhase.Eventually
	) {
		throw new TypeError(`Invalid workbench phase: ${phase}`);
	}
}

function defaultErrorHandler(
	error: unknown,
	contributionId: string,
): void {
	console.error(
		`Unable to create workbench contribution '${contributionId}'`,
		error,
	);
}
