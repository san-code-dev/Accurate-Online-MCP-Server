import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccurateClient } from "./accurate-client.js";
import {
  buildCatalog,
  assertAllowed,
  normalizePath,
  sanitizeQuery,
  listModules,
  searchCatalog,
  describeEndpoint,
} from "./readonly-guard.js";
import { aggregateRows, collectRows } from "./aggregate.js";

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
// Mode stdio: server dijalankan langsung oleh Claude Desktop/Claude Code (tanpa port jaringan).
// Di mode ini JANGAN menulis ke stdout; semua log lewat console.error.
const STDIO = process.argv.includes("--stdio");

const {
  ACCURATE_BEARER_TOKEN,
  ACCURATE_API_SECRET,
  ACCURATE_SIG_ENCODING = "base64",
  ACCURATE_SPEC_URL = "https://account.accurate.id/open-api/json.do",
  ACCURATE_SPEC_FILE,
  MCP_AUTH_TOKEN,
  PORT = "3000",
  HOST = "127.0.0.1",
} = process.env;

const required = { ACCURATE_BEARER_TOKEN, ACCURATE_API_SECRET, ...(STDIO ? {} : { MCP_AUTH_TOKEN }) };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Env ${k} belum diisi. Lihat .env.example`);
    process.exit(1);
  }
}

const MAX_OUTPUT_CHARS = 100_000; // cegah respons raksasa membanjiri konteks Claude
const SPEC_TTL_MS = 24 * 60 * 60 * 1000;

const client = createAccurateClient({
  token: ACCURATE_BEARER_TOKEN,
  secret: ACCURATE_API_SECRET,
  sigEncoding: ACCURATE_SIG_ENCODING,
});
const fetchPage = (path, query) => client.api(path, query);

// ---------------------------------------------------------------------------
// Katalog endpoint BACA (diturunkan dari spesifikasi OpenAPI resmi Accurate)
// ---------------------------------------------------------------------------
let catalogCache = null;
async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < SPEC_TTL_MS) return catalogCache.catalog;
  let spec;
  if (ACCURATE_SPEC_FILE) {
    spec = JSON.parse(await fs.promises.readFile(ACCURATE_SPEC_FILE, "utf8"));
  } else {
    // Spesifikasi bersifat publik; token TIDAK dikirim ke URL ini.
    const res = await fetch(ACCURATE_SPEC_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Gagal mengunduh spesifikasi API Accurate (HTTP ${res.status}). Anda dapat memakai ACCURATE_SPEC_FILE.`);
    }
    spec = await res.json();
  }
  const catalog = buildCatalog(spec);
  if (catalog.size === 0) throw new Error("Katalog endpoint kosong: format spesifikasi API tidak dikenali.");
  catalogCache = { catalog, at: Date.now() };
  return catalog;
}

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------
const toText = (data) => {
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS) +
        `\n...[dipotong, ${s.length - MAX_OUTPUT_CHARS} karakter lagi. Persempit periode/filter atau gunakan parameter 'fields'.]`
    : s;
};
const ok = (data) => ({ content: [{ type: "text", text: toText(data) }] });

// Node menulis "fetch failed" tanpa sebab. Sebab sebenarnya (ENOTFOUND, ETIMEDOUT, sertifikat, dll.) ada di err.cause.
function describeError(err) {
  const c = err?.cause;
  if (!c) return err.message;
  const parts = [c.code, c.message, ...(c.errors ?? []).map((e) => e.code ?? e.message)].filter(Boolean);
  return `${err.message} (penyebab: ${[...new Set(parts)].join("; ")})`;
}
const fail = (err) => ({ isError: true, content: [{ type: "text", text: `Gagal: ${describeError(err)}` }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const querySchema = z.record(scalar).default({});

const INSTRUCTIONS = `
Server ini memberi akses BACA-SAJA ke data Accurate Online (database yang terhubung ke token).
Tidak ada tool untuk menambah, mengubah, atau menghapus data, dan hal itu memang tidak mungkin dilakukan lewat server ini.
Jika pengguna meminta menulis/mengubah/menghapus data di Accurate, tolak dan jelaskan bahwa server ini read-only.

Cara bekerja:
1. Cari endpoint dengan search_endpoints (kata kunci bebas, mis. "faktur pembelian", "stok barang", "akun perkiraan").
   Tanpa argumen: daftar modul. Dengan argumen path: parameter lengkap endpoint itu.
2. Untuk MELIHAT data (beberapa baris, detail satu dokumen): accurate_get. Gunakan "fields" agar hasil ringkas.
3. Untuk MENGHITUNG apa pun (total, jumlah, rata-rata, rekap per vendor/pelanggan/bulan/akun, laba rugi): accurate_aggregate.
   Tool ini mengambil SEMUA halaman, lalu menjumlahkan di kode dengan presisi tepat. JANGAN menjumlahkan sendiri dari hasil
   accurate_get, dan jangan menghitung total/selisih/persentase dari ingatan.
4. Format tanggal Accurate: dd/MM/yyyy. Filter biasanya filter.<field>.op / filter.<field>.val (lihat parameter endpoint).

Aturan accurate_aggregate:
- Sertakan semua field yang dipakai (group_by, metrics, where) di query.fields. Sertakan juga "id" agar duplikat bisa terdeteksi.
- Field bersarang ditulis dengan titik, mis. "vendor.name" (pastikan field induknya, mis. "vendor", ada di fields).
- Jika tool menolak karena data tidak lengkap, naikkan max_pages atau persempit filter tanggal. Jangan memakai data parsial sebagai total.
- Sampaikan semua isi "peringatan" kepada pengguna. Baris yang tidak ikut dihitung selalu dilaporkan di sana.

Contoh:
- Rekap pembelian per vendor: path "purchase-invoice/list.do", query {"fields":"id,number,transDate,totalAmount,vendor"},
  group_by ["vendor.name"], metrics [{"op":"count"},{"op":"sum","field":"totalAmount","as":"total"}].
- Penjualan per bulan: path "sales-invoice/list.do", group_by [{"field":"transDate","bucket":"month"}], metrics sum totalAmount.
- Laba rugi: path "glaccount/get-pl-account-amount.do", query {"fromDate":"01/01/2021","toDate":"31/12/2021"},
  where [{"field":"isParent","op":"eq","value":false}] (WAJIB, agar akun induk tidak terhitung dua kali), group_by ["accountType"],
  metrics [{"op":"sum","field":"amount","as":"jumlah"},{"op":"sum","field":"amount","as":"laba_bersih","signed_by":
  {"field":"accountType","map":{"REVENUE":1,"COST_OF_GOOD_SOLD":-1,"EXPENSE":-1,"OTHER_INCOME":1,"OTHER_EXPENSE":-1}}}].
  Laba kotor = REVENUE - COST_OF_GOOD_SOLD; laba usaha = laba kotor - EXPENSE. Catatan penting: tanda angka untuk pendapatan dan HPP
  sudah terbukti sesuai asumsi, tetapi untuk beban operasional, retur/diskon penjualan, dan pos di luar usaha BELUM diverifikasi
  terhadap laporan resmi Accurate. Katakan itu kepada pengguna dan sarankan mencocokkan laba bersih dengan laporan Laba Rugi di Accurate.
`.trim();

// ---------------------------------------------------------------------------
// Definisi MCP server + tools
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: "accurate-mcp", version: "0.3.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "check_connection",
    {
      title: "Cek koneksi Accurate",
      description: "Memastikan token & signature valid, dan menampilkan host serta nama database Accurate yang terhubung.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const h = await client.getHost(true);
        return ok({ status: "terhubung", host: h.host, database: h.alias, database_id: h.databaseId, user_token: h.user });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_endpoints",
    {
      title: "Cari endpoint Accurate (baca)",
      description:
        "Mencari endpoint API Accurate yang boleh dipanggil (hanya endpoint baca). " +
        "Tanpa argumen: daftar modul. Dengan 'query': pencarian kata kunci (Indonesia/Inggris). " +
        "Dengan 'path': parameter lengkap satu endpoint (mis. 'sales-invoice/list.do').",
      inputSchema: {
        query: z.string().max(200).optional().describe("Kata kunci, mis. 'faktur penjualan' atau 'stok'"),
        path: z.string().max(200).optional().describe("Path endpoint untuk melihat parameter lengkapnya"),
        limit: z.number().int().min(1).max(30).default(15).describe("Jumlah hasil maksimum"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, path, limit }) => {
      try {
        const catalog = await getCatalog();
        if (path) {
          const entry = catalog.get(normalizePath(path));
          if (!entry) throw new Error(`Endpoint '${path}' tidak ada di daftar endpoint baca.`);
          return ok(describeEndpoint(entry));
        }
        if (!query) return ok({ jumlah_endpoint_baca: catalog.size, modul: listModules(catalog) });
        return ok(searchCatalog(catalog, query, limit));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "accurate_get",
    {
      title: "Lihat data dari Accurate (read-only)",
      description:
        "Memanggil satu endpoint BACA Accurate (HTTP GET), mis. 'sales-invoice/list.do' atau 'glaccount/mutation.do', untuk MELIHAT data. " +
        "Untuk menghitung/merekap, gunakan accurate_aggregate. Hanya endpoint baca resmi (scope *_view) yang diizinkan. " +
        "Cari endpoint dan parameternya dulu dengan search_endpoints.",
      inputSchema: {
        path: z.string().max(200).describe("Path endpoint, mis. 'sales-invoice/list.do'"),
        query: querySchema.describe("Query parameter, mis. {\"fields\":\"id,number\",\"filter.transDate.op\":\"BETWEEN\",...}"),
        all_pages: z.boolean().default(false).describe("Untuk endpoint list.do: ambil beberapa halaman sekaligus dan gabungkan"),
        max_pages: z.number().int().min(1).max(20).default(5).describe("Batas halaman bila all_pages=true (100 baris/halaman)"),
      },
      annotations: READ_ONLY,
    },
    async ({ path, query, all_pages, max_pages }) => {
      try {
        const catalog = await getCatalog();
        const norm = assertAllowed(path, catalog);
        const q = sanitizeQuery(query);
        if (!(all_pages && norm.endsWith("/list.do"))) return ok(await client.api(norm, q));
        const { rows, info } = await collectRows(fetchPage, norm, q, { maxPages: max_pages, allowPartial: true });
        return ok({
          s: true,
          d: rows,
          ...info,
          ...(info.lengkap ? {} : { PERINGATAN: "Data TIDAK lengkap atau bermasalah (lihat info di atas). Jangan dijumlahkan." }),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "accurate_aggregate",
    {
      title: "Hitung dan rekap data Accurate (read-only)",
      description:
        "Mengambil SEMUA data dari satu endpoint baca Accurate (semua halaman), lalu memfilter, mengelompokkan, dan menghitung di kode " +
        "dengan presisi tepat (tanpa selisih desimal): count, count_distinct, sum, avg, min, max. Cocok untuk rekap apa pun " +
        "(per vendor, pelanggan, bulan, akun, laba rugi, dst.). Menolak data yang tidak lengkap atau duplikat, dan selalu melaporkan " +
        "baris yang tidak ikut dihitung di 'peringatan'. Lihat petunjuk server untuk contoh.",
      inputSchema: {
        path: z.string().max(200).describe("Path endpoint baca, mis. 'purchase-invoice/list.do'"),
        query: querySchema.describe("Parameter ke Accurate: wajib memuat 'fields' yang berisi semua field yang dipakai + 'id', plus filter tanggal bila perlu"),
        where: z
          .array(z.object({
            field: z.string().max(80),
            op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"]),
            value: z.union([scalar, z.array(scalar)]),
          }))
          .default([])
          .describe("Filter tambahan di sisi server MCP (semua harus terpenuhi). Mis. isParent eq false"),
        group_by: z
          .array(z.union([
            z.string().max(80),
            z.object({ field: z.string().max(80), bucket: z.enum(["year", "month"]) }),
          ]))
          .default([])
          .describe("Kelompokkan menurut field (boleh bertitik, mis. 'vendor.name') atau tanggal per 'month'/'year'"),
        metrics: z
          .array(z.object({
            op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
            field: z.string().max(80).optional().describe("Wajib kecuali op=count"),
            as: z.string().max(60).optional().describe("Nama hasil"),
            signed_by: z
              .object({
                field: z.string().max(80),
                map: z.record(z.number().int()),
                default: z.number().int().optional(),
              })
              .optional()
              .describe("Khusus sum: kalikan tiap nilai dengan bobot (mis. 1/-1/0) menurut nilai sebuah field, mis. tipe akun"),
          }))
          .default([{ op: "count" }]),
        sort: z.object({ by: z.string().max(60), order: z.enum(["asc", "desc"]).optional() }).optional()
          .describe("Urutan kelompok: by = nama metrik atau 'key'. Default: metrik pertama, terbesar dulu"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maks. kelompok ditampilkan ('total' tetap mencakup semuanya)"),
        max_pages: z.number().int().min(1).max(50).default(20).describe("Batas halaman (100 baris/halaman)"),
        allow_partial: z.boolean().default(false).describe("Izinkan data tidak lengkap. Hindari; hasil bisa menyesatkan"),
      },
      annotations: READ_ONLY,
    },
    async ({ path, query, where, group_by, metrics, sort, limit, max_pages, allow_partial }) => {
      try {
        const catalog = await getCatalog();
        const norm = assertAllowed(path, catalog);
        const q = sanitizeQuery(query);
        const { rows, info } = await collectRows(fetchPage, norm, q, { maxPages: max_pages, allowPartial: allow_partial });
        const hasil = aggregateRows(rows, { where, group_by, metrics, sort, limit });
        return ok({
          sumber: norm,
          pengambilan_data: info,
          ...hasil,
          catatan: "Semua angka dihitung di kode (bilangan bulat, tanpa pembulatan desimal liar). Nilai pada 'peringatan' tidak ikut dihitung.",
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
if (STDIO) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("Accurate MCP (stdio, read-only) siap.");
} else {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const requireAuth = (req, res, next) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    }
    next();
  };

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Mode stateless: server + transport baru untuk setiap request.
  app.post("/mcp", requireAuth, async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(Number(PORT), HOST, () => {
    console.log(`Accurate MCP (read-only) berjalan di http://${HOST}:${PORT}/mcp`);
  });
}
