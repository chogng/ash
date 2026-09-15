export interface PackageManagerSpec {
  name: string;
  version: string;
}

export function parsePackageManagerSpec(value: string): PackageManagerSpec {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid packageManager value: ${value}`);
  }
  return { name: value.slice(0, separator), version: value.slice(separator + 1) };
}

export function validatePackageManager(userAgent: string | undefined, expected: PackageManagerSpec): void {
  const actual = userAgent?.split(" ", 1)[0];
  const required = `${expected.name}/${expected.version}`;
  if (actual !== required) {
    throw new Error(`Use ${expected.name}@${expected.version}; received ${actual ?? "no package manager"}. Install it with npm install -g ${expected.name}@${expected.version}.`);
  }
}
