export interface LocalSessionRecord { version: 1; pid: number; port: number; token: string }
export interface LocalSessionReadOptions { verifyWindowsPrivacy?: (path: string, kind: "file") => unknown }
export declare const LOCAL_SESSION_FILE: string;
export declare function localSessionPath(dataDirectory: string): string;
export declare function parseLocalSession(value: unknown): LocalSessionRecord;
export declare function readLocalSession(dataDirectory: string, options?: LocalSessionReadOptions): Promise<LocalSessionRecord | null>;
export declare function localSessionFor(dataDirectory: string, running: { port: number; body: unknown } | null, options?: LocalSessionReadOptions): Promise<string | null>;
