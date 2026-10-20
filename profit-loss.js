// Menyusun laporan laba rugi dari respons glaccount/get-pl-account-amount.do.
// Semua perhitungan dilakukan di sini (kode), dalam satuan sen (bilangan bulat) agar tidak ada selisih desimal.
//
// Bentuk baris yang diharapkan (terkonfirmasi dari respons asli):
//   { accountNo, accountName, accountType, parentNo, lvl, isParent, amount }

// Pemetaan accountType Accurate -> kelompok laporan.
// sign: +1 menambah laba, -1 mengurangi laba.
const GROUPS = [
  { key: "pendapatan", label: "Pendapatan", types: ["REVENUE"], sign: +1 },
  { key: "hpp", label: "Beban Pokok Penjualan", types: ["COST_OF_GOOD_SOLD"], sign: -1 },
  { key: "beban_operasional", label: "Beban Operasional", types: ["EXPENSE"], sign: -1 },
  { key: "pendapatan_lain", label: "Pendapatan di Luar Usaha", types: ["OTHER_INCOME"], sign: +1 },
  { key: "beban_lain", label: "Beban di Luar Usaha", types: ["OTHER_EXPENSE"], sign: -1 },
];
const TYPE_TO_GROUP = new Map(GROUPS.flatMap((g) => g.types.map((t) => [t, g])));

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

export function buildProfitLoss(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Data laba rugi bukan array. Bentuk respons Accurate mungkin berubah.");
  }

  const peringatan = [];
  const pemeriksaan = [];

  // Normalisasi + validasi angka
  const items = [];
  for (const r of rows) {
    const cents = toCents(r?.amount);
    if (!Number.isFinite(cents)) {
      peringatan.push(`Akun ${r?.accountNo ?? "?"} punya amount tidak valid dan diabaikan.`);
      continue;
    }
    items.push({
      no: String(r.accountNo),
      nama: r.accountName,
      tipe: r.accountType,
      parentNo: r.parentNo == null ? null : String(r.parentNo),
      isParent: Boolean(r.isParent),
      cents,
    });
  }

  // Hanya akun "daun" (bukan induk) yang dijumlahkan, supaya tidak terhitung dua kali.
  const leaves = items.filter((i) => !i.isParent);

  // --- Pengelompokan ---
  const totals = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  const rincian = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  const unknown = [];
  for (const leaf of leaves) {
    const group = TYPE_TO_GROUP.get(leaf.tipe);
    if (!group) {
      unknown.push(leaf);
      continue;
    }
    totals[group.key] += leaf.cents;
    if (leaf.cents !== 0) {
      rincian[group.key].push({ no: leaf.no, nama: leaf.nama, jumlah: fromCents(leaf.cents) });
    }
  }

  pemeriksaan.push({
    nama: "Semua akun terklasifikasi (tipe dikenal)",
    lulus: unknown.length === 0,
    detail: unknown.length
      ? `Tipe tidak dikenal, TIDAK masuk total: ${unknown.map((u) => `${u.no}(${u.tipe})`).join(", ")}`
      : "OK",
  });

  // --- Pemeriksaan konsistensi: jumlah akun induk = jumlah akun daun di bawahnya ---
  const children = new Map();
  for (const i of items) {
    if (i.parentNo && i.parentNo !== i.no) {
      if (!children.has(i.parentNo)) children.set(i.parentNo, []);
      children.get(i.parentNo).push(i);
    }
  }
  const leafSum = (no, seen = new Set()) => {
    if (seen.has(no)) return { sum: 0, count: 0 }; // cegah loop jika data aneh
    seen.add(no);
    let sum = 0;
    let count = 0;
    for (const c of children.get(no) ?? []) {
      if (c.isParent) {
        const sub = leafSum(c.no, seen);
        sum += sub.sum;
        count += sub.count;
      } else {
        sum += c.cents;
        count += 1;
      }
    }
    return { sum, count };
  };
  const parentMismatch = [];
  let parentChecked = 0;
  for (const p of items.filter((i) => i.isParent)) {
    const { sum, count } = leafSum(p.no);
    parentChecked += 1;
    if (Math.abs(sum - p.cents) > Math.max(1, count)) {
      parentMismatch.push(`${p.no} ${p.nama}: induk=${fromCents(p.cents)} vs jumlah anak=${fromCents(sum)}`);
    }
  }
  pemeriksaan.push({
    nama: "Jumlah akun induk = jumlah akun di bawahnya",
    lulus: parentMismatch.length === 0,
    detail: parentMismatch.length ? parentMismatch.join("; ") : `OK (${parentChecked} akun induk diperiksa)`,
  });

  // --- Ringkasan ---
  const labaKotor = totals.pendapatan - totals.hpp;
  const labaUsaha = labaKotor - totals.beban_operasional;
  const labaBersih = labaUsaha + totals.pendapatan_lain - totals.beban_lain;

  if (leaves.length > 0 && leaves.every((l) => l.cents === 0)) {
    peringatan.push(
      "Semua akun bernilai 0 untuk periode ini (tidak ada transaksi terposting, atau periode salah). " +
        "Perhitungan belum bisa diuji dan tanda angka belum terbukti."
    );
  }

  return {
    ringkasan: {
      pendapatan: fromCents(totals.pendapatan),
      hpp: fromCents(totals.hpp),
      laba_kotor: fromCents(labaKotor),
      beban_operasional: fromCents(totals.beban_operasional),
      laba_usaha: fromCents(labaUsaha),
      pendapatan_lain: fromCents(totals.pendapatan_lain),
      beban_lain: fromCents(totals.beban_lain),
      laba_bersih: fromCents(labaBersih),
    },
    rincian: Object.fromEntries(GROUPS.map((g) => [g.label, rincian[g.key]])),
    pemeriksaan,
    peringatan,
    catatan: [
      "Rumus: laba bersih = pendapatan - HPP - beban operasional + pendapatan lain - beban lain.",
      "Asumsi tanda angka: nilai tiap akun diperlakukan sebagai saldo normalnya (pendapatan positif, beban positif). " +
        "Akun kontra seperti Retur/Diskon Penjualan (bertipe REVENUE) diasumsikan sudah bertanda negatif dari Accurate.",
      "BELUM diverifikasi terhadap laporan resmi Accurate. Cocokkan laba bersih ini dengan laporan Laba Rugi di Accurate " +
        "untuk periode yang berisi transaksi sebelum dipakai.",
    ],
    jumlah_akun: { daun: leaves.length, induk: items.length - leaves.length },
  };
}
