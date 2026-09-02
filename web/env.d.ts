/**
 * Ambient declarations for the browser build.
 *
 * Empty of its own declarations on purpose. The obvious candidate — a `define`d
 * `__APP_VERSION__` read from `package.json` at build time — was removed: the version
 * arrives from `/bootstrap`, which reports the version of the process actually
 * answering. A baked-in constant would keep claiming the version the bundle was built
 * from after the server behind it was upgraded, and the whole point of showing it is
 * to know what is running.
 *
 * The reference below is what gives `import.meta.glob` and `?url` imports their types.
 */
/// <reference types="vite/client" />
