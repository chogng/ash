/** Scalar values accepted from administrator and account policy sources. */
export type PolicyValue = string | number | boolean;

/** Provider-delivered managed fields, before configuration-specific mapping. */
export type ManagedSettingsData = Readonly<Record<string, PolicyValue>>;

/** Scalar schema declared for one provider-managed field. */
export interface IManagedSettingPolicyDefinition {
	readonly type: 'string' | 'number' | 'boolean';
}

export type IManagedSettingsPolicyDefinitions = Readonly<Record<string, IManagedSettingPolicyDefinition>>;
