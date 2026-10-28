export type BuildKind = 'extension' | 'demo';
export function allowedBuildPath(kind: BuildKind, path: string): boolean;
export function readBuild(directory: string, kind: BuildKind): Promise<Map<string, Buffer>>;
export function verifyManifest(manifest: unknown, files: ReadonlyMap<string, unknown>): void;
export function verifyHtml(html: string, files: ReadonlyMap<string, unknown>, base?: string): void;
export function verifyBuilds(): Promise<void>;
