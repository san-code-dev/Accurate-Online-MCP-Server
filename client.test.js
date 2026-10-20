import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createAccurateClient } from "./accurate-client.js";

function startMock() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const ts = req.headers["x-api-timestamp"], sig = req.headers["x-api-signature"];
    const exp = crypto.createHmac("sha256", "s3cret").update(ts ?? "").digest("base64");
    seen.push({ method: req.method, url: req.url, sigOK: sig === exp, auth: req.headers.authorization });
    const base = `http://127.0.0.1:${srv.address().port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/api-token.do")) {
      if (req.method !== "POST") { res.statusCode = 405; return res.end("{}"); }
      return res.end(JSON.stringify({ s: true, d: { "data usaha": { host: base, alias: "PT Uji", id: 7 }, user: { email: "u@x.id" } } }));
    }
    if (req.url.startsWith("/accurate/api/old/")) { res.statusCode = 308; res.setHeader("location", `${base}/accurate/api/glaccount/list.do`); return res.end(); }
    if (req.url.startsWith("/accurate/api/evil/")) { res.statusCode = 308; res.setHeader("location", "http://evil.example.com/steal"); return res.end(); }
    if (req.url.startsWith("/accurate/api/glaccount/list.do")) return res.end(JSON.stringify({ s: true, d: [{ id: 1 }] }));
    if (req.url.startsWith("/accurate/api/err/list.do")) { res.statusCode = 400; return res.end(JSON.stringify({ s: false, d: ["Header X-Api-Signature invalid"] })); }
    res.statusCode = 404; res.end("{}");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

const make = (port) => createAccurateClient({
  token: "tok", secret: "s3cret", accountApi: `http://127.0.0.1:${port}/api`,
  allowedHostSuffixes: ["127.0.0.1"], allowInsecureHttp: true,
});

test("POST api-token.do, parsing host, GET bertanda tangan benar", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    const h = await c.getHost(true);
    assert.equal(h.alias, "PT Uji");
    assert.deepEqual((await c.api("glaccount/list.do", { "sp.page": 1 })).d, [{ id: 1 }]);
    assert.ok(seen.every((s) => s.sigOK && s.auth === "Bearer tok"));
    assert.equal(seen[0].method, "POST");
    assert.ok(seen.slice(1).every((s) => s.method === "GET"));
  } finally { srv.close(); }
});

test("redirect 308 ke host Accurate diikuti dengan tanda tangan baru", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const r = await make(port).api("old/x.do");
    assert.deepEqual(r.d, [{ id: 1 }]);
    assert.ok(seen.every((s) => s.sigOK));
  } finally { srv.close(); }
});

test("redirect 308 ke host asing DITOLAK (token tidak bocor)", async () => {
  const { srv, port } = await startMock();
  try {
    await assert.rejects(() => make(port).api("evil/x.do"), /Diblokir: host/);
  } finally { srv.close(); }
});

test("metode selain GET (dan selain cek token) DIBLOKIR di level klien", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    const host = (await c.getHost(true)).host;
    const before = seen.length;
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      await assert.rejects(() => c.request(`${host}/accurate/api/glaccount/save.do`, { method }), /hanya HTTP GET/);
    }
    assert.equal(seen.length, before, "tidak ada request tulis yang sampai ke server");
  } finally { srv.close(); }
});

test("path tulis ditolak sebelum request dikirim", async () => {
  const { srv, seen, port } = await startMock();
  try {
    const c = make(port);
    for (const p of ["glaccount/save.do", "glaccount/delete.do", "x/bulk-save.do"]) {
      await assert.rejects(() => c.api(p), /Diblokir/);
    }
    assert.equal(seen.length, 0);
  } finally { srv.close(); }
});

test("error dari Accurate diteruskan dengan pesan jelas", async () => {
  const { srv, port } = await startMock();
  try {
    await assert.rejects(() => make(port).api("err/list.do"), /Signature invalid/);
  } finally { srv.close(); }
});

test("host dari api-token.do di luar accurate.id ditolak", async () => {
  const c = createAccurateClient({ token: "t", secret: "s", accountApi: "https://account.accurate.id/api" });
  // hostname asing tidak lolos pemeriksaan default
  await assert.rejects(() => c.request("https://evil.example.com/accurate/api/glaccount/list.do"), /Diblokir: host/);
});
