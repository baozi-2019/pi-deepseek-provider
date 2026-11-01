/**
 * Minimal compile-time stubs for the host-provided peer packages.
 *
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are bundled
 * with the host pi process and intentionally NOT installed in this repo (see
 * tests/test-package-manifest.ts which enforces it). These stubs exist solely
 * so the extension can be type-checked by `tsc --noEmit`; at runtime pi
 * resolves the real modules. Keep the declarations in sync with the actual
 * usage — they intentionally cover only what this extension calls, not the
 * full host API.
 */

declare module "@earendil-works/pi-coding-agent" {
  export interface RefreshModelsContext {
    credential?: { type: string; key?: string; access?: string }
    publish(publication: unknown): Promise<boolean>
    allowNetwork: boolean
    force?: boolean
    signal: AbortSignal
    baseUrl?: string
  }

  export interface ProviderChatModelConfig {
    type?: "chat"
    id: string
    name: string
    api?: string
    baseUrl?: string
    reasoning: boolean
    thinkingLevelMap?: Partial<
      Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
    >
    input: ("text" | "image")[]
    inputLimits?: unknown
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    contextWindow: number
    maxTokens: number
    compat?: Record<string, unknown>
    headers?: Record<string, string>
  }

  export interface ProviderConfig {
    name?: string
    baseUrl?: string
    apiKey?: string
    api?: string
    authHeader?: boolean
    headers?: Record<string, string>
    models?: ProviderChatModelConfig[]
    refreshModels?(context: RefreshModelsContext): Promise<ProviderChatModelConfig[]>
  }

  export interface ModelsRefreshResult {
    aborted: boolean
    errors: ReadonlyMap<string, Error>
  }

  export interface ExtensionCommandContext {
    mode: "tui" | "rpc" | "json" | "print"
    hasUI: boolean
    waitForIdle?: () => Promise<void>
    ui: {
      notify(text: string, kind: "info" | "warning" | "error"): void
    }
    modelRegistry: {
      refresh(options?: {
        allowNetwork?: boolean
        providers?: readonly string[]
        force?: boolean
        signal?: AbortSignal
      }): Promise<ModelsRefreshResult>
    }
  }

  export interface ExtensionAPI {
    registerEntryRenderer<T>(
      customType: string,
      renderer: (
        entry: { data?: T },
        options: { expanded: boolean },
        theme: { bg(color: string, text: string): string },
      ) => unknown,
    ): void
    appendEntry<T>(customType: string, data?: T): void
    registerCommand(
      name: string,
      options: {
        description?: string
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>
      },
    ): void
    registerProvider(name: string, config: ProviderConfig): void
  }
}

declare module "@earendil-works/pi-tui" {
  export class Box {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string)
    addChild(child: unknown): void
  }

  export class Text {
    constructor(text: string, outputPad?: number, paddingLeft?: number)
  }
}
