export interface IPropertyData {
	classification: 'SystemMetaData' | 'CallstackOrException' | 'CustomerContent' | 'PublicNonPersonalData' | 'EndUserPseudonymizedInformation';
	purpose: 'PerformanceAndHealth' | 'FeatureInsight' | 'BusinessInsight';
	comment: string;
	isMeasurement?: boolean;
}

export interface IGDPRProperty {
	owner: string;
	comment: string;
	expiration?: string;
	readonly [name: string]: IPropertyData | IGDPRProperty | string | undefined;
}

export type OmitMetadata<T> = Omit<T, 'owner' | 'comment' | 'expiration'>;
export type ClassifiedEvent<T> = { [K in keyof T]: unknown };
export type StrictPropertyCheck<T extends IGDPRProperty, E> = Exclude<keyof E, keyof OmitMetadata<T>> extends never
	? Exclude<keyof OmitMetadata<T>, keyof E> extends never ? E : { error: 'Type of classified event does not match event properties' }
	: { error: 'Type of classified event does not match event properties' };
