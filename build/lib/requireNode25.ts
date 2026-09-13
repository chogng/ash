export function requireNode25(): void {
  if (Number(process.versions.node.split('.')[0]) !== 25) {
    throw new Error(`Ash requires Node 25; found ${process.version}. Run nvm use in the repository root.`);
  }
}
