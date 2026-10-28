export declare const archivePath: string;
export function verifyArtifactContent(files: ReadonlyMap<string, Buffer>): void;
export function inspectArchive(
  bytes: Uint8Array,
  expected: ReadonlyMap<string, Buffer>,
): Map<string, Buffer>;
export function verifyArchive(path?: string): Promise<Map<string, Buffer>>;
