// typescript.mts - everything TypeScript/JavaScript-specific: AST extraction (via
// tree-sitter) and import resolution (relative paths + path aliases). Nodes, call
// edges, and reference edges themselves stay generic (see parse.mts) — this file only
// owns what's actually different about this language: how to read it and how it
// names its own dependencies.
import { resolve as resolvePath, dirname, join } from "node:path";
import {
  collect, sigLine, collectCallees, mergeCalls, enclosingClassName, qualifiedName,
  parseWithGrammar, tsGrammar, tsxGrammar, type Symbol, type ParsedSource,
} from "./shared.mjs";
import type { FileTypeParser } from "../parse.mjs";

function parseTypeScriptAst(root: any, content: string): ParsedSource {
  const symbols: Symbol[] = [], callsByFunction = new Map<string, Set<string>>(), imports = new Set<string>();
  // namedImports: modulePath → Set<importedName>
  const namedImports = new Map<string, Set<string>>();

  for (const node of collect(root, 'import_statement')) {
    const src = node.childForFieldName('source');
    if (!src) continue;
    const modPath = src.text.replace(/^['"]|['"]$/g, '');
    imports.add(modPath);
    // Collect specific named imports: import { X, Y } from '...'
    const clause = node.namedChildren.find((c: any) => c.type === 'import_clause');
    const namedNode = clause?.namedChildren.find((c: any) => c.type === 'named_imports');
    if (namedNode) {
      const names = new Set<string>();
      for (const spec of namedNode.namedChildren) {
        if (spec.type === 'import_specifier') {
          const nm = spec.childForFieldName('name') ?? spec.namedChildren[0];
          if (nm) names.add(nm.text);
        }
      }
      if (names.size) namedImports.set(modPath, names);
    }
  }

  for (const exp of collect(root, 'export_statement')) {
    const decl = exp.childForFieldName('declaration')
      ?? exp.namedChildren.find((c: any) => !['export', 'default'].includes(c.type));
    if (decl) extractTSDecl(decl, content, symbols);
  }

  for (const fn of collect(root, 'function_declaration', 'method_definition')) {
    const name = fn.childForFieldName('name')?.text;
    const body = fn.childForFieldName('body');
    if (name && body) {
      const callees = collectCallees(body);
      if (callees.size) mergeCalls(callsByFunction, qualifiedName({ name, parent: enclosingClassName(fn) }), callees);
    }
  }

  for (const vd of collect(root, 'variable_declarator')) {
    const val = vd.childForFieldName('value');
    if (!val || (val.type !== 'arrow_function' && val.type !== 'function_expression')) continue;
    const name = vd.childForFieldName('name')?.text;
    const body = val.childForFieldName('body');
    if (name && body) {
      const callees = collectCallees(body);
      if (callees.size) mergeCalls(callsByFunction, name, callees);
    }
  }

  // Class properties: walk the entire field node for callees so we catch
  // computed(() => ...), signal(), and direct arrow function values alike.
  for (const field of collect(root, 'public_field_definition', 'field_definition')) {
    const name = field.childForFieldName('name')?.text;
    if (!name) continue;
    const callees = collectCallees(field);
    if (callees.size) mergeCalls(callsByFunction, qualifiedName({ name, parent: enclosingClassName(field) }), callees);
  }

  return { symbols, callsByFunction, imports, namedImports };
}

function extractTSDecl(decl: any, content: string, symbols: Symbol[]) {
  const push = (name: string | undefined, kind: string) =>
    name && symbols.push({ name, kind, signature: sigLine(content, decl.startIndex), body: content.slice(decl.startIndex, decl.endIndex) });

  switch (decl.type) {
    case 'function_declaration':
      push(decl.childForFieldName('name')?.text, 'function'); break;
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const cname = decl.childForFieldName('name')?.text;
      push(cname, 'class');
      // Also track class members so body-only changes are detected
      const classBody = decl.childForFieldName('body');
      if (classBody) {
        for (const member of classBody.namedChildren) {
          let mname: string | undefined, kind: string | undefined;
          if (member.type === 'method_definition') {
            mname = member.childForFieldName('name')?.text; kind = 'method';
          } else if (member.type === 'public_field_definition' || member.type === 'field_definition') {
            mname = member.childForFieldName('name')?.text; kind = 'property';
          }
          if (mname) symbols.push({ name: mname, kind: kind!, parent: cname, signature: sigLine(content, member.startIndex), body: content.slice(member.startIndex, member.endIndex) });
        }
      }
      break;
    }
    case 'interface_declaration':
      push(decl.childForFieldName('name')?.text, 'interface'); break;
    case 'type_alias_declaration':
      push(decl.childForFieldName('name')?.text, 'type'); break;
    case 'enum_declaration':
      push(decl.childForFieldName('name')?.text, 'enum'); break;
    case 'lexical_declaration':
      for (const vd of decl.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
        const val = vd.childForFieldName('value');
        const kind = (val?.type === 'arrow_function' || val?.type === 'function_expression')
                   ? 'function' : 'const';
        push(vd.childForFieldName('name')?.text, kind);
      }
      break;
  }
}

// Parses TS/TSX/JS/JSX content. fileExt only decides tsLang vs tsxLang (both grammars
// otherwise produce the same ParsedSource shape).
export function parseTypeScript(content: string, fileExt: string): ParsedSource | null {
  const root = parseWithGrammar(content, fileExt === '.tsx' ? tsxGrammar() : tsGrammar());
  return root ? parseTypeScriptAst(root, content) : null;
}

// TypeScript path alias map derived from frontend/tsconfig.json "paths".
// Maps alias prefix → path segment that appears after shortId stripping.
const TS_ALIASES: Record<string, string> = {
    "@app/":              "",
    "@env/":              "src/environments/",
    "@api/":              "backend/node/src/api/",
    "@utils/":            "utils/",
    "@app-admin/":        "modules/admin/",
    "@app-security/":     "modules/security/",
    "@app-consumer/":     "modules/object-group/",
    "@app-dashboard/":    "modules/dashboard/",
    "@app-data/":         "modules/data/",
    "@app-shared/":       "modules/shared/",
    "@app-space/":        "modules/space/",
    "@app-scenario/":     "modules/scenario/",
    "@app-organisation/": "modules/organisation/",
    "@app-datacollection/": "modules/datacollection/",
    "@app-dataevaluation/": "modules/dataevaluation/",
    "@app-dataexplorer/": "modules/dataexplorer/",
    "@app-dataplanning/": "modules/dataplanning/",
    "@app-customer/":     "modules/customer/",
    "@app-company/":      "modules/company/",
    "@app-project/":      "modules/project/",
};

// Resolve a relative TS import to a changed file path
function resolveTsImport(filePath: string, importPath: string, repoPath: string, changedPaths: Set<string>): string | null {
    const absDir     = join(repoPath, dirname(filePath));
    const absResolved = resolvePath(absDir, importPath).replace(/\\/g, "/");
    const repoRoot   = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
    const rel        = absResolved.replace(repoRoot + "/", "");
    for (const e of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"]) {
        const candidate = rel + e;
        if (changedPaths.has(candidate)) return candidate;
    }
    return null;
}

// Resolves a TS/JS file's own imports (relative paths and/or path aliases) to changed
// file paths. A single file can mix both styles, so both are tried per import string.
export function resolveTsStyleImports(filePath: string, imports: Set<string>, repoPath: string, changedPaths: Set<string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const imp of imports) {
        let tgt: string | null = null;
        if (imp.startsWith(".")) {
            tgt = resolveTsImport(filePath, imp, repoPath, changedPaths);
        } else {
            // TS path alias: resolve via TS_ALIASES map for precision,
            // falling back to generic @scope/ strip for unknown aliases.
            const alias = imp.startsWith("@")
                ? Object.keys(TS_ALIASES).find(k => imp.startsWith(k))
                : null;
            const bare = alias != null
                ? TS_ALIASES[alias] + imp.slice(alias.length)
                : imp.startsWith("@") ? imp.replace(/^@[^/]+\//, "") : imp;
            for (const e of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"]) {
                const suffix = bare + e;
                for (const candidate of changedPaths) {
                    if (candidate === suffix || candidate.endsWith("/" + suffix)) {
                        tgt = candidate; break;
                    }
                }
                if (tgt) break;
            }
        }
        if (tgt) result.set(tgt, imp);
    }
    return result;
}

export function makeTsParser(fileExt: string): FileTypeParser {
  return { parse: (content) => parseTypeScript(content, fileExt), resolveImports: resolveTsStyleImports };
}
