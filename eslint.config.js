// Minimal flat config for this extension's plain-script files (no bundler,
// no build step - manifest.json loads each of these directly). Scoped to
// catch real bugs (undefined names, unreachable code, duplicate keys) that
// a syntax-only `node --check` can't see, without imposing a style guide
// nobody asked for.
const js = require('@eslint/js');

/** Chrome extension APIs every one of these files can reach. */
const chromeExtensionGlobals = {
  chrome: 'readonly',
};

/** Browser DOM globals: popup.js and content.js/injected.js run in a page
 *  context, background.js runs as a service worker (a narrower set, but a
 *  superset covers both without needing two configs). */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  localStorage: 'readonly',
  CSS: 'readonly',
  confirm: 'readonly',
  alert: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  DOMException: 'readonly',
};

/** injected.js runs in the page's own context specifically to intercept
 *  navigator.credentials - it references the real WebAuthn constructors
 *  directly (e.g. to build a PublicKeyCredential-shaped return value),
 *  which no other file here touches. */
const webauthnGlobals = {
  PublicKeyCredential: 'readonly',
  AuthenticatorAttestationResponse: 'readonly',
  AuthenticatorAssertionResponse: 'readonly',
};

module.exports = [
  js.configs.recommended,
  {
    files: ['background.js', 'content.js', 'popup.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...chromeExtensionGlobals, ...browserGlobals },
    },
    rules: {
      // caughtErrors: 'none' - this codebase consistently writes
      // `catch (err) { showToast(...) }` without reading `err` (the error
      // is logged by the rejected call itself, or simply not actionable
      // beyond "show a generic failure"); that's a deliberate, uniform
      // style here, not 10 instances of a real bug, so the lint is tuned
      // to match it rather than forcing a churn-only rewrite.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // injected.js alone also touches the real WebAuthn constructors.
    files: ['injected.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...chromeExtensionGlobals, ...browserGlobals, ...webauthnGlobals },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'readonly' },
    },
  },
];
