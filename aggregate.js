// Pengambilan data lengkap + perhitungan otomatis (filter, kelompok, jumlah, dst.) untuk laporan apa pun.
// Prinsip: semua angka dihitung di sini, dengan bilangan bulat (BigInt) agar tidak ada selisih desimal,
// dan data yang tidak lengkap/duplikat/tidak valid TIDAK pernah dihitung diam-diam (error atau peringatan eksplisit).

const MAX_DEC = 8;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const OPS = new Set(["count", "count_distinct", "sum", "avg", "min", "max"]);
const NUMERIC_OPS = new Set(["sum", "avg", "min", "max"]);
const WHERE_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"]);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function assertField(name) {
  if (typeof name !== "string" || name.length > 80 || !FIELD_RE.test(name) || name.split(".").some((s) => FORBIDDEN.has(s))) {
    throw new Error(`Nama field tidak valid: '${name}'`);
  }
  return name;
}

export function getPath(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    // Teks seperti "1.000" ambigu (1,0 atau seribu dengan pemisah ribuan format Indonesia): TOLAK, jangan ditebak.
    if (/^-?\d{1,3}\.\d{3}$/.test(t)) return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  }
  return null;
}

function decimalsOf(n) {
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(MAX_DEC);
  const i = s.indexOf(".");
  if (i < 0) return 0;
  return Math.min(s.slice(i + 1).replace(/0+$/, "").length, MAX_DEC);
}

function scaleValue(n, dec) {
  const x = Math.round(n * 10 ** dec);
  if (!Number.isSafeInteger(x)) throw new Error("Angka terlalu besar untuk dijumlahkan dengan aman.");
  return BigInt(x);
}

function fromScaled(big, dec) {
  const neg = big < 0n;
  let s = (neg ? -big : big).toString();
  if (dec > 0) {
    s = s.padStart(dec + 1, "0");
    s = `${s.slice(0, -dec)}.${s.slice(-dec)}`;
  }
  const text = (neg ? "-" : "") + s;
  const n = Number(text);
  return Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : text; // terlalu besar untuk Number: kembalikan teks eksak
}

function parseDate(v) {
  if (typeof v !== "string") return null;
  let m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s|$)/.exec(v.trim());
  let d, mo, y;
  if (m) [, d, mo, y] = m;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()))) [, y, mo, d] = m;
  else return null;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return { y, m: mo };
}

const norm = (v) => (v === null || v === undefined ? v : String(v));

function matches(row, w) {
  const a = getPath(row, w.field);
  switch (w.op) {
    case "eq": return norm(a) === norm(w.value);
    case "ne": return norm(a) !== norm(w.value);
    case "in": return Array.isArray(w.value) && w.value.some((x) => norm(x) === norm(a));
    case "contains": return typeof a === "string" && a.toLowerCase().includes(String(w.value).toLowerCase());
    default: {
      const x = toNumber(a), y = toNumber(w.value);
      if (x === null || y === null) return false;
      return w.op === "gt" ? x > y : w.op === "gte" ? x >= y : w.op === "lt" ? x < y : x <= y;
    }
  }
}

function normalizeMetrics(input) {
  const list = input?.length ? input : [{ op: "count" }];
  const seen = new Set();
  return list.map((m) => {
    if (!OPS.has(m.op)) throw new Error(`Operasi metrik tidak dikenal: '${m.op}'. Pilihan: ${[...OPS].join(", ")}`);
    if (m.op !== "count") {
      if (!m.field) throw new Error(`Metrik '${m.op}' wajib punya field.`);
      assertField(m.field);
    }
    if (m.signed_by) {
      if (m.op !== "sum") throw new Error("signed_by hanya untuk metrik 'sum'.");
      assertField(m.signed_by.field);
      const weights = [...Object.values(m.signed_by.map ?? {}), ...(m.signed_by.default === undefined ? [] : [m.signed_by.default])];
      if (!weights.length || !weights.every((w) => Number.isInteger(w))) {
        throw new Error("signed_by.map dan default harus berisi bilangan bulat (mis. 1, -1, 0).");
      }
    }
    const alias = m.as ?? (m.op === "count" ? "jumlah" : `${m.op}_${m.field.replace(/\./g, "_")}`);
    if (seen.has(alias)) throw new Error(`Nama metrik ganda: '${alias}'. Beri nama berbeda dengan 'as'.`);
    seen.add(alias);
    return { ...m, alias };
  });
}

export function aggregateRows(rows, spec = {}) {
  if (!Array.isArray(rows)) throw new Error("rows harus berupa array.");
  const metrics = normalizeMetrics(spec.metrics);
  const where = (spec.where ?? []).map((w) => {
    assertField(w.field);
    if (!WHERE_OPS.has(w.op)) throw new Error(`Operator filter tidak dikenal: '${w.op}'. Pilihan: ${[...WHERE_OPS].join(", ")}`);
    return w;
  });
  const groupSpecs = (spec.group_by ?? []).map((g) => {
    const s = typeof g === "string" ? { field: g } : g;
    assertField(s.field);
    if (s.bucket && !["year", "month"].includes(s.bucket)) throw new Error("bucket harus 'year' atau 'month'.");
    return s;
  });
  const limit = Math.min(Math.max(spec.limit ?? 50, 1), 500);

  const filtered = rows.filter((r) => where.every((w) => matches(r, w)));

  // Skala desimal per metrik (agar penjumlahan eksak)
  const decs = metrics.map((m) => {
    if (!NUMERIC_OPS.has(m.op)) return 0;
    let d = 0;
    for (const r of filtered) {
      const n = toNumber(getPath(r, m.field));
      if (n !== null) d = Math.max(d, decimalsOf(n));
    }
    return d;
  });

  const newAcc = () => metrics.map(() => ({ n: 0, sum: 0n, min: null, max: null, set: new Set(), invalid: 0, unmapped: new Map() }));
  const update = (acc, row) => {
    metrics.forEach((m, i) => {
      const a = acc[i];
      if (m.op === "count") { a.n++; return; }
      const v = getPath(row, m.field);
      if (m.op === "count_distinct") {
        if (v !== undefined && v !== null) a.set.add(typeof v === "object" ? JSON.stringify(v) : String(v));
        return;
      }
      const n = toNumber(v);
      if (n === null) { a.invalid++; return; }
      if (m.op === "min") { a.n++; a.min = a.min === null ? n : Math.min(a.min, n); return; }
      if (m.op === "max") { a.n++; a.max = a.max === null ? n : Math.max(a.max, n); return; }
      let scaled = scaleValue(n, decs[i]);
      if (m.signed_by) {
        const k = norm(getPath(row, m.signed_by.field));
        const w = hasOwn(m.signed_by.map ?? {}, k) ? m.signed_by.map[k] : m.signed_by.default;
        if (w === undefined) { a.unmapped.set(String(k), (a.unmapped.get(String(k)) ?? 0) + 1); return; }
        scaled *= BigInt(w);
      }
      a.sum += scaled;
      a.n++;
    });
  };
  const finalize = (acc) => Object.fromEntries(metrics.map((m, i) => {
    const a = acc[i];
    let v;
    if (m.op === "count") v = a.n;
    else if (m.op === "count_distinct") v = a.set.size;
    else if (m.op === "sum") v = fromScaled(a.sum, decs[i]);
    else if (m.op === "avg") v = a.n ? Number((Number(a.sum) / 10 ** decs[i] / a.n).toFixed(Math.min(decs[i] + 2, MAX_DEC))) : null;
    else v = m.op === "min" ? a.min : a.max;
    return [m.alias, v];
  }));

  const groups = new Map();
  const totalAcc = newAcc();
  let dateInvalid = 0, objectLabels = 0;
  for (const row of filtered) {
    update(totalAcc, row);
    if (!groupSpecs.length) continue;
    const labels = groupSpecs.map((g) => {
      const v = getPath(row, g.field);
      if (g.bucket) {
        const p = parseDate(v);
        if (!p) { dateInvalid++; return "(tanggal tidak valid)"; }
        return g.bucket === "year" ? p.y : `${p.y}-${p.m}`;
      }
      if (v === undefined || v === null || v === "") return "(kosong)";
      if (typeof v === "object") { objectLabels++; return "(objek)"; }
      return String(v);
    });
    const key = JSON.stringify(labels);
    if (!groups.has(key)) groups.set(key, { labels, acc: newAcc() });
    update(groups.get(key).acc, row);
  }

  // Peringatan eksplisit untuk apa pun yang tidak ikut terhitung
  const peringatan = [];
  metrics.forEach((m, i) => {
    const a = totalAcc[i];
    if (a.invalid) peringatan.push(`Metrik '${m.alias}': ${a.invalid} baris punya '${m.field}' kosong/bukan angka dan TIDAK ikut dihitung.`);
    if (a.unmapped.size) {
      const list = [...a.unmapped].map(([k, c]) => `${k} (${c} baris)`).join(", ");
      peringatan.push(`Metrik '${m.alias}': nilai '${m.signed_by.field}' tidak ada di map dan TIDAK ikut dihitung: ${list}.`);
    }
  });
  if (dateInvalid) peringatan.push(`${dateInvalid} baris punya tanggal tidak valid pada group_by (dikelompokkan sebagai "(tanggal tidak valid)").`);
  if (objectLabels) peringatan.push(`${objectLabels} baris punya nilai berupa objek pada group_by; gunakan field bertitik, mis. 'vendor.name'.`);

  const result = {
    baris_masukan: rows.length,
    baris_dihitung: filtered.length,
    total: finalize(totalAcc),
    peringatan,
  };

  if (groupSpecs.length) {
    const sortBy = spec.sort?.by ?? metrics[0].alias;
    const order = spec.sort?.order ?? (sortBy === "key" ? "asc" : "desc");
    if (sortBy !== "key" && !metrics.some((m) => m.alias === sortBy)) {
      throw new Error(`sort.by '${sortBy}' tidak ada. Gunakan 'key' atau salah satu nama metrik: ${metrics.map((m) => m.alias).join(", ")}`);
    }
    const entries = [...groups.values()].map((g) => ({
      kunci: Object.fromEntries(groupSpecs.map((s, i) => [s.bucket ? `${s.field}(${s.bucket})` : s.field, g.labels[i]])),
      nilai: finalize(g.acc),
      _k: g.labels.join("\u0001"),
    }));
    entries.sort((x, y) => {
      let c;
      if (sortBy === "key") c = x._k.localeCompare(y._k);
      else {
        const a = Number(x.nilai[sortBy] ?? -Infinity), b = Number(y.nilai[sortBy] ?? -Infinity);
        c = a < b ? -1 : a > b ? 1 : 0;
      }
      return (order === "asc" ? c : -c) || x._k.localeCompare(y._k);
    });
    result.jumlah_kelompok = entries.length;
    result.kelompok = entries.slice(0, limit).map(({ kunci, nilai }) => ({ kunci, nilai }));
    if (entries.length > limit) {
      result.kelompok_dipotong = true;
      result.catatan_potong = `Hanya ${limit} dari ${entries.length} kelompok ditampilkan. 'total' tetap mencakup SEMUA kelompok.`;
    }
  }
  return result;
}

/**
 * Ambil semua baris dari sebuah endpoint (semua halaman). fetchPage(path, query) -> respons Accurate.
 * Menolak (error) data yang tidak lengkap, jumlah baris tidak cocok, atau duplikat, kecuali allowPartial = true.
 */
export async function collectRows(fetchPage, path, query, { maxPages = 20, allowPartial = false } = {}) {
  const isList = path.endsWith("/list.do");
  const first = await fetchPage(path, isList ? { ...query, "sp.page": 1, "sp.pageSize": 100 } : query);
  if (!Array.isArray(first?.d)) throw new Error("Endpoint ini tidak mengembalikan daftar (d bukan array), tidak bisa dijumlahkan.");
  const rows = [...first.d];
  const sp = first.sp ?? null;
  const pageCount = sp?.pageCount ?? 1;
  const pageSize = sp?.pageSize ?? 100;
  let fetched = 1;
  for (let p = 2; p <= Math.min(pageCount, maxPages); p++) {
    const body = await fetchPage(path, { ...query, "sp.page": p, "sp.pageSize": pageSize });
    if (!Array.isArray(body?.d)) throw new Error(`Halaman ${p} tidak mengembalikan daftar.`);
    rows.push(...body.d);
    fetched = p;
  }
  const expected = sp?.rowCount ?? null;
  const complete = fetched >= pageCount;
  const countOk = expected === null || rows.length === expected;
  let duplicates = 0;
  if (rows.length && rows.every((r) => r && r.id !== undefined && r.id !== null)) {
    duplicates = rows.length - new Set(rows.map((r) => r.id)).size;
  }
  const info = {
    halaman_diambil: fetched,
    halaman_total: pageCount,
    baris_diambil: rows.length,
    baris_menurut_accurate: expected,
    lengkap: complete && countOk && duplicates === 0,
    ...(duplicates ? { id_duplikat: duplicates } : {}),
  };
  if (!allowPartial) {
    if (!complete) {
      throw new Error(
        `Data tidak lengkap: hanya ${fetched} dari ${pageCount} halaman (${rows.length} dari ${expected ?? "?"} baris). ` +
          "Naikkan max_pages (maks. 50) atau persempit filter. Menjumlahkan data parsial akan menyesatkan."
      );
    }
    if (!countOk) throw new Error(`Jumlah baris tidak cocok (diambil ${rows.length}, menurut Accurate ${expected}). Data mungkin berubah saat diambil, ulangi.`);
    if (duplicates) throw new Error(`Terdeteksi ${duplicates} baris duplikat (data berubah saat diambil). Ulangi permintaan.`);
  }
  return { rows, info };
}
