import { defineConfig } from 'tsdown'

/**
 * Two artifacts:
 *
 *  - `lib/index.js`  — the host loader entry the profile composes. `@deepseek-ai/*`
 *    is resolved from the harness installation at runtime, so it is never
 *    bundled and never inlined into the published `.d.ts`.
 *  - `lib/client.js` — the browser half, in the lazy-CJS factory shape the page's
 *    module table calls (`window.__ModuleLoader__.load`). Without it the row is
 *    live and writable in the host but has no configuration UI at all: DSH has no
 *    auto-generated settings form, so a bundle's config page exists only when some
 *    client half registers into the `plugins.bundle.config` seat.
 *
 * The client bundle must be CJS wrapped in that factory, so it gets its own entry
 * with a banner/footer pair: the factory body *is* the module, receiving
 * `require` and owning `module`/`exports`.
 */
const CLIENT_ID = 'dsh-notes-context'

const clientBanner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(CLIENT_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const clientFooter = `\t\treturn module.exports;
\t}
});`

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    // Same `.js` naming the shipped packages use, so `exports` stays truthful.
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    // Loaded by the page's module table, never by Node, so the CJS body is
    // emitted as a plain `.js` that the wrapper above owns.
    outExtensions: () => ({ js: '.js' }),
    outputOptions: { banner: clientBanner, footer: clientFooter },
  },
])
