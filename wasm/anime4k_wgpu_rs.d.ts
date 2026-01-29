/* tslint:disable */
/* eslint-disable */

export class Anime4KProcessor {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    process_image(data_url: string): Promise<any>;
    process_image_with_pipeline(data_url: string, pipeline_index: number): Promise<any>;
}

export function start(): Promise<void>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_anime4kprocessor_free: (a: number, b: number) => void;
    readonly anime4kprocessor_new: () => any;
    readonly anime4kprocessor_process_image: (a: number, b: number, c: number) => any;
    readonly anime4kprocessor_process_image_with_pipeline: (a: number, b: number, c: number, d: number) => any;
    readonly start: () => void;
    readonly wasm_bindgen__closure__destroy__h92505d314e5e6b27: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h2a6c73fe6700fbb2: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h51e1ae7189e91b8e: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
