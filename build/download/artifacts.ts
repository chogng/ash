import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface LockedFile {
  readonly url: string;
  readonly sha256: string;
  readonly size?: number;
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
}

async function publish(partial: string, destination: string, digest: string): Promise<void> {
  try {
    if (await sha256(destination) === digest) return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    await rename(partial, destination);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES"))
      || await sha256(destination) !== digest) throw error;
  }
}

export async function materialize(artifact: LockedFile, destination: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > maxBytes))) {
    throw new Error("Invalid locked download size or SHA-256");
  }
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile()) throw new Error(`Download cache is not a regular file: ${destination}`);
    if (metadata.size <= maxBytes && (artifact.size === undefined || metadata.size === artifact.size)
      && await sha256(destination) === artifact.sha256) return destination;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  try {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Could not download ${artifact.url}: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      const output = await open(partial, "wx");
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > (artifact.size ?? maxBytes)) throw new Error(`Download exceeds size limit: ${destination}`);
          hash.update(value);
          await output.writeFile(value);
        }
      } finally {
        await output.close();
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if ((artifact.size !== undefined && size !== artifact.size) || hash.digest("hex") !== artifact.sha256) {
      throw new Error(`Download failed locked size or SHA-256 validation: ${destination}`);
    }
    await publish(partial, destination, artifact.sha256);
    return destination;
  } finally {
    await rm(partial, { force: true });
  }
}

export async function extractMember(archive: string, member: string, destination: string, maxBytes: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${randomUUID()}`;
  const child = spawn("tar", ["-xOf", archive, member], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let diagnostics = "";
  child.stderr.on("data", (block: Buffer) => { diagnostics = (diagnostics + block.toString()).slice(-4096); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Could not extract ${member}: ${diagnostics}`)));
  });
  let size = 0;
  const limit = new Transform({
    transform(block: Buffer, _encoding, callback) {
      size += block.length;
      callback(size > maxBytes ? new Error(`Archive member exceeds size limit: ${member}`) : null, block);
    },
  });
  const transfer = pipeline(child.stdout, limit, createWriteStream(partial, { flags: "wx" }));
  try {
    await Promise.all([completion, transfer]);
    await publish(partial, destination, await sha256(partial));
  } catch (error) {
    child.kill();
    await Promise.allSettled([completion, transfer]);
    throw error;
  } finally {
    await rm(partial, { force: true });
  }
}
