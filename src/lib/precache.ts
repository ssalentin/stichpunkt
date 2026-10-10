// Manifest paths are relative to the worker; resolve them once so addAll and the fetch handler use one form.
export const toPathname = (path: string, base: string) => new URL(path, base).pathname;
