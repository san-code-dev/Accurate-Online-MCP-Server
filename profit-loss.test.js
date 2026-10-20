import test from "node:test";
import assert from "node:assert/strict";
import { buildProfitLoss } from "./profit-loss.js";

const R = (no, nama, tipe, parent, isParent, amount) => ({ accountNo: no, accountName: nama, accountType: tipe, parentNo: parent, isParent, amount, lvl: isParent ? 1 : 2 });
const base = () => [
  R("4000", "Pendapatan Operasional", "REVENUE", "4000", true, 1000000),
  R("400001", "Penjualan", "REVENUE", "4000", false, 1200000),
  R("400003", "Retur Penjualan", "REVENUE", "4000", false, -150000),
  R("400004", "Diskon Penjualan", "REVENUE", "4000", false, -50000),
  R("5101", "Beban Pokok Penjualan", "COST_OF_GOOD_SOLD", "5101", false, 300000),
  R("6000", "Beban Operasional", "EXPENSE", "6000", true, 200000),
  R("600004", "Gaji", "EXPENSE", "6000", false, 150000),
  R("600011", "Listrik", "EXPENSE", "6000", false, 50000),
  R("7100", "Pendapatan Diluar Usaha", "OTHER_INCOME", "7100", true, 10000),
  R("710001", "Jasa Giro", "OTHER_INCOME", "7100", false, 10000),
  R("7200", "Beban Diluar Usaha", "OTHER_EXPENSE", "7200", true, 5000),
  R("720001", "Bunga", "OTHER_EXPENSE", "7200", false, 5000),
];

test("total benar dan semua pemeriksaan lulus", () => {
  const r = buildProfitLoss(base());
  assert.equal(r.ringkasan.pendapatan, 1000000);
  assert.equal(r.ringkasan.laba_kotor, 700000);
  assert.equal(r.ringkasan.laba_usaha, 500000);
  assert.equal(r.ringkasan.laba_bersih, 505000);
  assert.ok(r.pemeriksaan.every((p) => p.lulus));
});
test("induk tidak cocok dengan anak terdeteksi", () => {
  const bad = base(); bad[5].amount = 999;
  assert.equal(buildProfitLoss(bad).pemeriksaan.find((p) => p.nama.startsWith("Jumlah akun induk")).lulus, false);
});
test("tipe tak dikenal ditandai dan tidak masuk total", () => {
  const u = base(); u.push(R("999999", "Aneh", "BARU", "999999", false, 777));
  const r = buildProfitLoss(u);
  assert.equal(r.pemeriksaan.find((p) => p.nama.startsWith("Semua akun")).lulus, false);
  assert.equal(r.ringkasan.laba_bersih, 505000);
});
test("tanpa drift desimal dan semua-nol memberi peringatan", () => {
  const f = [R("4000", "P", "REVENUE", "4000", true, 0.3), R("400001", "a", "REVENUE", "4000", false, 0.1), R("400002", "b", "REVENUE", "4000", false, 0.2)];
  assert.equal(buildProfitLoss(f).ringkasan.pendapatan, 0.3);
  assert.ok(buildProfitLoss(base().map((x) => ({ ...x, amount: 0 }))).peringatan.some((w) => w.includes("bernilai 0")));
});
test("respons bukan array -> error", () => {
  assert.throws(() => buildProfitLoss({ s: true }));
});
