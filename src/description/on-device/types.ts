/// <reference types="dom-chromium-ai" />

export type LocalAiStatus =
  | 'checking'
  | 'available'
  | 'downloadable'
  | 'starting'
  | 'downloading'
  | 'ready'
  | 'running'
  | 'unavailable'
  | 'error'
  | 'disabled';
export interface LocalAiState {
  status: LocalAiStatus;
  progress?: number;
}
export interface LocalAiControls {
  state: LocalAiState;
  enable(): void;
  disable(): void;
  check(): void;
}
// A narrow structural subset of the pinned official Chromium AI definitions.
export interface LocalSession {
  readonly contextUsage: number;
  readonly contextWindow: number;
  prompt(input: LanguageModelPrompt, options?: LanguageModelPromptOptions): Promise<string>;
  measureContextUsage(
    input: LanguageModelPrompt,
    options?: LanguageModelPromptOptions,
  ): Promise<number>;
  clone(options?: LanguageModelCloneOptions): Promise<LocalSession>;
  destroy(): void;
}
export interface LocalModelFactory {
  availability(options?: LanguageModelCreateCoreOptions): Promise<Availability>;
  create(options?: LanguageModelCreateOptions): Promise<LocalSession>;
}
