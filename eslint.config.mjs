// The complexity gate.
//
// This config deliberately enables nothing but the size-and-shape rules. It is
// not a style checker and not a bug finder — there is no formatter here, no
// `recommended` set, no opinion about semicolons. The one question it asks is
// whether a function has grown past the point where a reader can hold it in
// their head, and it asks that question in four ways because no single metric
// catches everything: a flat 90-line function scores well on complexity, and a
// tight 6-line function can still be nested five deep.
//
// The numbers are the conventional ones, chosen against a census of the codebase
// rather than picked out of the air. They sit above where the bulk of the code
// already lives (the median function scores 2, the 90th percentile scores 7), so
// passing is the normal state of affairs and a failure means something genuinely
// grew rather than that the bar was set fashionably low.

import tsParser from '@typescript-eslint/parser';

const limits = {
  // Cyclomatic complexity: independent paths through a function. Past ~10 the
  // branch combinations outnumber what anyone will actually test.
  //
  // The `modified` variant scores a switch as one branch rather than one per
  // case. Classic cyclomatic complexity rates a flat dispatch switch — the most
  // readable way there is to write multi-way dispatch — the same as deeply
  // tangled conditionals, and the only way to satisfy it is to convert the
  // switch into a lookup table, which is churn in service of the metric rather
  // than the reader. Nested branching inside a case still counts in full.
  complexity: ['error', { max: 10, variant: 'modified' }],

  // Nesting depth. Four is already a lot; beyond it the reader is tracking more
  // live conditions than the code is doing work.
  'max-depth': ['error', 4],

  // Straight-line length still costs something even with no branching at all.
  'max-statements': ['error', 25],

  // The same limit expressed in lines, which catches the long-but-simple
  // function that the statement count lets through — big literals, long
  // template strings, walls of DOM construction.
  'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
};

export default [
  {
    // Build output and vendored state. `dist/` and `public/app.js` are compiled
    // from sources that are themselves linted, so linting them again would
    // report every finding twice, against generated line numbers.
    ignores: ['node_modules/', 'dist/', '.wrangler/', 'terraform/', 'public/app.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2024, sourceType: 'module' },
    rules: limits,
  },
  {
    // The config files themselves are still plain JavaScript.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: limits,
  },
  {
    // Tests are held to the same complexity and nesting limits — a test with
    // five levels of branching is testing something other than what it claims.
    // Length is not capped: a table-driven case list or a long sequence of
    // assertions is a legitimate shape for a test and splitting one to satisfy
    // a line count makes it harder to read, not easier.
    files: ['test/**/*.ts', 'scripts/soak.ts'],
    rules: {
      'max-statements': 'off',
      'max-lines-per-function': 'off',
    },
  },
];
