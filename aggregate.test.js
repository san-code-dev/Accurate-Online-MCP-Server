import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRows, collectRows, getPath, assertField } from "./aggregate.js";

// ---- 12 faktur pembelian nyata dari percobaan (database "Manufaktur Demo") ----
const V = { 50: { vendorNo: "V.00001", name: "PT Pack Multi Guna Abadi", id: 50 }, 100: { vendorNo: "V.00002", name: "PT Plastic Energy Sejahtera", id: 100 }, 150: { vendorNo: "V.00003", name: "PT AUTO PART LAMP", id: 150 } };
const PI = [
  [155, "24/06/2021", 50, 1000000], [154, "21/06/2021", 150, 37205000], [101, "18/06/2021", 50, 2000000], [153, "17/06/2021", 150, 1225000],
  [152, "17/06/2021", 150, 600000], [102, "15/06/2021", 100, 800000], [151, "12/06/2021", 100, 2300000], [201, "12/06/2021", 150, 19999000],
  [200, "12/06/2021", 50, 1900000], [100, "09/06/2021", 100, 2500000], [50, "06/06/2021", 50, 2000000], [150, "05/06/2021", 150, 26617500],
].map(([id, transDate, v, totalAmount]) => ({ id, number: `PI.${id}`, transDate, totalAmount, vendor: V[v] }));

test("rekap pembelian per vendor sama dengan hitungan manual (98.146.500)", () => {
  const r = aggregateRows(PI, { group_by: ["vendor.name"], metrics: [{ op: "count" }, { op: "sum", field: "totalAmount", as: "total" }] });
  assert.deepEqual(r.kelompok.map((k) => [k.kunci["vendor.name"], k.nilai.jumlah, k.nilai.total]), [
    ["PT AUTO PART LAMP", 5, 85646500], ["PT Pack Multi Guna Abadi", 4, 6900000], ["PT Plastic Energy Sejahtera", 3, 5600000],
  ]);
  assert.equal(r.total.total, 98146500);
  assert.equal(r.total.jumlah, 12);
  assert.deepEqual(r.peringatan, []);
});

test("count_distinct, avg, min, max", () => {
  const r = aggregateRows(PI, { metrics: [
    { op: "count_distinct", field: "vendor.id", as: "vendor" }, { op: "avg", field: "totalAmount", as: "rata" },
    { op: "min", field: "totalAmount", as: "kecil" }, { op: "max", field: "totalAmount", as: "besar" }] });
  assert.deepEqual(r.total, { vendor: 3, rata: 98146500 / 12 === 8178875 ? 8178875 : Number((98146500 / 12).toFixed(2)), kecil: 600000, besar: 37205000 });
});

test("pengelompokan per bulan dan per tahun, urut kunci", () => {
  const rows = [...PI, { id: 999, transDate: "01/07/2021", totalAmount: 100, vendor: V[50] }, { id: 998, transDate: "10/01/2022", totalAmount: 50, vendor: V[50] }];
  const r = aggregateRows(rows, { group_by: [{ field: "transDate", bucket: "month" }], metrics: [{ op: "sum", field: "totalAmount", as: "t" }], sort: { by: "key" } });
  assert.deepEqual(r.kelompok.map((k) => [k.kunci["transDate(month)"], k.nilai.t]), [["2021-06", 98146500], ["2021-07", 100], ["2022-01", 50]]);
  const y = aggregateRows(rows, { group_by: [{ field: "transDate", bucket: "year" }], metrics: [{ op: "count" }], sort: { by: "key" } });
  assert.deepEqual(y.kelompok.map((k) => [k.kunci["transDate(year)"], k.nilai.jumlah]), [["2021", 13], ["2022", 1]]);
});

// ---- Laba rugi: struktur sama dengan respons glaccount/get-pl-account-amount.do ----
const R = (no, tipe, parent, isParent, amount) => ({ accountNo: no, accountName: no, accountType: tipe, parentNo: parent, isParent, amount });
const PL = [
  R("4000", "REVENUE", "4000", true, 1000000), R("400001", "REVENUE", "4000", false, 1200000), R("400003", "REVENUE", "4000", false, -150000), R("400004", "REVENUE", "4000", false, -50000),
  R("5101", "COST_OF_GOOD_SOLD", "5101", false, 300000),
  R("6000", "EXPENSE", "6000", true, 200000), R("600004", "EXPENSE", "6000", false, 150000), R("600011", "EXPENSE", "6000", false, 50000),
  R("7100", "OTHER_INCOME", "7100", true, 10000), R("710001", "OTHER_INCOME", "7100", false, 10000),
  R("7200", "OTHER_EXPENSE", "7200", true, 5000), R("720001", "OTHER_EXPENSE", "7200", false, 5000),
];
const SIGN = { field: "accountType", map: { REVENUE: 1, COST_OF_GOOD_SOLD: -1, EXPENSE: -1, OTHER_INCOME: 1, OTHER_EXPENSE: -1 } };

test("laba rugi: filter akun induk, jumlah per tipe, dan laba bersih bertanda dalam satu panggilan", () => {
  const r = aggregateRows(PL, {
    where: [{ field: "isParent", op: "eq", value: false }],
    group_by: ["accountType"],
    metrics: [{ op: "sum", field: "amount", as: "jumlah" }, { op: "sum", field: "amount", as: "laba_bersih", signed_by: SIGN }],
    sort: { by: "key" },
  });
  const per = Object.fromEntries(r.kelompok.map((k) => [k.kunci.accountType, k.nilai.jumlah]));
  assert.deepEqual(per, { COST_OF_GOOD_SOLD: 300000, EXPENSE: 200000, OTHER_EXPENSE: 5000, OTHER_INCOME: 10000, REVENUE: 1000000 });
  assert.equal(r.total.laba_bersih, 505000); // 1.000.000 - 300.000 - 200.000 + 10.000 - 5.000
  assert.equal(r.baris_masukan, 12); assert.equal(r.baris_dihitung, 8);
});

test("tanpa filter akun induk angka menjadi ganda (alasan filter itu wajib)", () => {
  const r = aggregateRows(PL, { group_by: ["accountType"], metrics: [{ op: "sum", field: "amount", as: "j" }], sort: { by: "key" } });
  assert.equal(r.kelompok.find((k) => k.kunci.accountType === "REVENUE").nilai.j, 2000000);
});

test("nilai tipe yang tidak ada di map dilaporkan, tidak dihitung diam-diam", () => {
  const rows = [...PL.filter((x) => !x.isParent), R("999", "TIPE_BARU", "999", false, 777)];
  const r = aggregateRows(rows, { metrics: [{ op: "sum", field: "amount", as: "n", signed_by: SIGN }] });
  assert.equal(r.total.n, 505000);
  assert.ok(r.peringatan.some((w) => w.includes("TIPE_BARU") && w.includes("TIDAK ikut dihitung")));
  const d = aggregateRows(rows, { metrics: [{ op: "sum", field: "amount", as: "n", signed_by: { ...SIGN, default: 0 } }] });
  assert.equal(d.total.n, 505000); assert.deepEqual(d.peringatan, []);
});

// ---- Ketelitian angka ----
test("penjumlahan desimal eksak (0,1 x 10 = 1; 0,1 + 0,2 = 0,3)", () => {
  assert.equal(aggregateRows(Array.from({ length: 10 }, () => ({ a: 0.1 })), { metrics: [{ op: "sum", field: "a", as: "s" }] }).total.s, 1);
  assert.equal(aggregateRows([{ a: 0.1 }, { a: 0.2 }], { metrics: [{ op: "sum", field: "a", as: "s" }] }).total.s, 0.3);
  assert.equal(aggregateRows([{ a: 1.005 }, { a: 2.115 }], { metrics: [{ op: "sum", field: "a", as: "s" }] }).total.s, 3.12);
});
test("angka besar dan negatif; hasil di atas batas Number dikembalikan sebagai teks eksak", () => {
  assert.equal(aggregateRows([{ a: 99999999999 }, { a: -1 }], { metrics: [{ op: "sum", field: "a", as: "s" }] }).total.s, 99999999998);
  const big = aggregateRows([{ a: 9007199254740 }, { a: 9007199254740 }, { a: 9007199254740 }], { metrics: [{ op: "sum", field: "a", as: "s" }] }).total.s;
  assert.equal(String(big), "27021597764220");
});
test("nilai kosong/bukan angka/teks ambigu (\"1.000\") dilaporkan dan tidak dihitung; string angka biasa diterima", () => {
  const r = aggregateRows([{ a: 10 }, { a: "5" }, { a: null }, {}, { a: "abc" }, { a: "1.000" }], { metrics: [{ op: "sum", field: "a", as: "s" }] });
  assert.equal(r.total.s, 15); // 10 + "5"; "1.000" ambigu sehingga ditolak
  assert.ok(r.peringatan[0].includes("4 baris"));
});

// ---- Filter, urutan, batas ----
test("operator filter", () => {
  const rows = [{ n: "Alpha", v: 1, t: "x" }, { n: "beta", v: 5, t: "y" }, { n: "Gamma", v: 10, t: "x" }];
  const c = (where) => aggregateRows(rows, { where }).total.jumlah;
  assert.equal(c([{ field: "t", op: "eq", value: "x" }]), 2);
  assert.equal(c([{ field: "t", op: "ne", value: "x" }]), 1);
  assert.equal(c([{ field: "v", op: "gt", value: 1 }]), 2);
  assert.equal(c([{ field: "v", op: "gte", value: 5 }]), 2);
  assert.equal(c([{ field: "v", op: "lt", value: 5 }]), 1);
  assert.equal(c([{ field: "v", op: "lte", value: 5 }]), 2);
  assert.equal(c([{ field: "t", op: "in", value: ["y", "z"] }]), 1);
  assert.equal(c([{ field: "n", op: "contains", value: "AM" }]), 1);
  assert.equal(c([{ field: "t", op: "eq", value: "x" }, { field: "v", op: "gt", value: 1 }]), 1);
});
test("limit tidak mengubah total, dan urutan asc/desc", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ g: `g${i}`, v: i + 1 }));
  const r = aggregateRows(rows, { group_by: ["g"], metrics: [{ op: "sum", field: "v", as: "s" }], limit: 3 });
  assert.equal(r.kelompok.length, 3); assert.equal(r.kelompok_dipotong, true); assert.equal(r.jumlah_kelompok, 10);
  assert.equal(r.total.s, 55); assert.equal(r.kelompok[0].nilai.s, 10);
  const asc = aggregateRows(rows, { group_by: ["g"], metrics: [{ op: "sum", field: "v", as: "s" }], sort: { by: "s", order: "asc" }, limit: 2 });
  assert.deepEqual(asc.kelompok.map((k) => k.nilai.s), [1, 2]);
});

// ---- Validasi masukan & keamanan ----
test("masukan tidak valid ditolak", () => {
  const rows = [{ a: 1 }];
  assert.throws(() => aggregateRows(rows, { metrics: [{ op: "sum" }] }), /wajib punya field/);
  assert.throws(() => aggregateRows(rows, { metrics: [{ op: "median", field: "a" }] }), /tidak dikenal/);
  assert.throws(() => aggregateRows(rows, { metrics: [{ op: "avg", field: "a", signed_by: { field: "t", map: { x: 1 } } }] }), /hanya untuk metrik 'sum'/);
  assert.throws(() => aggregateRows(rows, { metrics: [{ op: "sum", field: "a", signed_by: { field: "t", map: { x: 0.5 } } }] }), /bilangan bulat/);
  assert.throws(() => aggregateRows(rows, { metrics: [{ op: "count" }, { op: "count" }] }), /ganda/);
  assert.throws(() => aggregateRows(rows, { where: [{ field: "a", op: "regex", value: "x" }] }), /tidak dikenal/);
  assert.throws(() => aggregateRows(rows, { group_by: ["a"], sort: { by: "nama_salah" } }), /tidak ada/);
  assert.throws(() => aggregateRows(rows, { group_by: [{ field: "a", bucket: "week" }] }), /bucket/);
});
test("nama field berbahaya ditolak (prototype pollution) dan getPath aman", () => {
  for (const f of ["__proto__.x", "constructor.name", "a.prototype", "a b", "a;b", "", "a..b"]) assert.throws(() => assertField(f), /tidak valid/, f);
  assert.equal(getPath({ a: { b: 2 } }, "a.b"), 2);
  assert.equal(getPath({ a: 1 }, "toString"), undefined);
  assert.equal(getPath({}, "constructor"), undefined);
  assert.equal(getPath({ a: null }, "a.b"), undefined);
});

// ---- collectRows ----
const pager = (total, pageSize, { dup = false, rowCountOff = 0 } = {}) => {
  const calls = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 1, v: 1 }));
  const fetchPage = async (path, q) => {
    calls.push({ path, q });
    const page = Number(q["sp.page"] ?? 1), size = Number(q["sp.pageSize"] ?? pageSize);
    let d = all.slice((page - 1) * size, page * size);
    if (dup && page === 2) d = [all[0], ...d.slice(1)];
    return { s: true, d, sp: { page, pageSize: size, pageCount: Math.ceil(total / size), rowCount: total + rowCountOff } };
  };
  return { fetchPage, calls };
};
test("collectRows mengambil semua halaman dan semuanya terhitung", async () => {
  const { fetchPage, calls } = pager(250, 100);
  const { rows, info } = await collectRows(fetchPage, "x/list.do", { fields: "id,v" });
  assert.equal(rows.length, 250); assert.equal(info.lengkap, true); assert.equal(info.halaman_diambil, 3);
  assert.equal(calls[0].q["sp.pageSize"], 100);
  assert.equal(aggregateRows(rows, { metrics: [{ op: "sum", field: "v", as: "s" }] }).total.s, 250);
});
test("collectRows menolak data tidak lengkap kecuali allowPartial", async () => {
  await assert.rejects(() => collectRows(pager(250, 100).fetchPage, "x/list.do", {}, { maxPages: 2 }), /Data tidak lengkap: hanya 2 dari 3 halaman/);
  const { rows, info } = await collectRows(pager(250, 100).fetchPage, "x/list.do", {}, { maxPages: 2, allowPartial: true });
  assert.equal(rows.length, 200); assert.equal(info.lengkap, false);
});
test("collectRows menolak duplikat dan jumlah baris tidak cocok", async () => {
  await assert.rejects(() => collectRows(pager(250, 100, { dup: true }).fetchPage, "x/list.do", {}), /duplikat/);
  await assert.rejects(() => collectRows(pager(50, 100, { rowCountOff: 3 }).fetchPage, "x/list.do", {}), /tidak cocok/);
});
test("collectRows: endpoint non-list tanpa paging dipanggil sekali; bukan array ditolak", async () => {
  let n = 0;
  const one = async () => { n++; return { s: true, d: [{ a: 1 }, { a: 2 }] }; };
  const { rows, info } = await collectRows(one, "glaccount/get-pl-account-amount.do", { fromDate: "01/01/2021" });
  assert.equal(n, 1); assert.equal(rows.length, 2); assert.equal(info.lengkap, true);
  await assert.rejects(() => collectRows(async () => ({ s: true, d: { x: 1 } }), "x/detail.do", {}), /bukan array/);
});
