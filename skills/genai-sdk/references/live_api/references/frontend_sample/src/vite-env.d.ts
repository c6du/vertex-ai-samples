/// <reference types="vite/client" />

// Vite's `?worker&url` import returns a string URL at build time. Declare
// the module shape so tsc accepts the import.
declare module '*?worker&url' {
  const src: string;
  export default src;
}
