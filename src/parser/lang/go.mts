// go.mts - everything Go-specific: AST extraction (via tree-sitter) and import
// resolution (package-path suffix matching). Nodes, call edges, and reference edges
// themselves stay generic (see parse.mts) — this file only owns what's actually
// different about this language: how to read it and how it names its own dependencies.
import { dirname } from "node:path";
import {
  collect, sigLine, collectCallees, mergeCalls, parseWithGrammar, goGrammar,
  type Symbol, type ParsedSource,
} from "./shared.mjs";
import type { FileTypeParser } from "../parse.mjs";

function parseGoAst(root: any, content: string): ParsedSource {
  const symbols: Symbol[] = [], callsByFunction = new Map<string, Set<string>>(), imports = new Set<string>();

  for (const spec of collect(root, 'import_spec')) {
    const path = spec.childForFieldName('path') ?? spec.namedChildren[0];
    if (path) imports.add(path.text.replace(/^"|"$/g, ''));
  }

  for (const fn of collect(root, 'function_declaration', 'method_declaration')) {
    const name = fn.childForFieldName('name')?.text;
    if (!name || !/^[A-Z]/.test(name)) continue;
    symbols.push({
      name,
      kind: fn.type === 'method_declaration' ? 'method' : 'function',
      signature: sigLine(content, fn.startIndex),
      body: content.slice(fn.startIndex, fn.endIndex),
    });
    const body = fn.childForFieldName('body');
    if (body) {
      const callees = collectCallees(body);
      if (callees.size) mergeCalls(callsByFunction, name, callees);
    }
  }

  for (const spec of collect(root, 'type_spec')) {
    const name = spec.childForFieldName('name')?.text;
    if (!name || !/^[A-Z]/.test(name)) continue;
    const parent = spec.parent ?? spec;
    symbols.push({ name, kind: 'type', signature: sigLine(content, parent.startIndex), body: content.slice(parent.startIndex, parent.endIndex) });
  }

  return { symbols, callsByFunction, imports };
}

export function parseGo(content: string): ParsedSource | null {
  const root = parseWithGrammar(content, goGrammar());
  return root ? parseGoAst(root, content) : null;
}

// Resolve a Go import path to a changed file path via suffix matching (Go files only)
function resolveGoImport(importPkg: string, changedPaths: Set<string>): string | null {
    for (const candidate of changedPaths) {
        if (!candidate.endsWith(".go")) continue;
        const rawDir = dirname(candidate).replace(/\\/g, "/");
        const parts  = rawDir.split("/");
        for (let len = 2; len <= parts.length; len++) {
            const suffix = parts.slice(parts.length - len).join("/");
            if (importPkg === suffix || importPkg.endsWith("/" + suffix)) return candidate;
        }
    }
    return null;
}

export function resolveGoStyleImports(_filePath: string, imports: Set<string>, _repoPath: string, changedPaths: Set<string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const imp of imports) {
        const tgt = resolveGoImport(imp, changedPaths);
        if (tgt) result.set(tgt, imp);
    }
    return result;
}

export const goParser: FileTypeParser = { parse: parseGo, resolveImports: resolveGoStyleImports };
