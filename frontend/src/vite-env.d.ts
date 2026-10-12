/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` runs against the in-browser mock backend; anything else uses the FastAPI server. */
  readonly VITE_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
