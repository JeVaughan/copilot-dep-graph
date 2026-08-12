// treesitter.mjs - AST parser using tree-sitter for TS/Go source files.
// Gracefully falls back (returns null) if native bindings fail to load.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let Parser, tsLang, tsxLang, goLang, _available = false;

export function initParsers() {
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

export function isAvailable() { return _available; }

// Collect all descendant nodes of given types (depth-first)
function collect(node, ...types) {
  const out = [];
  function walk(n) {
    if (types.includes(n.type)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  }
  walk(node);
  return out;
}

// First source line containing startIndex
function sigLine(src, startIndex) {
  const s = src.lastIndexOf('\n', startIndex - 1) + 1;
  const e = src.indexOf('\n', startIndex);
  return src.slice(s, e < 0 ? src.length : e).trimEnd();
}

/**
 * Parse source and return:
 *   symbols:          Array<{ name, kind, signature }>
 *   callsByFunction:  Map<funcName, Set<calleeName>>
 *   imports:          Set<rawImportString>
 *
 * Returns null if tree-sitter unavailable or language unsupported.
 */
export function parseSource(content, fileExt) {
  if (!_available || !content) return null;
  const lang = fileExt === '.go'  ? goLang
             : fileExt === '.tsx' ? tsxLang
             : (fileExt === '.ts' || fileExt === '.js' || fileExt === '.jsx') ? tsLang
             : null;
  if (!lang) return null;

  const parser = new Parser();
  parser.setLanguage(lang);
  const root = parser.parse(content).rootNode;
  return fileExt === '.go' ? parseGo(root, content) : parseTS(root, content);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function collectCallees(bodyNode) {
  const out = new Set();
  for (const call of collect(bodyNode, 'call_expression')) {
    const fn = call.childForFieldName('function') ?? call.namedChildren[0];
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

function mergeCalls(map, fnName, callees) {
  if (!map.has(fnName)) map.set(fnName, new Set());
  for (const c of callees) map.get(fnName).add(c);
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────────

function parseTS(root, content) {
  const symbols = [], callsByFunction = new Map(), imports = new Set();
  // namedImports: modulePath → Set<importedName>
  const namedImports = new Map();

  for (const node of collect(root, 'import_statement')) {
    const src = node.childForFieldName('source');
    if (!src) continue;
    const modPath = src.text.replace(/^['"]|['"]$/g, '');
    imports.add(modPath);
    // Collect specific named imports: import { X, Y } from '...'
    const clause = node.namedChildren.find(c => c.type === 'import_clause');
    const namedNode = clause?.namedChildren.find(c => c.type === 'named_imports');
    if (namedNode) {
      const names = new Set();
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
      ?? exp.namedChildren.find(c => !['export', 'default'].includes(c.type));
    if (decl) extractTSDecl(decl, content, symbols);
  }

  for (const fn of collect(root, 'function_declaration', 'method_definition')) {
    const name = fn.childForFieldName('name')?.text;
    const body = fn.childForFieldName('body');
    if (name && body) {
      const callees = collectCallees(body);
      if (callees.size) mergeCalls(callsByFunction, name, callees);
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
    if (callees.size) mergeCalls(callsByFunction, name, callees);
  }

  return { symbols, callsByFunction, imports, namedImports };
}

function extractTSDecl(decl, content, symbols) {
  const push = (name, kind) =>
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
          let mname, kind;
          if (member.type === 'method_definition') {
            mname = member.childForFieldName('name')?.text; kind = 'method';
          } else if (member.type === 'public_field_definition' || member.type === 'field_definition') {
            mname = member.childForFieldName('name')?.text; kind = 'property';
          }
          if (mname) symbols.push({ name: mname, kind, signature: sigLine(content, member.startIndex), body: content.slice(member.startIndex, member.endIndex) });
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
      for (const vd of decl.namedChildren.filter(c => c.type === 'variable_declarator')) {
        const val = vd.childForFieldName('value');
        const kind = (val?.type === 'arrow_function' || val?.type === 'function_expression')
                   ? 'function' : 'const';
        push(vd.childForFieldName('name')?.text, kind);
      }
      break;
  }
}

// ── Go ────────────────────────────────────────────────────────────────────────

function parseGo(root, content) {
  const symbols = [], callsByFunction = new Map(), imports = new Set();

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
