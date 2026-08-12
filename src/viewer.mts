// viewer.mts - local HTTP server that serves the D3 force-graph UI and
// pushes graph updates to connected browsers over SSE. Framework-agnostic:
// callers pass GraphData in, get a URL + update handle back.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphData } from "./parse.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Assets ship at the package root, one level up from the compiled dist/ output.
const PKG_ROOT = join(__dirname, "..");

// D3 bundle served locally so the iframe/browser needs no internet access
const D3_JS = readFileSync(join(PKG_ROOT, "d3.min.js"), "utf8");

export interface Viewer {
  url: string;
  setGraph(data: GraphData): void;
  close(): Promise<void>;
}

function renderHtml(graphData: GraphData | undefined): string {
    const tpl = readFileSync(join(PKG_ROOT, 'graph.html'), 'utf8');
    const dataJson = JSON.stringify(graphData ?? { nodes: [], links: [], title: 'Dependency Graph' });
    return tpl.replace('__GRAPH_DATA__', dataJson);
}

function renderClientJs(graphData: GraphData | undefined): string {
    const tpl = readFileSync(join(__dirname, 'graph-client.js'), 'utf8');
    const dataJson = JSON.stringify(graphData ?? { nodes: [], links: [], title: 'Dependency Graph' });
    return tpl.replace('__GRAPH_DATA__', dataJson);
}

export function startViewer(initialGraph?: GraphData): Promise<Viewer> {
    return new Promise((resolve) => {
        const sseClients = new Set<ServerResponse>();
        let graphData: GraphData = initialGraph ?? { nodes: [], links: [], title: "Dependency Graph" };

        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url!, "http://127.0.0.1");

            if (url.pathname === "/d3.min.js") {
                res.setHeader("Content-Type", "application/javascript");
                res.end(D3_JS);
                return;
            }
            if (url.pathname === "/graph-client.js") {
                res.setHeader("Content-Type", "application/javascript");
                res.end(renderClientJs(graphData));
                return;
            }
            if (url.pathname === "/events") {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                res.write(": connected\n\n");
                sseClients.add(res);
                req.on("close", () => sseClients.delete(res));
                return;
            }
            if (url.pathname === "/graph") {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(graphData));
                return;
            }
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(graphData));
        });

        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}/`,
                setGraph(data: GraphData) {
                    graphData = data;
                    const payload = JSON.stringify({ type: "graph", payload: data });
                    for (const client of sseClients) {
                        try { client.write(`data: ${payload}\n\n`); } catch {}
                    }
                },
                close() {
                    return new Promise<void>((r) => server.close(() => r()));
                },
            });
        });
    });
}
