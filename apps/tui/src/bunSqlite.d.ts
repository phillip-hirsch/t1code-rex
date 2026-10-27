// The slice of `bun:sqlite` that prefsLock.ts uses. The TUI's tsconfig loads Node's types only.
declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { readonly create?: boolean });
    run(sql: string): void;
    close(): void;
  }
}
