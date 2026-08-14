// shared.mts - native tree-sitter bindings, shared AST-walking helpers, and the
// shared symbol/parse-result types every language file works with. Lives separately
// from treesitter.mts so that treesitter.mts (which dispatches to lang/typescript.mts
// and lang/go.mts) and the language files (which need these helpers) don't import
// each other directly — both instead depend one-way on this file.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let Parser: any, tsLang: any, tsxLang: any, goLang: any, _available = false;

export function initParsers(): boolean {
  if (_available) return true;
  try {
    Parser = require('tree-sitter');
    const TS = require('tree-sitter-typescript');
    tsLang  = TS.typescript;
    tsxLang = TS.tsx;
    goLang  = require('tree-sitter-go');
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

export function isAvailable(): boolean { return _available; }

export interface Symbol {
  name: string;
  kind: string;
  // The enclosing symbol's own (bare, top-level) name — e.g. a method's containing
  // class — or absent for a top-level symbol. This is the *source*-level identity:
  // it says how a symbol nests in the language, and is what diffing/call-resolution
  // match on (see qualifiedName below). It's independent of a node's *graph* id
  // (built in parse.mts by chaining ids with ":::"), which is a rendering-layer
  // concern — the two happen to correlate 1:1 but are computed separately.
  parent?: string;
  signature?: string;
  body?: string;
  status?: string;
}

// A symbol's fully-qualified source-level name (e.g. "Widget.run" for a method `run`
// on class `Widget`) — the identity used to match a symbol across parse passes
// (diffing) or to key its calls, so that same-named members of different containers
// never cross-match. Bare name when there's no enclosing symbol.
export function qualifiedName(sym: Pick<Symbol, "name" | "parent">): string {
  return sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
}

export interface ParsedSource {
  symbols: Symbol[];
  callsByFunction: Map<string, Set<string>>;
  imports: Set<string>;
  namedImports?: Map<string, Set<string>>;
}

// Parses content with a given tree-sitter grammar, returning its root AST node (or
// null if tree-sitter isn't available, there's nothing to parse, or parsing fails).
export function parseWithGrammar(content: string, lang: any): any | null {
  if (!_available || !content || content.includes('\0') || !lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  try { return parser.parse(content).rootNode; } catch { return null; }
}

export function tsGrammar(): any { return tsLang; }
export function tsxGrammar(): any { return tsxLang; }
export function goGrammar(): any { return goLang; }

// Collect all descendant nodes of given types (depth-first)
export function collect(node: any, ...types: string[]): any[] {
  const out: any[] = [];
  function walk(n: any) {
    if (types.includes(n.type)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  }
  walk(node);
  return out;
}

// First source line containing startIndex
export function sigLine(src: string, startIndex: number): string {
  const s = src.lastIndexOf('\n', startIndex - 1) + 1;
  const e = src.indexOf('\n', startIndex);
  return src.slice(s, e < 0 ? src.length : e).trimEnd();
}

export function collectCallees(bodyNode: any): Set<string> {
  const out = new Set<string>();
  for (const call of collect(bodyNode, 'call_expression', 'new_expression')) {
    const fn = call.childForFieldName('function') ?? call.childForFieldName('constructor') ?? call.namedChildren[0];
    if (!fn) continue;
    if (fn.type === 'identifier') {
      out.add(fn.text);
    } else if (fn.type === 'member_expression' || fn.type === 'selector_expression') {
      const prop = fn.childForFieldName('property')
               ?? fn.childForFieldName('field')
               ?? fn.namedChildren[fn.namedChildCount - 1];
      if (prop) out.add(prop.text);
    }
  }
  return out;
}

export function mergeCalls(map: Map<string, Set<string>>, fnName: string, callees: Set<string>) {
  if (!map.has(fnName)) map.set(fnName, new Set());
  for (const c of callees) map.get(fnName)!.add(c);
}

// Walks up from a method/field node to find its containing class's name, so callers
// can key callsByFunction by qualifiedName() and avoid merging same-named methods
// from different classes into one entry.
export function enclosingClassName(node: any): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'class_declaration' || n.type === 'abstract_class_declaration') {
      return n.childForFieldName('name')?.text;
    }
  }
  return undefined;
}
