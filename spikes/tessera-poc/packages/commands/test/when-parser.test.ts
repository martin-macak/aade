import { describe, expect, it } from 'vitest';
import { WhenSyntaxError, type ContextReader, type ContextValue } from '@tessera/contracts';
import { parseWhen } from '@tessera/commands';

const ctx = (values: Record<string, ContextValue>): ContextReader => ({ getValue: (name) => values[name] });

describe('C10: when-clause parser, every grammar form of the frozen VS Code subset', () => {
  // [clause, context, expected]
  const table: Array<[string, Record<string, ContextValue>, boolean]> = [
    // plain key: truthiness
    ['editorFocus', { editorFocus: true }, true],
    ['editorFocus', { editorFocus: false }, false],
    ['editorFocus', {}, false],
    ['name', { name: 'x' }, true],
    ['name', { name: '' }, false],
    ['count', { count: 3 }, true],
    ['count', { count: 0 }, false],
    ['list', { list: ['a'] }, true],
    ['list', { list: [] }, false],
    // negation
    ['!inDebugMode', { inDebugMode: false }, true],
    ['!inDebugMode', {}, true],
    ['!inDebugMode', { inDebugMode: true }, false],
    ['!!x', { x: true }, true],
    // equality
    ['editorLangId == typescript', { editorLangId: 'typescript' }, true],
    ['editorLangId == typescript', { editorLangId: 'python' }, false],
    ['editorLangId == typescript', {}, false],
    ["resourceFilename == 'my file.txt'", { resourceFilename: 'my file.txt' }, true],
    ['editorLangId != typescript', { editorLangId: 'python' }, true],
    ['editorLangId != typescript', {}, true],
    ['editorLangId != typescript', { editorLangId: 'typescript' }, false],
    ['config.editor.minimap.enabled == true', { 'config.editor.minimap.enabled': true }, true],
    ['config.editor.minimap.enabled == true', { 'config.editor.minimap.enabled': false }, false],
    ['config.editor.minimap.enabled == true', { 'config.editor.minimap.enabled': 'true' }, false],
    ['x == false', { x: false }, true],
    ['x == false', {}, true],
    ['x == false', { x: true }, false],
    ['count == 3', { count: 3 }, true],
    ['count == 3', { count: '3' }, true],
    ['count != 3', { count: 4 }, true],
    // numeric comparison
    ['tasks.selectionCount > 1', { 'tasks.selectionCount': 2 }, true],
    ['tasks.selectionCount > 1', { 'tasks.selectionCount': 1 }, false],
    ['n >= 1', { n: 1 }, true],
    ['n < 1', { n: 0 }, true],
    ['n <= 1', { n: 1 }, true],
    ['n <= 1', { n: 2 }, false],
    ['n > 1', { n: '5' }, false], // the value is not a number
    ['n > 1', {}, false],
    ['n > -1', { n: 0 }, true],
    ['n > 1.5', { n: 2 }, true],
    // regex
    ['resourceFilename =~ /docker/', { resourceFilename: 'Dockerfile.docker' }, true],
    ['resourceFilename =~ /docker/', { resourceFilename: 'Dockerfile' }, false],
    ['resourceFilename =~ /docker/i', { resourceFilename: 'Dockerfile' }, true],
    ['resourceExtname =~ /\\.md$/', { resourceExtname: '.md' }, true],
    ['resourceExtname =~ /\\.md$/', { resourceExtname: '.mdx' }, false],
    ['v =~ /a\\/b/', { v: 'a/b' }, true],
    ['v =~ /[/]x/', { v: '/x' }, true],
    ['v =~ /x/', { v: 5 }, false],
    ['v =~ /x/', {}, false],
    // in / not in
    ['resourceFilename in supportedFolders', { resourceFilename: 'src', supportedFolders: ['src', 'lib'] }, true],
    ['resourceFilename in supportedFolders', { resourceFilename: 'docs', supportedFolders: ['src', 'lib'] }, false],
    ['resourceFilename in supportedFolders', { resourceFilename: 'src' }, false],
    ['resourceFilename not in supportedFolders', { resourceFilename: 'docs', supportedFolders: ['src'] }, true],
    ['resourceFilename not in supportedFolders', { resourceFilename: 'src', supportedFolders: ['src'] }, false],
    ['resourceFilename not in supportedFolders', {}, true],
    ['n in nums', { n: 2, nums: ['2'] }, true],
    // and, or, precedence, parentheses
    ['a && b', { a: true, b: true }, true],
    ['a && b', { a: true }, false],
    ['a || b', { b: true }, true],
    ['a || b', {}, false],
    ['a || b && c', { a: true }, true], // && binds tighter than ||
    ['a || b && c', { b: true }, false],
    ['(a || b) && c', { a: true }, false],
    ['(a || b) && c', { a: true, c: true }, true],
    ['!a && b', { b: true }, true],
    ['!(a && b)', { a: true }, true],
    ['!(a && b)', { a: true, b: true }, false],
    ['a && !b || c', { a: true }, true],
    ['  a   &&   b  ', { a: true, b: true }, true],
    ['((a))', { a: true }, true],
    // constants
    ['true', {}, true],
    ['false', {}, false],
    ['true && a', { a: true }, true],
    // keys with dots, dashes, colons and slashes
    ['plugin.sample.tasks.active', { 'plugin.sample.tasks.active': true }, true],
    ['view:tasks-list/x', { 'view:tasks-list/x': 'v' }, true],
    // combined, as a real menu item would write it
    ['view == tasks.list && tasks.hasSelection && !inputFocus', { view: 'tasks.list', 'tasks.hasSelection': true }, true],
    ['view == tasks.list && tasks.hasSelection && !inputFocus', { view: 'tasks.list', 'tasks.hasSelection': true, inputFocus: true }, false],
  ];

  it.each(table)('C10: %s with %j is %s', (clause, values, expected) => {
    expect(parseWhen(clause).evaluate(ctx(values))).toBe(expected);
  });

  it('C10: keys() lists every key the expression reads', () => {
    expect([...parseWhen('a && (b == 1 || !c) && d =~ /x/ && e in f && g > 2').keys].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect([...parseWhen('true').keys]).toEqual([]);
    expect(parseWhen('a && b').source).toBe('a && b');
  });

  it('C10: short circuit: a false left side of && does not read the right side', () => {
    const reads: string[] = [];
    const reader: ContextReader = { getValue: (name) => (reads.push(name), undefined) };
    parseWhen('a && b').evaluate(reader);
    expect(reads).toEqual(['a']);
    reads.length = 0;
    parseWhen('a || b').evaluate(reader);
    expect(reads).toEqual(['a', 'b']);
  });

  it('C10: the parsed expression is frozen and independent of the context object', () => {
    const expression = parseWhen('a');
    expect(Object.isFrozen(expression)).toBe(true);
    expect(expression.evaluate(ctx({ a: true }))).toBe(true);
    expect(expression.evaluate(ctx({}))).toBe(false);
  });
});

describe('C10: syntax errors carry the source and a 1-based column', () => {
  const bad: Array<[string, number, RegExp]> = [
    ['', 1, /Empty/],
    ['   ', 4, /Empty/],
    ['a &&', 5, /context key/],
    ['&& a', 1, /context key/],
    ['a ||', 5, /context key/],
    ['(a', 3, /"\)"/],
    ['a)', 2, /Unexpected/],
    ['a == ', 6, /value/],
    ["a == 'open", 6, /Unterminated/],
    ['a =~ b', 6, /regular expression/],
    ['a =~ /open', 6, /Unterminated/],
    ['a =~ /(/', 6, /Invalid regular expression/],
    ['a in', 5, /context key/],
    ['a b', 3, /Unexpected/],
    ['1a', 1, /context key/],
    ['a >1', 3, /Spaces are required/],
  ];

  it.each(bad)('C10: %j fails at column %i', (source, column, message) => {
    let error: WhenSyntaxError | undefined;
    try {
      parseWhen(source);
    } catch (e) {
      error = e as WhenSyntaxError;
    }
    expect(error).toBeInstanceOf(WhenSyntaxError);
    expect(error?.code).toBe('when.syntax');
    expect(error?.source).toBe(source);
    expect(error?.column).toBe(column);
    expect(error?.message).toMatch(message);
  });

  it('C10: the parser never evaluates code: strings that look like code are only keys or values', () => {
    expect(() => parseWhen('process.exit(1)')).toThrow(WhenSyntaxError);
    expect(parseWhen("a == 'constructor.constructor(\"return 1\")()'").evaluate(ctx({ a: 'x' }))).toBe(false);
  });
});
