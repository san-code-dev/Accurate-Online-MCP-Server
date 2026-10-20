# Accurate Online MCP Server (Read-Only)

**Accurate Online MCP Server** adalah implementasi [Model Context Protocol (MCP)](https://modelcontextprotocol.io) berbasis Node.js dan Express yang memungkinkan asisten AI (seperti Claude, Cursor, Windsurf, LangChain, Dify, dan klien MCP lainnya) untuk mengakses, membaca, menganalisis, dan me-rekap data dari **Accurate Online** secara aman dan terstruktur.

Server ini bekerja dalam mode **Hanya Baca (Read-Only)** secara mutlak. Tidak ada endpoint atau jalur logika yang dapat mengubah, menambah, atau menghapus data pada database Accurate Online Anda.

---

## 📑 Daftar Isi
- [Fitur Utama](#fitur-utama)
- [Daftar Tools MCP](#daftar-tools-mcp)
- [Mekanisme Perhitungan (`accurate_aggregate`)](#mekanisme-perhitungan-accurate_aggregate)
- [Jaminan Keamanan Read-Only Berlapis](#jaminan-keamanan-read-only-berlapis)
- [Persyaratan Sistem & Dependensi](#persyaratan-sistem--dependensi)
- [Panduan Integrasi Kredensial Accurate](#panduan-integrasi-kredensial-accurate)
- [Instalasi & Pengoperasian](#instalasi--pengoperasian)
- [Konfigurasi Klien MCP (Claude, Cursor, DLL)](#konfigurasi-klien-mcp-claude-cursor-dll)
- [Contoh Prompt / Pertanyaan](#contoh-prompt--pertanyaan)
- [Batasan Teknis](#batasan-teknis)
- [Terms of Service & Syarat Ketentuan](#terms-of-service--syarat-ketentuan)
- [Disclaimer & Penyangkalan Hukum](#disclaimer--penyangkalan-hukum)

---

## 🌟 Fitur Utama

- **Netral Terhadap Klien AI**: Dapat disambungkan ke AI Agent / LLM Client apa pun yang mendukung protokol MCP (Stdio maupun HTTP/SSE).
- **Enforement Read-Only Mutlak**: Memvalidasi seluruh permintaan terhadap OpenAPI spec resmi Accurate untuk memastikan hanya method `GET` dan scope `*_view` yang diizinkan.
- **Engine Aggregation Presisi Tinggi**: Menggunakan aritmatika berbasis `BigInt` untuk menghindari kesalahan pembulatan desimal saat melakukan kalkulasi agregasi/laporan keuangan.
- **Auto-Discovery Endpoint**: Dilengkapi fitur pencarian OpenAPI spec terintegrasi sehingga AI Agent dapat menemukan endpoint yang relevan secara mandiri.
- **Rate-Limiting & Protection**: Menjaga stabilitas koneksi API dengan membatasi proses paralel sesuai kuota Accurate.

---

## 🛠️ Daftar Tools MCP

Server menyediakan 4 tools utama yang dapat dipanggil oleh AI Client:

| Tool | Deskripsi & Fungsi |
|---|---|
| `search_endpoints` | Mencari endpoint BACA pada spesifikasi OpenAPI Accurate berdasarkan kata kunci, modul, atau parameter. |
| `accurate_get` | Mengambil/melihat raw data dari satu endpoint Accurate (dukungan multi-halaman via `all_pages`). |
| `accurate_aggregate` | Melakukan pemrosesan, agregasi, pengelompokan, dan perhitungan data secara aman di server MCP tanpa membebankan konteks LLM. |
| `check_connection` | Menguji status validasi token API, signature secret, serta keterhubungan ke host Accurate. |

---

## 📊 Mekanisme Perhitungan (`accurate_aggregate`)

Seluruh kalkulasi dilakukan langsung di dalam kode server MCP (Server-Side Calculation), bukan diestimasi atau dihitung manual oleh model LLM.

- **Operasi Agregasi**: `count`, `count_distinct`, `sum`, `avg`, `min`, `max`.
- **Pengelompokan (Group By)**: Berdasarkan field spesifik (misal: `vendor.name`) atau rentang waktu (`bucket`: `month`/`year`).
- **Penyaringan Data (Filter)**: Mendukung operator `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`.
- **Signed By Metrics**: Perhitungan berbobot otomatis (misal: memberikan bobot `+1` pada akun Pendapatan dan `-1` pada Beban/HPP untuk menghitung Laba Bersih secara otomatis).
- **Aritmatika Presisi Tinggi**: Pengolahan angka menggunakan skema `BigInt` (menghindari bug floating point `0.1 + 0.2 = 0.30000000000000004`).

### Pengaman Validasi Data:
1. **Ditolak Jika Parsial**: Permintaan agregasi ditolak otomatis jika data tidak lengkap (melebihi `max_pages`) atau terdapat duplikasi ID, kecuali parameter `allow_partial=true` diaktifkan secara eksplisit.
2. **Audit Peringatan**: Nilai kosong, non-numerik, atau format ambiguous (seperti `"1.000"`) akan dikecualikan dari kalkulasi dan dicatat pada array `peringatan`.
3. **Integritas Tampilan**: Properti `total` mencakup keseluruhan populasi data meskipun hasil tampilan dibatasi oleh parameter `limit`.

---

## 🛡️ Jaminan Keamanan Read-Only Berlapis

Server mengintegrasikan **6 lapisan pengaman** untuk menjamin data Anda tidak dapat diubah:

1. **Restriksi Method HTTP**: Server hanya mengeksekusi metode `HTTP GET` ke API Accurate.
2. **Whitelist Spesifikasi Resmi**: Endpoint yang dapat diakses diwajibkan terdaftar pada spesifikasi OpenAPI Accurate dengan kriteria berakhiran `_view`. Endpoint bertipe `save.do`, `delete.do`, `bulk-save.do`, atau scope `*_save`/`*_delete` diblokir penuh.
3. **Validasi Strict Path & Keyword**: Path divalidasi ketat (pola regex). Kata kunci yang teridentifikasi sebagai operasi tulis (`save`, `update`, `approve`, dll) akan langsung ditolak.
4. **Isolasi Domain & Redirect**: Host terkunci ke `*.accurate.id` dan redirect HTTP ditolak keluar dari domain Accurate.
5. **Enkapsulasi Engine**: Tool `accurate_aggregate` hanya memproses data read-only yang sudah ditarik dan tidak memiliki instruksi penulisan.
6. **Prinsip Hak Akses Terkecil (Least Privilege)**: Token API dianjurkan dibangkitkan dari akun pengguna Accurate berkategori **Operator (View Only)**.

---

## 💻 Persyaratan Sistem & Dependensi

- **Node.js**: Versi `20.6.0` atau yang lebih baru (mendukung flag `--env-file`).
- **NPM**: Versi 9.x atau lebih baru.
- **Accurate Online Account**: Akses ke database Accurate Online dan hak akses API Developer.

---

## 🔑 Panduan Integrasi Kredensial Accurate

1. **Area Developer Accurate**:
   - Masuk ke [Accurate Developer Portal](https://account.accurate.id/developer).
   - Buat/pilih Aplikasi > Aktifkan **API Token**.
   - Simpan **App Key** dan **Signature Secret** yang diberikan.
2. **Instalasi Aplikasi ke Data Usaha**:
   - Buka Accurate Online (sebagai Administrator).
   - Navigasi ke `Pengaturan` > `Accurate Store` > `Aplikasi Saya` > `Install Aplikasi`.
   - Masukkan **App Key** aplikasi Anda.
3. **Membagikan API Token**:
   - Masuk ke `Accurate Store` > `API Token` > `Buat API Token`.
   - **Rekomendasi Utama**: Pilih pengguna/user dengan role **Operator Hanya-Lihat (Read-Only)**.
   - Salin **API Token** yang dihasilkan.
4. **Konfigurasi Environment Variable**:
   - Buat file `.env` (duplikasi dari `.env.example`).
   - Isi kredensial berikut:
     ```env
     ACCURATE_BEARER_TOKEN=token_anda_di_sini
     ACCURATE_API_SECRET=signature_secret_anda_di_sini
     PORT=3000
     ```

---

## 🚀 Instalasi & Pengoperasian

```bash
# 1. Clone repositori ini
git clone [https://github.com/username/accurate-mcp-server.git](https://github.com/username/accurate-mcp-server.git)
cd accurate-mcp-server

# 2. Install dependensi
npm install

# 3. Salin dan sesuaikan variabel lingkungan
cp .env.example .env

# 4. Jalankan pengujian keamanan & unit test (31+ test suite)
npm test

# 5. Jalankan MCP Server
# Mode HTTP SSE (Port 3000)
npm start

# Mode Stdio (Untuk integrasi AI Desktop Client)
node --use-system-ca --env-file=.env server.js --stdio

```

---

## 🔌 Konfigurasi Klien MCP

Server ini menggunakan protokol standar MCP sehingga kompatibel dengan berbagai AI Agent / Client:

### 1. Claude Desktop

Edit file konfigurasi (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "accurate": {
      "command": "node",
      "args": [
        "--use-system-ca",
        "--env-file=D:\\Path\\To\\Your\\.env",
        "D:\\Path\\To\\Your\\server.js",
        "--stdio"
      ]
    }
  }
}

```

### 2. Claude Code CLI

Via Stdio:

```bash
claude mcp add accurate -- node --use-system-ca --env-file=/path/ke/.env /path/ke/server.js --stdio

```

Via HTTP:

```bash
claude mcp add --transport http accurate [http://127.0.0.1:3000/mcp](http://127.0.0.1:3000/mcp)

```

### 3. Cursor / Windsurf / VS Code Extensions (Continue, dll.)

Tambahkan MCP Server pada pengaturan ekstensi masing-masing:

* **Type**: `command` (Stdio) atau `sse`/`http`.
* **Command**: `node`
* **Args**: `["--use-system-ca", "--env-file=/path/ke/.env", "/path/ke/server.js", "--stdio"]`

*Note: Gunakan flag `--use-system-ca` jika lingkungan jaringan Anda menggunakan SSL Inspection atau Antivirus interceptor.*

---

## 💬 Contoh Pertanyaan / Prompt

Setelah terhubung dengan AI Client, Anda dapat menanyakan hal-hal seperti:

* *"Berapa total penjualan bulan ini dibandingkan bulan lalu berdasarkan Accurate?"*
* *"Buatkan ringkasan Laba Rugi untuk periode tahun berjalan."*
* *"Tampilkan daftar vendor dengan total pembelian terbesar tahun ini."*
* *"Cari daftar barang/stok yang kuantitasnya di bawah 10 unit."*

---

## ⚠️ Batasan Teknis

* **Struktur Response**: Spesifikasi OpenAPI Accurate tidak secara detail mendefinisikan skema JSON response pada setiap endpoint. AI Agent akan mempelajari struktur data berdasarkan panggilan pertama.
* **Kapasitas Halaman**: Satu kali permintaan dialokasikan maksimal 50 halaman (sekitar 5.000 baris data). Filter tanggal sangat dianjurkan untuk data berukuran besar.
* **Pemotongan Karakter**: Hasil respons yang melebihi 100.000 karakter akan dipotong (truncated) untuk menjaga stabilitas memori LLM. Gunakan fitur `fields`, `limit`, atau `accurate_aggregate`.
* **Batas Kuota Accurate**: Default rate limit Accurate adalah 8 request/detik dan 8 proses paralel per API Token (server dibatasi maks 4 proses paralel).

---

## 📜 Terms of Service (Syarat & Ketentuan)

Dengan mengunduh, menginstal, atau menggunakan **Accurate MCP Server** ini, Anda menyetujui syarat dan ketentuan berikut:

1. **Penggunaan Bebas & Risiko Mandiri**: Perangkat lunak ini disediakan secara terbuka untuk membantu integrasi data. Anda bertanggung jawab penuh atas konfigurasi, keamanan kredensial, dan lingkungan eksekusi perangkat lunak ini.
2. **Kepatuhan Terhadap Ketentuan PT CPSSoft / Accurate**: Pengguna wajib mematuhi seluruh syarat layanan dan aturan penggunaan API resmi dari PT Cipta Piranti Sejahtera (CPSSoft) selaku penyedia layanan Accurate Online.
3. **Keamanan Kredensial**: Pengguna bertanggung jawab menjaga kerahasiaan `ACCURATE_BEARER_TOKEN`, `ACCURATE_API_SECRET`, dan token autentikasi lingkungan setempat. Sangat dilarang mempublikasikan file `.env` ke repositori publik.
4. **Penggunaan API Token**: Pengguna disarankan menggunakan API Token yang terikat pada akun dengan hak akses *Read-Only*. Kerugian akibat penggunaan API Token bertipe Administrator menjadi tanggung jawab Pengguna sepenuhnya.
5. **Konektivitas Jaringan**: Dilarang membuka atau mempublikasikan (exposing) port server MCP ini ke jaringan internet publik tanpa menyertakan lapisan autentikasi, enkripsi HTTPS, dan firewall yang memadai.

---

## ⚖️ Disclaimer (Penyangkalan Hukum)

1. **Tidak Berafiliasi Resmi**: Proyek ini adalah proyek independen dan **TIDAK berafiliasi, didukung, disponsori, atau dihubungkan secara resmi dengan PT Cipta Piranti Sejahtera (CPSSoft) atau merek terdaftar Accurate Online**. Nama "Accurate", "Accurate Online", serta logo terkait adalah hak milik sah dari pemiliknya masing-masing.
2. **Tidak Ada Garansi (As-Is)**: PERANGKAT LUNAK INI DISEDIAKAN "SEBAGAIMANA ADANYA" (*AS IS*), TANPA JAMINAN APA PUN, BAIK TERSURAT MAUPUN TERSIRAT, TERMASUK NAMUN TIDAK TERBATAS PADA JAMINAN KELAYAKAN JUAL, KESESUAIAN UNTUK TUJUAN TERTENTU, SERTA KETIADAAN PELANGGARAN.
3. **Penyangkalan Hasil Laporan Keuangan**: Perhitungan agregasi, pencocokan akun Laba Rugi, beban, dan pos akun lainnya yang dihasilkan melalui server ini merupakan estimasi matematis berdasarkan data yang ditarik via API. **Hasil kalkulasi harus selalu dicocokkan dan diverifikasi kembali dengan Laporan Keuangan Resmi di dalam sistem Accurate Online sebelum digunakan untuk keputusan bisnis, audit, atau perpajakan.**
4. **Pembatasan Tanggung Jawab**: Dalam kondisi apa pun, pembuat, kontributor, atau pemegang hak cipta software ini TIDAK BERTANGGUNG JAWAB atas klaim, kerugian, kerusakan, atau tuntutan lain (baik langsung, tidak langsung, insidental, atau konsekuensial) yang timbul dari penggunaan, ketidakmampuan penggunaan, atau tindakan yang diambil berdasarkan data yang dihasilkan oleh perangkat lunak ini.