export interface FsLike {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync?: (path: string) => void;
  sleepSync?: (ms: number) => void;
}

export type JsonObject = Record<string, unknown>;

export type JsonObjectUpdate<T> = {
  document: JsonObject;
  result: T;
};

export class JsonFileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonFileConflictError";
  }
}

const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const TRANSIENT_RENAME_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "ENOTEMPTY",
  "EPERM",
]);
const MAX_CONFLICT_RETRIES = 2;

let tempSequence = 0;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as Error & { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSource(fs: FsLike, path: string): string | undefined {
  if (!fs.existsSync(path)) return undefined;
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function parseJsonObject(source: string | undefined, path: string): JsonObject {
  if (source === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid JSON object in ${path}`);
  }
  return parsed as JsonObject;
}

function readSnapshot(fs: FsLike, path: string): {
  document: JsonObject;
  source: string | undefined;
} {
  const source = readSource(fs, path);
  return { document: parseJsonObject(source, path), source };
}

function pause(fs: FsLike, ms: number): void {
  if (fs.sleepSync) {
    fs.sleepSync(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function discardTempFile(fs: FsLike, path: string): boolean {
  if (!fs.unlinkSync) return false;
  try {
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function conflictError(fs: FsLike, path: string, tempPath: string): JsonFileConflictError {
  const removed = discardTempFile(fs, tempPath);
  const recoveryHint = removed ? "" : `; temporary file remains at ${tempPath}`;
  return new JsonFileConflictError(
    `${path} changed while it was being updated; retry the operation${recoveryHint}`,
  );
}

function assertUnchanged(
  fs: FsLike,
  path: string,
  expectedSource: string | undefined,
  tempPath: string,
): void {
  if (readSource(fs, path) !== expectedSource) {
    throw conflictError(fs, path, tempPath);
  }
}

function tempPathFor(path: string, pid: number): string {
  tempSequence += 1;
  return `${path}.tmp-${pid}-${Date.now().toString(36)}-${tempSequence}`;
}

export function readJsonObjectLenient(fs: FsLike, path: string): JsonObject {
  try {
    return parseJsonObject(readSource(fs, path), path);
  } catch {
    return {};
  }
}

export function writeJsonObjectAtomic(
  fs: FsLike,
  path: string,
  document: JsonObject,
  pid: number,
  expectedSource: string | undefined,
): void {
  const tempPath = tempPathFor(path, pid);
  fs.writeFileSync(tempPath, JSON.stringify(document, null, 2), "utf8");
  assertUnchanged(fs, path, expectedSource, tempPath);

  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      fs.renameSync(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      if (
        !code ||
        !TRANSIENT_RENAME_ERROR_CODES.has(code) ||
        attempt === RENAME_RETRY_DELAYS_MS.length
      ) {
        break;
      }
      pause(fs, RENAME_RETRY_DELAYS_MS[attempt]!);
      assertUnchanged(fs, path, expectedSource, tempPath);
    }
  }

  throw new Error(
    `failed to replace ${path}: ${errorMessage(lastError)}; recovery file: ${tempPath}`,
  );
}

export function updateJsonObjectAtomic<T>(
  fs: FsLike,
  path: string,
  pid: number,
  update: (document: JsonObject) => JsonObjectUpdate<T>,
): T {
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const snapshot = readSnapshot(fs, path);
    const next = update(snapshot.document);
    try {
      writeJsonObjectAtomic(fs, path, next.document, pid, snapshot.source);
      return next.result;
    } catch (error) {
      if (!(error instanceof JsonFileConflictError) || attempt === MAX_CONFLICT_RETRIES) {
        throw error;
      }
    }
  }
  throw new Error(`failed to update ${path}`);
}
