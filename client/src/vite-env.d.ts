/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin. Left empty in development so Vite's proxy handles it. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
