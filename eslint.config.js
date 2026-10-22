// Lint (npm run lint): catches mistakes such as undefined names and unused code. Formatting is
// Prettier's job (npm run format); the project's hard rules are checked in tests/rules.test.js.
"use strict";
const js = require("@eslint/js");
const globals = require("globals");

// Names the browser suites use inside pages and the extension's background worker (page.evaluate,
// worker.evaluate): they exist there, not in Node.
const insideExtension = Object.fromEntries(
  [
    "appendEvents",
    "axe",
    "checkForLocalUpdate",
    "cleanVaultEntry",
    "clearHistory",
    "ClotrSites",
    "enqueue",
    "ensureSalt",
    "followPersonalSwitch",
    "handleCommand",
    "migrateOffToLog",
    "migrateSuppressed",
    "migrateToVault",
    "noteEverydayOffer",
    "offerTeamTraining",
    "runMigrations",
    "settingsFor",
    "setResponses",
    "syncEverywhere",
    "syncUserSites",
  ].map((name) => [name, "readonly"]),
);
insideExtension.policyRead = "writable"; // the harness forgets the kept team policy when a check swaps it

module.exports = [
  {
    ignores: ["node_modules/", "dist/", "**/dist/", "tests/e2e/output/"],
  },
  js.configs.recommended,
  {
    rules: {
      // The detector matches control and invisible characters on purpose.
      "no-control-regex": "off",
      // A top-level name in a page script may reuse one the browser also defines.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    // The extension: classic scripts that share code through globalThis.Clotr (no import/export).
    files: ["extension/**/*.js", "tests/e2e/pages/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker },
    },
  },
  {
    // The extension's code also follows these rules past the recommended set. Each one passes on every file today with
    // no exception: code that runs a string as code or writes markup from one, loose comparisons, and leftovers that
    // hide a mistake. CI runs lint on every pull request, so a new one fails the build.
    files: ["extension/**/*.js"],
    rules: {
      "array-callback-return": "error",
      "default-case-last": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-caller": "error",
      "no-constructor-return": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-implied-eval": "error",
      "no-iterator": "error",
      "no-multi-str": "error",
      "no-new": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-octal-escape": "error",
      "no-proto": "error",
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Build the DOM with createElement and textContent." },
        { property: "outerHTML", message: "Build the DOM with createElement and textContent." },
        { property: "insertAdjacentHTML", message: "Build the DOM with createElement and textContent." },
        { object: "document", property: "write", message: "Build the DOM with createElement and textContent." },
      ],
      "no-return-assign": "error",
      "no-script-url": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-throw-literal": "error",
      "no-useless-call": "error",
      "no-useless-computed-key": "error",
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      "no-var": "error",
      "prefer-const": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      radix: "error",
    },
  },
  {
    // The engine package's classic scripts run in a bare JavaScript engine with nothing else available, as the first
    // and last parts of the engine bundle every developer tool loads.
    files: ["apps/engine/**/*.js"],
    languageOptions: { sourceType: "script", globals: {} },
  },
  {
    // The VS Code extension and its build run in Node inside VS Code's extension host.
    files: ["apps/vscode/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    // A caught error or argument whose name starts with "_" is left unused on purpose.
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }] },
  },
  {
    // Tests and dev tools run in Node.
    files: ["tests/**/*.js", "tools/**/*.js", "*.js"],
    ignores: ["tests/e2e/pages/**"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    // …and the browser-driving ones also run code inside pages and the extension.
    files: ["tests/e2e/*.js", "tests/e2e/checks/*.js", "tools/site-check.js", "tools/draft-leak-monitor.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, ...insideExtension } },
  },
];
