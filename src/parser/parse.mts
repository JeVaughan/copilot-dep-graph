// parse.mts - builds a file/symbol dependency graph from a git PR diff.
// Deterministic (git + tree-sitter AST). No AI involved.

import { spawnSync } from "node:child_process";
import { resolve as resolvePath, dirname, basename, extname, join } from "node:path";
import { initParsers, isAvailable, qualifiedName, type Symbol as ParsedSymbol, type ParsedSource } from "./treesitter.mjs";
import { makeTsParser } from "./lang/typescript.mjs";
import { goParser } from "./lang/go.mjs";
import type { GraphNode, GraphEdge } from "../types.mjs";
import { diffEdges } from "./graph-diff.mjs";

export type { GraphNode, GraphEdge, GraphData } from "../types.mjs";

// Converts a symbol's qualifiedName() (its source-level identity, dot-joined through
// enclosing symbols) into the graph node id it gets inside a given file (colon-joined,
// chained through the *graph* ids of the same ancestors). The two id schemes are kept
// separate on purpose — see the comment on Symbol.parent in treesitter.mts — and this
// is the one place that converts between them, so node-building and call-edge
// resolution can never derive different ids for the same symbol.
export function graphIdForQualifiedName(fileId: string, qualified: string): string {
  return `${fileId}:::${qualified.split(".").join(":::")}`;
}

// Diffs one file's PR/base symbol lists directly into final, status-bearing nodes —
// matching by qualifiedName() (not bare name) so e.g. two classes that both have a
// `run` method diff independently instead of cross-matching each other's body. A
// symbol with no `parent` sits directly under the file; one with a `parent` (e.g. a
// class method) nests under that container's own node.
export function diffFileSymbols(fileId: string, prSymbols: ParsedSymbol[], baseSymbols: ParsedSymbol[]): GraphNode[] {
  const baseByName = new Map(baseSymbols.map(s => [qualifiedName(s), s]));
  const prByName = new Map(prSymbols.map(s => [qualifiedName(s), s]));

  function toNode(sym: ParsedSymbol, status: string): GraphNode {
    const id = graphIdForQualifiedName(fileId, qualifiedName(sym));
    const parent = sym.parent ? graphIdForQualifiedName(fileId, sym.parent) : fileId;
    return { id, label: sym.name, type: sym.kind, parent, status };
  }

  const nodes: GraphNode[] = [];
  for (const sym of prSymbols) {
    const base = baseByName.get(qualifiedName(sym));
    const status = !base                                                         ? "added"
                 : (base.body ?? base.signature) !== (sym.body ?? sym.signature)  ? "modified"
                 : "unchanged";
    nodes.push(toNode(sym, status));
  }
  for (const sym of baseSymbols) {
    if (!prByName.has(qualifiedName(sym))) nodes.push(toNode(sym, "removed"));
  }
  return nodes;
}

function shortId(p: string): string {
  return p
    .replace(/^frontend\/projects\/app-member\/src\/app\//, "")
    .replace(/^backend\/services\//, "backend/");
}

// Everything language-specific about turning one file's raw content into graph
// material: how to parse it (or fail, falling back to the regex extractor) and how to
// resolve its own import strings to other changed files. Nodes and call/reference-edge
// resolution stay shared across every file type — see diffFileSymbols and
// buildVersionEdges — since neither cares what produced the symbols/calls they work
// with. Each language's own implementation lives under lang/ (see lang/typescript.mts,
// lang/go.mts).
export interface FileTypeParser {
  parse: (content: string) => ParsedSource | null;
  resolveImports: (filePath: string, imports: Set<string>, repoPath: string, changedPaths: Set<string>) => Map<string, string>;
}

export const DEFAULT_PARSERS: Map<string, FileTypeParser> = new Map([
  [".ts", makeTsParser(".ts")],
  [".tsx", makeTsParser(".tsx")],
  [".js", makeTsParser(".js")],
  [".jsx", makeTsParser(".jsx")],
  [".go", goParser],
]);

export interface ParsePrOptions {
  repoPath: string;
  prRef?: string;
  baseRef?: string;
  exclude?: string[];
  parsersByExt?: Map<string, FileTypeParser>;
}

// Parses every file in one version via its registered filetype parser (or a regex
// fallback when there's no parser for its extension, or its parser fails) — no
// notion of "before" or "after" here, just this one version's content.
function parseVersion(filePaths: string[], content: Map<string, string>, parsersByExt: Map<string, FileTypeParser>): { parsed: Map<string, ParsedSource>; symbols: Map<string, ParsedSymbol[]> } {
  const parsed = new Map<string, ParsedSource>();
  const symbols = new Map<string, ParsedSymbol[]>();
  for (const filePath of filePaths) {
    const parser = parsersByExt.get(extname(filePath));
    const p = parser ? parser.parse(content.get(filePath) ?? "") : null;
    if (p) parsed.set(filePath, p);
    symbols.set(filePath, p ? p.symbols : extractSymbolsRegex(content.get(filePath) ?? ""));
  }
  return { parsed, symbols };
}

// Builds the candidate import/call/reference/sibling edges for ONE version of the
// changed files — plain edges with no status yet. Called once for base content and
// once for PR content; diffEdges (graph-diff.mts) is the only place that compares the
// two and decides added/removed/unchanged.
function buildVersionEdges(
  filePaths: string[], parsed: Map<string, ParsedSource>, fileSymbols: Map<string, ParsedSymbol[]>,
  content: Map<string, string>, changedPaths: Set<string>, repoPath: string, parsersByExt: Map<string, FileTypeParser>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seenLinks = new Set<string>();
  function addLink(src: string, tar: string, type = "import") {
    if (src === tar) return;
    const key = `${src}->${tar}:${type}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    edges.push({ src, tar, type, count: 1 });
  }

  // Import edges
  for (const filePath of filePaths) {
    const fileId = shortId(filePath);
    const pf = parsed.get(filePath);
    const parser = parsersByExt.get(extname(filePath));
    if (pf && parser) {
      for (const [tgtFile] of parser.resolveImports(filePath, pf.imports, repoPath, changedPaths)) {
        addLink(fileId, shortId(tgtFile));
      }
    } else {
      buildRegexImportEdges(filePath, content.get(filePath) ?? "", fileId, changedPaths, repoPath, addLink);
    }
  }

  // Symbol-symbol call edges + named-import reference edges (tree-sitter only)
  if (isAvailable()) {
    // Cross-file symbol index: symbolName → filePath[]
    const symbolIndex = new Map<string, string[]>();
    for (const filePath of filePaths) {
      const pf = parsed.get(filePath);
      if (!pf) continue;
      for (const sym of pf.symbols) {
        if (!symbolIndex.has(sym.name)) symbolIndex.set(sym.name, []);
        symbolIndex.get(sym.name)!.push(filePath);
      }
    }

    for (const srcFile of filePaths) {
      const pf = parsed.get(srcFile);
      if (!pf) continue;
      const srcFileId = shortId(srcFile);
      for (const [fnName, callees] of pf.callsByFunction) {
        const srcSymId = graphIdForQualifiedName(srcFileId, fnName);
        for (const callee of callees) {
          for (const tgtFile of (symbolIndex.get(callee) ?? [])) {
            const tgtFileId = shortId(tgtFile);
            // A bare callee name (e.g. from `this.base()`) doesn't say which container
            // it belongs to, so resolve it against the target file's actual symbols —
            // fanning out to every match if more than one container shares that name,
            // rather than guessing a single (possibly nested, possibly wrong) id.
            for (const tgtSym of (fileSymbols.get(tgtFile) ?? []).filter(s => s.name === callee)) {
              addLink(srcSymId, graphIdForQualifiedName(tgtFileId, qualifiedName(tgtSym)), "call");
            }
          }
        }
      }
      // Named-import reference edges: import { X } from '...' → reference to tgtFile:::X,
      // for names used somewhere in the file but never resolved to a specific calling
      // symbol above (e.g. used only in a type position). File-level, not a call.
      const srcParser = parsersByExt.get(extname(srcFile));
      for (const [modPath, names] of (pf.namedImports ?? new Map<string, Set<string>>())) {
        const resolved = srcParser ? srcParser.resolveImports(srcFile, new Set([modPath]), repoPath, changedPaths) : new Map<string, string>();
        const tgtFile  = [...resolved.keys()][0];
        if (!tgtFile) continue;
        const tgtFileId = shortId(tgtFile);
        if (tgtFileId === srcFileId) continue;
        const tgtSymNames = new Set((parsed.get(tgtFile)?.symbols ?? []).map(s => s.name));
        for (const name of names) {
          if (!tgtSymNames.has(name)) continue;
          addLink(srcFileId, `${tgtFileId}:::${name}`, "reference");
        }
      }
    }
  }

  // Sibling links: connect files with the same base stem in the same directory
  // (e.g. foo.component.ts ↔ foo.component.html ↔ foo.component.scss)
  edges.push(...buildSiblingEdges(filePaths));

  return edges;
}

export function parsePr({ repoPath, prRef = "FETCH_HEAD", baseRef = "HEAD", exclude = [], parsersByExt = DEFAULT_PARSERS }: ParsePrOptions): { nodes: GraphNode[]; edges: GraphEdge[] } {
    // Each argument is passed straight to the process via spawnSync's argv array, bypassing
    // the shell entirely — so shell-special characters in refs (^, !, &, etc.) are never
    // interpreted, and callers never need to quote/escape anything themselves.
    const git = (...args: string[]): string => {
        const r = spawnSync("git", ["--no-pager", ...args], { cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git ${args[0]} failed`);
        return r.stdout;
    };
    initParsers();

    // Auto-detect the true PR base: merge-base of the remote default branch and prRef.
    // This ensures we see only the PR's own changes, not commits on main that the local
    // checkout missed (which happens when HEAD is behind origin/main).
    let effectiveBase = baseRef;
    try {
        const remoteHead = git("rev-parse", "--abbrev-ref", "origin/HEAD").trim(); // e.g. "origin/main"
        const mergeBase = git("merge-base", remoteHead, prRef).trim();
        const prSha = git("rev-parse", prRef).trim();
        // Only use the merge-base if it's strictly behind prRef.
        // If they're equal the PR is already on main and the diff would be empty.
        effectiveBase = (mergeBase !== prSha) ? mergeBase : git("rev-parse", baseRef).trim();
    } catch {
        // Fall back to caller-supplied baseRef if origin/HEAD isn't configured
        effectiveBase = baseRef;
    }

    // 1. Changed files with status
    const statusMap: Record<string, string> = { A: "added", M: "modified", D: "removed" };
    const fileStatus = new Map<string, string>();
    const diffLines = git("diff", "--name-status", `${effectiveBase}...${prRef}`).split("\n");
    for (const line of diffLines) {
        const m = line.match(/^([AMD])\t(.+)$/);
        if (!m) continue;
        const [, status, path] = m;
        if (!/\S/.test(path)) continue;
        if (/\.(spec|test|stories)\.|_test\.go/.test(path)) continue;
        if (exclude.some(p => path.includes(p))) continue;
        fileStatus.set(path, statusMap[status] ?? "modified");
    }

    const changedPaths = new Set(fileStatus.keys());

    // 2. Read PR + base content for every changed file
    const prContent   = new Map<string, string>(); // filePath → string (empty string for removed files)
    const baseContent = new Map<string, string>(); // filePath → string (empty string for added files)

    for (const [filePath, status] of fileStatus) {
        let pc = "";
        if (status !== "removed") {
            try { pc = git("show", `${prRef}:${filePath}`); } catch {}
        }
        prContent.set(filePath, pc);

        let bc = "";
        if (status !== "added") {
            try { bc = git("show", `${effectiveBase}:${filePath}`); } catch {}
        }
        baseContent.set(filePath, bc);
    }

    // 3. Parse both versions — a "removed" file has no PR content, so it's excluded
    // from the pr-side file list, and symmetrically for "added" files and the base side.
    const prFiles   = [...fileStatus.keys()].filter(p => fileStatus.get(p) !== "removed");
    const baseFiles = [...fileStatus.keys()].filter(p => fileStatus.get(p) !== "added");

    const { parsed: parsedPr, symbols: prSymbols }     = parseVersion(prFiles, prContent, parsersByExt);
    const { parsed: parsedBase, symbols: baseSymbols } = parseVersion(baseFiles, baseContent, parsersByExt);

    // 4. Nodes: a file's own status is already known directly from git, so it needs no
    // diffing; a symbol's status comes from directly comparing its two (possibly
    // absent) parsed versions, right where both are on hand.
    const nodes: GraphNode[] = [];
    for (const [filePath, status] of fileStatus) {
        const fileId = shortId(filePath);
        nodes.push({ id: fileId, label: fileId.split('/').pop()!, type: "file", status });
        nodes.push(...diffFileSymbols(fileId, prSymbols.get(filePath) ?? [], baseSymbols.get(filePath) ?? []));
    }

    // 5. Edges: built independently per version, then diffed purely by structural
    // presence (added/removed/unchanged) — see diffEdges for why edges never inherit
    // a caller/source symbol's own status the way an earlier version of this used to.
    const prEdges   = buildVersionEdges(prFiles, parsedPr, prSymbols, prContent, changedPaths, repoPath, parsersByExt);
    const baseEdges = buildVersionEdges(baseFiles, parsedBase, baseSymbols, baseContent, changedPaths, repoPath, parsersByExt);
    const edges = diffEdges(baseEdges, prEdges);

    return { nodes, edges };
}

// ── Regex fallbacks (used when tree-sitter unavailable) ───────────────────────

function extractSymbolsRegex(content: string): { kind: string; name: string }[] {
    const symbols: { kind: string; name: string }[] = [];
    for (const line of content.split("\n")) {
        let m = line.match(/^export\s+(?:async\s+)?(?:abstract\s+)?(class|interface|type|function|const|enum)\s+(\w+)/);
        if (m) { symbols.push({ kind: m[1], name: m[2] }); continue; }
        m = line.match(/^(?:func|type)\s+([A-Z]\w*)/);
        if (m) symbols.push({ kind: line.startsWith("func") ? "function" : "type", name: m[1] });
    }
    return symbols;
}

function buildRegexImportEdges(
    filePath: string, content: string, srcId: string,
    changedPaths: Set<string>, repoPath: string,
    addLink: (src: string, tar: string, type?: string) => void,
) {
    const dir = dirname(filePath);
    for (const line of content.split("\n")) {
        let m = line.match(/from\s+['"](\.[^'"]+)['"]/);
        if (!m) {
            m = line.match(/^\s+"([^"]+)"/);
            if (!m) continue;
            const importPkg = m[1].replace(/\\\\/g, "/");
            if (importPkg.startsWith(".")) continue;
            for (const candidate of changedPaths) {
                const rawDir = dirname(candidate).replace(/\\/g, "/");
                const parts  = rawDir.split("/");
                for (let len = 2; len <= parts.length; len++) {
                    const suffix = parts.slice(parts.length - len).join("/");
                    if (importPkg === suffix || importPkg.endsWith("/" + suffix)) {
                        addLink(srcId, shortId(candidate));
                        break;
                    }
                }
            }
            continue;
        }
        const absDir     = join(repoPath, dir);
        const absResolved = resolvePath(absDir, m[1]).replace(/\\/g, "/");
        const repoRoot   = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
        const repoRelative = absResolved.replace(repoRoot + "/", "");
        for (const e of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"]) {
            const candidate = repoRelative + e;
            if (changedPaths.has(candidate)) { addLink(srcId, shortId(candidate)); break; }
        }
    }
}

// Sibling links have no per-language concept at all — just file-path string matching
// — so they're built once per version directly from the file list, independent of
// whether tree-sitter (or even a registered parser) understands any of these files.
function buildSiblingEdges(filePaths: string[]): GraphEdge[] {
    const byStem = new Map<string, string[]>();
    for (const filePath of filePaths) {
        const dir  = dirname(filePath).replace(/\\/g, "/");
        const base = basename(filePath);
        // strip last 1–2 extensions: foo.component.ts → foo, foo.spec.ts → foo.spec (skipped by filter)
        const stem = base.replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, "");
        if (!stem) continue;
        const key  = dir + "/" + stem;
        if (!byStem.has(key)) byStem.set(key, []);
        byStem.get(key)!.push(filePath);
    }
    const edges: GraphEdge[] = [];
    for (const [, siblings] of byStem) {
        if (siblings.length < 2) continue;
        const ts = siblings.find(f => /\.(ts|tsx)$/.test(f));
        if (!ts) continue;
        const tsId = shortId(ts);
        for (const sibling of siblings) {
            if (sibling === ts) continue;
            edges.push({ src: tsId, tar: shortId(sibling), type: "sibling", count: 1 });
        }
    }
    return edges;
}
