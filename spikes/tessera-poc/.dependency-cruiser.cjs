// Layer rules (packages.md section 5). Generated from scripts/layers.json so the allowed lists live in one place.
// Parser: swc. dependency-cruiser supports typescript <7 only, and TypeScript 7 has no compiler API until 7.1.
const rules = require(require('node:path').resolve(__dirname, 'scripts/layers.json'));

const names = Object.keys(rules.packages);
const CORE_NAMES = names.filter((n) => rules.coreLayers.includes(rules.packages[n].layer));
const core = `^packages/(${CORE_NAMES.join('|')})/src/`;
const l2Names = rules.l2;
const l2 = `(${l2Names.join('|')})`;

const forbidden = [
  {
    name: 'core-no-ui-or-electron',
    comment: 'L0 to L3 never import React, DOM libraries, Electron or vitest.',
    severity: 'error',
    from: { path: core },
    to: { path: `(^|/)node_modules/(${rules.forbiddenInCore.join('|')})/|^(${rules.forbiddenInCore.join('|')})$` },
  },
  {
    name: 'core-no-node-builtins',
    comment: 'L0 to L3 source never imports node: built-ins.',
    severity: 'error',
    from: { path: core },
    to: { dependencyTypes: ['core'] },
  },
  {
    name: 'l2-no-sideways',
    comment: 'L2 packages never import each other; they meet at runtime through tokens in @tessera/contracts.',
    severity: 'error',
    from: { path: `^packages/${l2}/src/` },
    to: { path: `^packages/${l2}/`, pathNot: '^packages/$1/' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
  {
    name: 'src-not-to-test',
    comment: 'Shipped source never imports test files or fixtures.',
    severity: 'error',
    from: { path: '^packages/[^/]+/src/' },
    to: { path: '^packages/[^/]+/(test|test-fixtures)/' },
  },
  {
    name: 'no-deep-imports',
    comment: 'Packages are consumed only through their package.json exports entries.',
    severity: 'error',
    from: { path: '^packages/([^/]+)/' },
    to: {
      path: '^packages/([^/]+)/(src|test|test-fixtures)/',
      pathNot: [`^packages/$1/`, `^packages/[^/]+/src/(${rules.exportEntries.map((e) => e.replace('.', '\\.')).join('|')})$`],
    },
  },
];

forbidden.push({
  name: 'plugins-only-facade',
  comment: 'A plugin imports @tessera/plugin-api (and its rendering adapter) and nothing else from @tessera (packages.md rule 5).',
  severity: 'error',
  from: { path: '^plugins/[^/]+/src/' },
  // plugin-api anywhere; the React UI surface (packages/react/src/ui.ts) only from ui-* files (round 3: fence by specifier, not by package name)
  to: { path: '^packages/', pathNot: ['^packages/plugin-api/', '^packages/react/src/ui\\.ts$'] },
});
forbidden.push({
  name: 'plugins-ui-surface-only-in-ui-files',
  comment: 'Only the ui-* entries of a plugin import the React UI surface.',
  severity: 'error',
  from: { path: '^plugins/[^/]+/src/', pathNot: '(^|/)ui-[^/]*\\.tsx?$' },
  to: { path: '^packages/react/' },
});
forbidden.push({
  name: 'plugins-no-implementation-npm',
  comment: 'Plugins do not import third-party packages other than react in their UI entries.',
  severity: 'error',
  from: { path: '^plugins/[^/]+/src/' },
  to: { path: '(^|/)node_modules/(electron|dockview|dockview-core)/|^(electron|dockview|dockview-core)$' },
});

// Stage C: one owner per foreign technology (packages.md rule 4) and the plugin UI fence (poc-plan C26 a).
forbidden.push({
  name: 'only-react-package-imports-react',
  comment: 'Only @tessera/react imports react or react-dom. Plugin ui-* entries import react too (see ui-only-view-imports).',
  severity: 'error',
  from: { path: '^(packages/(?!react/)[^/]+/src/|plugins/[^/]+/src/(?!ui-)|apps/(?!demo/)[^/]+/src/)' },
  to: { path: '(^|/)node_modules/(react|react-dom)/|^(react|react-dom)$' },
});
forbidden.push({
  name: 'only-dockview-package-imports-dockview',
  comment: 'Only @tessera/layout-dockview imports dockview-core. Apps and plugins use the adapter.',
  severity: 'error',
  from: { path: '^(packages/(?!layout-dockview/)[^/]+/src/|plugins/[^/]+/src/|apps/[^/]+/src/)' },
  to: { path: '(^|/)node_modules/(dockview|dockview-core)/|^(dockview|dockview-core)$' },
});
forbidden.push({
  name: 'ui-only-view-imports',
  comment: 'A plugin UI entry (src/ui-*) imports only react and @tessera/react at run time. Type-only imports of its plugin presenters are allowed (they are erased). check-deps.mjs checks the same with a text scan.',
  severity: 'error',
  from: { path: '^plugins/[^/]+/src/ui-' },
  to: { path: '.', pathNot: '(^|/)node_modules/react/|^packages/react/', dependencyTypesNot: ['type-only'] },
});

// One rule per package: it may import only the packages of its allowed list (closed list, packages.md section 2).
for (const name of names) {
  const allowed = [name, ...rules.packages[name].tessera];
  forbidden.push({
    name: `allowed-deps-${name}`,
    comment: `${name} (${rules.packages[name].layer}) may import only: ${allowed.join(', ')}.`,
    severity: 'error',
    from: { path: `^packages/${name}/src/` },
    to: { path: '^packages/', pathNot: `^packages/(${allowed.join('|')})/` },
  });
}

module.exports = {
  forbidden,
  options: {
    parser: 'swc',
    tsPreCompilationDeps: false,
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6', 'cjs'],
    // only the project's own dist, coverage and fixture folders: a path with /dist/ inside node_modules (dockview-core) must stay visible to the rules
    exclude: { path: '^(packages|plugins|apps)/[^/]+/(dist|coverage|test-fixtures)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      mainFields: [],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
