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

  assert.deepEqual([...result.callsByFunction.get("bar")!], ["helper"]);
  assert.deepEqual([...result.callsByFunction.get("method")!], ["bar"]);

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
  assert.ok(result.callsByFunction.get("count")?.has("computed"));
});

test("treats `new X()` as a callee, same as a regular call", () => {
  const src = `
export class Widget {
  private service = new GreetingService();
}
`;
  const result = parseSource(src, ".ts")!;
  assert.ok(result.callsByFunction.get("service")?.has("GreetingService"));
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
