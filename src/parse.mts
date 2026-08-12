// parse.mts - builds a file/symbol dependency graph from a git PR diff.
// Deterministic (git + tree-sitter AST). No AI involved.

import { execSync } from "node:child_process";
import { resolve as resolvePath, dirname, basename, extname, join } from "node:path";
import { initParsers, parseSource, isAvailable, type Symbol as ParsedSymbol } from "./treesitter.mjs";

export interface GraphNode {
  id: string;
  label: string;
  path: string;
  status: string;
  symbols?: (ParsedSymbol & { status: string })[];
}

export interface GraphLink {
  source: string;
  target: string;
  status?: string | null;
  _linkType: string;
  sourceFile?: string;
  targetFile?: string;
}

export interface GraphData {
  title?: string;
  nodes: GraphNode[];
  links: GraphLink[];
  error?: string;
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

export interface ParsePrOptions {
  repoPath: string;
  prRef?: string;
  baseRef?: string;
  exclude?: string[];
}

export function parsePr({ repoPath, prRef = "FETCH_HEAD", baseRef = "HEAD", exclude = [] }: ParsePrOptions): { nodes: GraphNode[]; links: GraphLink[] } {
    const git = (cmd: string) => execSync(`git --no-pager ${cmd}`, { cwd: repoPath, encoding: "utf8" });
    initParsers();

    // Auto-detect the true PR base: merge-base of the remote default branch and prRef.
    // This ensures we see only the PR's own changes, not commits on main that the local
    // checkout missed (which happens when HEAD is behind origin/main).
    let effectiveBase = baseRef;
    try {
        const remoteHead = git("rev-parse --abbrev-ref origin/HEAD").trim(); // e.g. "origin/main"
        effectiveBase = git(`merge-base ${remoteHead} ${prRef}`).trim();
    } catch {
        // Fall back to caller-supplied baseRef if origin/HEAD isn't configured
        effectiveBase = baseRef;
    }

    // 1. Changed files with status
    const statusMap: Record<string, string> = { A: "added", M: "modified", D: "removed" };
    const fileStatus = new Map<string, string>();
    const diffLines = git(`diff --name-status ${effectiveBase}...${prRef}`).split("\n");
    for (const line of diffLines) {
        const m = line.match(/^([AMD])\t(.+)$/);
        if (!m) continue;
        const [, status, path] = m;
        if (!/\S/.test(path)) continue;
        if (/\.(spec|test|stories)\.|_test\.go/.test(path)) continue;
        if (exclude.some(p => path.includes(p))) continue;
        fileStatus.set(path, statusMap[status] ?? "modified");
    }

    const prPaths = new Set(fileStatus.keys());

    function shortId(p: string): string {
        return p
            .replace(/^frontend\/projects\/app-member\/src\/app\//, "")
            .replace(/^backend\/services\//, "backend/");
    }

    // 2. Read PR + base content for every changed file
    const prContent   = new Map<string, string>(); // filePath → string (empty string for removed files)
    const baseContent = new Map<string, string>(); // filePath → string (empty string for added files)

    for (const [filePath, status] of fileStatus) {
        let pc = "";
        if (status !== "removed") {
            try { pc = git(`show "${prRef}:${filePath}"`); } catch {}
        }
        prContent.set(filePath, pc);

        let bc = "";
        if (status !== "added") {
            try { bc = git(`show "${effectiveBase}:${filePath}"`); } catch {}
        }
        baseContent.set(filePath, bc);
    }

    // 3. Parse both versions
    const parsedPr   = new Map<string, ReturnType<typeof parseSource>>();
    const parsedBase = new Map<string, ReturnType<typeof parseSource>>();

    for (const [filePath] of fileStatus) {
        const ext = extname(filePath);
        const pp = parseSource(prContent.get(filePath)!,   ext);
        const bp = parseSource(baseContent.get(filePath)!, ext);
        if (pp) parsedPr.set(filePath, pp);
        if (bp) parsedBase.set(filePath, bp);
    }

    // 4. Build nodes with symbol diffs
    const nodes: GraphNode[] = [];
    for (const [filePath, status] of fileStatus) {
        const pp = parsedPr.get(filePath);
        const bp = parsedBase.get(filePath);

        let symbols: (ParsedSymbol & { status: string })[];
        if (pp || bp) {
            const prSyms   = pp?.symbols ?? [];
            const baseSyms = bp?.symbols ?? [];
            const baseMap  = new Map(baseSyms.map(s => [s.name, s]));
            const prMap    = new Map(prSyms.map(s => [s.name, s]));
            const diffed: (ParsedSymbol & { status: string })[] = [];

            for (const sym of prSyms) {
                const base = baseMap.get(sym.name);
                const symStatus = !base                               ? "added"
                                : (base.body ?? base.signature) !== (sym.body ?? sym.signature) ? "modified"
                                : "unchanged";
                diffed.push({ ...sym, status: symStatus });
            }
            for (const sym of baseSyms) {
                if (!prMap.has(sym.name)) diffed.push({ ...sym, status: "removed" });
            }
            symbols = diffed;
        } else {
            // Regex fallback
            symbols = extractSymbolsRegex(prContent.get(filePath) || baseContent.get(filePath) || "").map(s => ({ ...s, status: "unchanged" }));
        }

        const node: GraphNode = { id: shortId(filePath), label: shortId(filePath), path: filePath, status };
        if (symbols.length) node.symbols = symbols;
        nodes.push(node);
    }

    // 5. Build edges
    const links: GraphLink[]     = [];
    const seenLinks = new Set<string>();

    function addLink(src: string, tgt: string, status: string | null | undefined, linkType = "import") {
        if (src === tgt) return;
        const key = `${src}->${tgt}:${linkType}`;
        if (seenLinks.has(key)) return;
        seenLinks.add(key);
        links.push({ source: src, target: tgt, status, _linkType: linkType });
    }

    // Resolve a Go import path to a PR file path via suffix matching (Go files only)
    function resolveGoImport(importPkg: string): string | null {
        for (const candidate of prPaths) {
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

    // Resolve a relative TS import to a PR file path
    function resolveTsImport(filePath: string, importPath: string): string | null {
        const absDir     = join(repoPath, dirname(filePath));
        const absResolved = resolvePath(absDir, importPath).replace(/\\/g, "/");
        const repoRoot   = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
        const rel        = absResolved.replace(repoRoot + "/", "");
        for (const e of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"]) {
            const candidate = rel + e;
            if (prPaths.has(candidate)) return candidate;
        }
        return null;
    }

    // Resolve a Set<importString> to Map<tgtFilePath, importString>
    function resolveImports(filePath: string, imports: Set<string>): Map<string, string> {
        const result = new Map<string, string>();
        for (const imp of imports) {
            let tgt: string | null = null;
            if (imp.startsWith(".")) {
                tgt = resolveTsImport(filePath, imp);
            } else {
                // Try Go suffix-matching first (package paths)
                tgt = resolveGoImport(imp);
                if (!tgt) {
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
                        for (const candidate of prPaths) {
                            if (candidate === suffix || candidate.endsWith("/" + suffix)) {
                                tgt = candidate; break;
                            }
                        }
                        if (tgt) break;
                    }
                }
            }
            if (tgt) result.set(tgt, imp);
        }
        return result;
    }

    for (const [filePath, fileStatus_] of fileStatus) {
        const srcId  = shortId(filePath);
        const pp     = parsedPr.get(filePath);
        const bp     = parsedBase.get(filePath);

        if (pp || bp) {
            const prImps   = resolveImports(filePath, pp?.imports ?? new Set());
            const baseImps = resolveImports(filePath, bp?.imports ?? new Set());

            // PR imports: added or unchanged
            for (const [tgtFile] of prImps) {
                const edgeStatus = baseImps.has(tgtFile) ? "unchanged" : "added";
                addLink(srcId, shortId(tgtFile), edgeStatus);
            }
            // Imports only in base: removed
            for (const [tgtFile] of baseImps) {
                if (!prImps.has(tgtFile)) addLink(srcId, shortId(tgtFile), "removed");
            }
        } else {
            buildRegexEdges(filePath, prContent.get(filePath) || "", srcId,
                            fileStatus_, prPaths, repoPath, shortId, addLink);
        }
    }

    // 6. Symbol-symbol call edges (only when tree-sitter is available)
    if (isAvailable()) {
        // Build a cross-file symbol index: symbolName → filePath[]
        const symbolIndex = new Map<string, string[]>();
        for (const [filePath] of fileStatus) {
            const pp = parsedPr.get(filePath);
            if (!pp) continue;
            for (const sym of pp.symbols) {
                if (!symbolIndex.has(sym.name)) symbolIndex.set(sym.name, []);
                symbolIndex.get(sym.name)!.push(filePath);
            }
        }

        for (const [srcFile] of fileStatus) {
            const pp = parsedPr.get(srcFile);
            if (!pp) continue;
            const srcFileId = shortId(srcFile);
            // Build a per-file symbol status lookup so edges carry the symbol's own diff status
            const symStatus = new Map(pp.symbols.map(s => [s.name, (s as any).status ?? null]));
            for (const [fnName, callees] of pp.callsByFunction) {
                const srcSymId = `${srcFileId}:::${fnName}`;
                const edgeStatus = symStatus.get(fnName) ?? null;
                for (const callee of callees) {
                    for (const tgtFile of (symbolIndex.get(callee) ?? [])) {
                        const tgtFileId = shortId(tgtFile);
                        const key = `${srcSymId}->${tgtFileId}:::${callee}:call`;
                        if (seenLinks.has(key)) continue;
                        seenLinks.add(key);
                        links.push({
                            source: srcSymId, target: `${tgtFileId}:::${callee}`,
                            sourceFile: srcFileId, targetFile: tgtFileId,
                            _linkType: 'call', status: edgeStatus
                        });
                    }
                }
            }
            // Named-import reference edges: import { X } from '...' → reference to tgtFile:::X
            // This covers type references, value references, anything explicitly imported by name.
            for (const [modPath, names] of (pp.namedImports ?? new Map<string, Set<string>>())) {
                const resolved = resolveImports(srcFile, new Set([modPath]));
                const tgtFile  = [...resolved.keys()][0];
                if (!tgtFile) continue;
                const tgtFileId = shortId(tgtFile);
                if (tgtFileId === srcFileId) continue;
                const tgtSymNames = new Set((parsedPr.get(tgtFile)?.symbols ?? []).map(s => s.name));
                for (const name of names) {
                    if (!tgtSymNames.has(name)) continue;
                    const key = `${srcFileId}->${tgtFileId}:::${name}:call`;
                    if (seenLinks.has(key)) continue;
                    seenLinks.add(key);
                    links.push({
                        source: srcFileId, target: `${tgtFileId}:::${name}`,
                        sourceFile: srcFileId, targetFile: tgtFileId,
                        _linkType: 'call'
                    });
                }
            }
        }
    }

    // 7. Sibling links: connect files with the same base stem in the same directory
    // (e.g. foo.component.ts ↔ foo.component.html ↔ foo.component.scss)
    {
        const byStem = new Map<string, string[]>();
        for (const filePath of fileStatus.keys()) {
            const dir  = dirname(filePath).replace(/\\/g, "/");
            const base = basename(filePath);
            // strip last 1–2 extensions: foo.component.ts → foo, foo.spec.ts → foo.spec (skipped by filter)
            const stem = base.replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, "");
            if (!stem) continue;
            const key  = dir + "/" + stem;
            if (!byStem.has(key)) byStem.set(key, []);
            byStem.get(key)!.push(filePath);
        }
        for (const [, siblings] of byStem) {
            if (siblings.length < 2) continue;
            const ts = siblings.find(f => /\.(ts|tsx)$/.test(f));
            if (!ts) continue;
            const tsId = shortId(ts);
            for (const sibling of siblings) {
                if (sibling === ts) continue;
                addLink(tsId, shortId(sibling), "sibling", "sibling");
            }
        }
    }

    return { nodes, links };
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

function buildRegexEdges(
    filePath: string, content: string, srcId: string, status: string,
    prPaths: Set<string>, repoPath: string, shortId: (p: string) => string,
    addLink: (src: string, tgt: string, status: string | null | undefined, linkType?: string) => void,
) {
    const dir = dirname(filePath);
    for (const line of content.split("\n")) {
        let m = line.match(/from\s+['"](\.[^'"]+)['"]/);
        if (!m) {
            m = line.match(/^\s+"([^"]+)"/);
            if (!m) continue;
            const importPkg = m[1].replace(/\\\\/g, "/");
            if (importPkg.startsWith(".")) continue;
            for (const candidate of prPaths) {
                const rawDir = dirname(candidate).replace(/\\/g, "/");
                const parts  = rawDir.split("/");
                for (let len = 2; len <= parts.length; len++) {
                    const suffix = parts.slice(parts.length - len).join("/");
                    if (importPkg === suffix || importPkg.endsWith("/" + suffix)) {
                        addLink(srcId, shortId(candidate), status);
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
            if (prPaths.has(candidate)) { addLink(srcId, shortId(candidate), status); break; }
        }
    }
}
