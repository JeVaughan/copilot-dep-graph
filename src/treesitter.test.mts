import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initParsers, parseSource, isAvailable } from "../dist/index.mjs";

before(() => {
  initParsers();
});

test("tree-sitter native bindings load", () => {
  assert.equal(isAvailable(), true);
});

test("parses TS function, class, methods, calls and imports", () => {
  const src = `
import { helper } from "./util";
import { A, B } from "./types";

export function bar() { return helper(); }

export class Baz {
  method() { bar(); }
}
`;
  const result = parseSource(src, ".ts")!;
  const names = result.symbols.map(s => s.name).sort();
  assert.deepEqual(names, ["Baz", "bar", "method"].sort());
  assert.equal(result.symbols.find(s => s.name === "method")?.parent, "Baz");

  // "method" lives inside class Baz, so its callsByFunction key is qualified;
  // "bar" is a top-level function, so it stays bare.
  assert.deepEqual([...result.callsByFunction.get("bar")!], ["helper"]);
  assert.deepEqual([...result.callsByFunction.get("Baz.method")!], ["bar"]);

  assert.deepEqual([...result.imports].sort(), ["./types", "./util"]);
  assert.deepEqual([...result.namedImports!.get("./types")!].sort(), ["A", "B"]);
});

test("parses TS class fields and signal-style call expressions", () => {
  const src = `
export class Widget {
  count = computed(() => this.base());
  base() { return 1; }
}
`;
  const result = parseSource(src, ".ts")!;
  assert.ok(result.callsByFunction.get("Widget.count")?.has("computed"));
});

test("treats `new X()` as a callee, same as a regular call", () => {
  const src = `
export class Widget {
  private service = new GreetingService();
}
`;
  const result = parseSource(src, ".ts")!;
  assert.ok(result.callsByFunction.get("Widget.service")?.has("GreetingService"));
});

test("qualifies callsByFunction keys by enclosing class, so same-named methods on different classes don't merge callees", () => {
  const src = `
export class A {
  run() { fromA(); }
}
export class B {
  run() { fromB(); }
}
`;
  const result = parseSource(src, ".ts")!;
  assert.deepEqual([...result.callsByFunction.get("A.run")!], ["fromA"]);
  assert.deepEqual([...result.callsByFunction.get("B.run")!], ["fromB"]);
  assert.equal(result.callsByFunction.get("run"), undefined, "bare 'run' should not exist once both methods are qualified");

  const runs = result.symbols.filter(s => s.name === "run");
  assert.deepEqual(runs.map(s => s.parent).sort(), ["A", "B"]);
});

test("parses Go functions, methods and exported types", () => {
  const src = `
package main

import "fmt"

func Helper() int { return 1 }

type Server struct{}

func (s *Server) Run() { fmt.Println(Helper()) }

func notExported() {}
`;
  const result = parseSource(src, ".go")!;
  const names = result.symbols.map(s => s.name).sort();
  assert.deepEqual(names, ["Helper", "Run", "Server"]);
  assert.deepEqual([...result.imports], ["fmt"]);
  assert.ok(result.callsByFunction.get("Run")?.has("Helper"));
});

test("returns null for unsupported extensions and empty content", () => {
  assert.equal(parseSource("export const x = 1;", ".css"), null);
  assert.equal(parseSource("", ".ts"), null);
});

test("returns null instead of handing null-byte content to the native parser", () => {
  // Binary files that slip past the extension filter can contain \0, which crashes
  // some native tree-sitter bindings outright rather than throwing a catchable error.
  assert.equal(parseSource("export const x = 1;\0binary junk", ".ts"), null);
});
