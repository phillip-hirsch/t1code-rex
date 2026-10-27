// The slice of Bun's runtime plugin API that terminalEmulator.ts uses. The TUI's tsconfig
// loads Node's types only.
declare module "bun" {
  interface OnResolveArgs {
    readonly path: string;
    readonly importer: string;
  }
  interface OnLoadArgs {
    readonly path: string;
  }
  interface PluginBuilder {
    onResolve(
      constraints: { readonly filter: RegExp; readonly namespace?: string },
      callback: (args: OnResolveArgs) => { path: string; namespace?: string } | undefined,
    ): void;
    onLoad(
      constraints: { readonly filter: RegExp; readonly namespace?: string },
      callback: (args: OnLoadArgs) => { contents: string; loader: "js" },
    ): void;
  }
  export function plugin(options: {
    readonly name: string;
    setup(builder: PluginBuilder): void;
  }): void;
}
