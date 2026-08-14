// treesitter.mts - the public parseSource(content, fileExt) entry point, dispatching
// to each language's own parser under lang/. Native binding loading, shared AST
// helpers, and the Symbol/ParsedSource types live in lang/shared.mts (imported and
// re-exported here) rather than in this file, so that it and the per-language files
// don't need to import each other.
import { initParsers, isAvailable, qualifiedName, type Symbol, type ParsedSource } from "./lang/shared.mjs";
import { parseTypeScript } from "./lang/typescript.mjs";
import { parseGo } from "./lang/go.mjs";

export { initParsers, isAvailable, qualifiedName };
export type { Symbol, ParsedSource };

/**
 * Parse source and return:
 *   symbols:          Array<{ name, kind, signature }>
 *   callsByFunction:  Map<funcName, Set<calleeName>>
 *   imports:          Set<rawImportString>
 *
 * Returns null if tree-sitter unavailable or language unsupported.
 */
export function parseSource(content: string, fileExt: string): ParsedSource | null {
  if (fileExt === '.go') return parseGo(content);
  if (fileExt === '.ts' || fileExt === '.tsx' || fileExt === '.js' || fileExt === '.jsx') return parseTypeScript(content, fileExt);
  return null;
}
