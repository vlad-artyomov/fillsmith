/* Chrome's built-in Prompt API, as much of it as Fillsmith uses.
 *
 * It is not in `@types/chrome`, and it is the one interface here that belongs
 * to a spec still moving: `LanguageModel` was `self.ai.languageModel`, and
 * `inputUsage`/`inputQuota` became `contextUsage`/`contextWindow`. Writing the
 * shape down is how the checker can see which of those the code still reads.
 *
 * Declarations only. Nothing here ships.
 */

type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelPromptOptions {
    /** A JSON schema the decoder is held to. */
    responseConstraint?: object;
    /** Keep the schema out of the prompt itself; the shape is stated in the last line instead. */
    omitResponseConstraintInput?: boolean;
    signal?: AbortSignal;
}

interface LanguageModelSession {
    prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>;

    clone(): Promise<LanguageModelSession>;

    destroy(): void;

    /** The current names, and the ones older Chromes still report. */
    contextUsage?: number;
    contextWindow?: number;
    inputUsage?: number;
    inputQuota?: number;
}

interface LanguageModelCreateOptions {
    initialPrompts?: { role: string; content: string }[];
    expectedInputs?: { type: string; languages?: string[] }[];
    expectedOutputs?: { type: string; languages?: string[] }[];
    monitor?: (m: EventTarget) => void;
    signal?: AbortSignal;
}

interface LanguageModelFactory {
    availability?(): Promise<LanguageModelAvailability>;

    /** The older spelling, still what some builds answer. */
    capabilities?(): Promise<{ available: 'readily' | 'after-download' | 'no' }>;

    create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare var LanguageModel: LanguageModelFactory | undefined;

interface Window {
    ai?: { languageModel?: LanguageModelFactory };
}

interface WorkerGlobalScope {
    ai?: { languageModel?: LanguageModelFactory };
    LanguageModel?: LanguageModelFactory;

    /* Handles the suites and the tooling reach into the worker for. They are
     * part of how this extension is tested, so they are part of its surface. */
    FILLER_FILES?: string[];

    injectFiller?(tabId: number): Promise<void>;

    askPage?(tabId: number, msg: object): Promise<any>;
}
