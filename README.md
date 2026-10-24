# Accurate Online MCP Server (Read-Only)

**Accurate Online MCP Server** adalah implementasi [Model Context Protocol (MCP)](https://modelcontextprotocol.io) berbasis Node.js dan Express yang memungkinkan asisten AI (seperti Claude, Cursor, Windsurf, LangChain, Dify, dan klien MCP lainnya) untuk membaca data dari **Accurate Online** secara aman dan terstruktur.

Server ini sengaja dibuat sebagai **penghubung murni** antara AI dan Accurate: ia mengambil data apa adanya dan menjamin data itu utuh (tidak terpotong, tidak parsial, tidak duplikat). **Server tidak menghitung apa pun dan tidak menulis file apa pun.** Semua perhitungan (total, rekap, laba rugi, selisih, persentase) dilakukan oleh AI.

Server ini bekerja dalam mode **Hanya Baca (Read-Only)** secara mutlak. Tidak ada endpoint atau jalur logika yang dapat mengubah, menambah, atau menghapus data pada database Accurate Online Anda.

---

## 📑 Daftar Isi
- [Fitur Utama](#fitur-utama)
- [Daftar Tools MCP](#daftar-tools-mcp)
- [Keutuhan Data & Perhitungan](#keutuhan-data--perhitungan)
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

- **Netral Terhadap Klien AI**: Dapat disambungkan ke AI Agent / LLM Client apa pun yang mendukung protokol MCP (Stdio maupun HTTP).
- **Read-Only Mutlak ke Accurate**: Hanya endpoint baca resmi (method `GET`, scope `*_view`) dari spesifikasi OpenAPI Accurate yang bisa dipanggil. Klien HTTP-nya bahkan tidak punya jalur untuk mengirim request tulis.
- **Penghubung Murni**: Tidak ada logika perhitungan dan tidak ada penulisan file. Data dikirim apa adanya ke AI.
- **Jaminan Keutuhan Data**: Data parsial, duplikat, atau jumlah baris yang tidak cocok ditandai `PERINGATAN`. Respons yang terlalu besar ditolak utuh, bukan dipotong diam-diam.
- **Auto-Discovery Endpoint**: Pencarian spesifikasi OpenAPI terintegrasi sehingga AI dapat menemukan endpoint yang relevan secara mandiri.
- **Rate-Limiting & Retry**: Maks. 4 request paralel, dan GET diulang otomatis saat Accurate membalas 429/502/503/504.

---

## 🛠️ Daftar Tools MCP

Server menyediakan 3 tools:

| Tool | Deskripsi & Fungsi |
|---|---|
| `search_endpoints` | Mencari endpoint BACA pada spesifikasi OpenAPI Accurate berdasarkan kata kunci, modul, atau path. |
| `accurate_get` | Mengambil data dari satu endpoint baca (detail dokumen, daftar transaksi, akun laba rugi). Mendukung semua halaman sekaligus via `all_pages`. |
| `check_connection` | Menguji token API, signature secret, dan keterhubungan ke host Accurate. |

---

## 📊 Keutuhan Data & Perhitungan

Server tidak menghitung. Tugasnya memastikan data yang diterima AI **utuh**:

1. **Penanda data parsial**: `accurate_get` dengan `all_pages` mengambil semua halaman, lalu mencocokkan jumlah baris dengan `rowCount` dari Accurate. Bila data tidak lengkap atau ada `id` duplikat, respons diberi `PERINGATAN` agar tidak dijumlahkan.
2. **Tidak ada pemotongan diam-diam**: respons di atas 100.000 karakter ditolak dengan pesan jelas, bukan dipotong, agar AI tidak menghitung dari setengah data.
3. **Penanda halaman**: bila `accurate_get` tanpa `all_pages` hanya mengembalikan halaman pertama dari beberapa halaman, respons diberi `CATATAN` agar tidak dijumlahkan sebagai total.

Cara menghitung yang disarankan:
- **Data kecil** (laba rugi per akun dari `glaccount/get-pl-account-amount.do`, detail satu faktur): `accurate_get`, lalu AI menyusun hasilnya.
- **Data banyak** (rekap faktur, per pelanggan/vendor/bulan): `accurate_get` dengan `all_pages=true` dan `fields` seperlunya, dipecah per periode bila terlalu besar. AI sebaiknya menghitung **dengan kode** (mis. Claude Code menjalankan skrip Python/Node). Menjumlahkan ratusan angka "di kepala" oleh LLM tidak dapat diandalkan.

---

---

## 🛡️ Jaminan Keamanan Read-Only Berlapis

Server mengintegrasikan beberapa lapisan pengaman. Gagal di salah satu lapisan = request ditolak sebelum dikirim (*fail closed*):

1. **Tidak ada jalur tulis di klien HTTP**: semua request data adalah `GET`. Satu-satunya `POST` adalah `api-token.do` (cek token & cari host) dengan URL tetap dan tanpa body. Fungsi request mentah tidak diekspor.
2. **Whitelist dari spesifikasi resmi**: endpoint harus terdaftar di OpenAPI Accurate dengan operasi `GET`, berada di server data usaha, dan **semua** scope-nya berakhiran `_view`.
3. **Validasi path & kata kunci**: path divalidasi regex. Nama operasi yang mengandung kata tulis (`save`, `delete`, `update`, `approve`, `void`, dll.) ditolak walaupun ada di whitelist.
4. **Validasi parameter**: hanya nilai skalar sederhana. Parameter pengganti metode (`_method`, `X-HTTP-Method-Override`, dll.) ditolak.
5. **Isolasi domain & redirect**: host terkunci ke `*.accurate.id` dengan HTTPS. Hanya redirect 308 ke domain Accurate yang diikuti; redirect lain ditolak sehingga token tidak bocor.
6. **Prinsip hak akses terkecil (wajib dilakukan pengguna)**: buat API Token dari user **Operator dengan Akses Grup khusus lihat**, dan centang **hanya scope `*_view`** saat membuat token. Ini lapisan terkuat karena ditegakkan oleh Accurate sendiri, bahkan jika kode server ini diubah.

Lapisan 1–5 dicakup oleh test otomatis (`npm test`).

---

## 💻 Persyaratan Sistem & Dependensi

- **Node.js**: Versi `20.6.0` atau yang lebih baru (mendukung flag `--env-file`). Flag `--use-system-ca` membutuhkan Node.js 22.15+ / 23.8+.
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
     MCP_AUTH_TOKEN=token_acak_untuk_mode_http
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

# 4. Jalankan pengujian keamanan & unit test
npm test

# 5. Jalankan MCP Server
# Mode HTTP SSE (Port 3000)
npm start

# Mode Stdio (Untuk integrasi AI Desktop Client)
node --use-system-ca --env-file=.env server.js --stdio

```

---

## 🐳 Menjalankan dengan Docker (otomatis jalan saat komputer hidup)

```bash
docker compose up -d --build
```

- Container `accurate-mcp` memakai `restart: unless-stopped`: otomatis jalan lagi setiap kali komputer/Docker Desktop hidup,
  **kecuali** dihentikan manual. Pastikan Docker Desktop diatur *Start Docker Desktop when you sign in*.
- Kredensial dibaca dari `.env` saat container dijalankan (tidak dimasukkan ke image). `.env` dibaca dengan `format: raw`
  sehingga nilai yang mengandung `$` tidak terpotong.
- Port mengikuti `PORT` di `.env` (mis. `3030`). Jangan jalankan `npm start` bersamaan di port yang sama.

| Perintah | Fungsi |
|---|---|
| `docker compose stop` | Hentikan (tidak akan jalan otomatis sampai di-start lagi) |
| `docker compose start` | Jalankan lagi |
| `docker compose up -d --build` | Bangun ulang setelah kode atau `.env` diubah |
| `docker compose logs -f` | Lihat log |
| `docker compose down` | Hentikan dan hapus container |

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

### Komputer lain di jaringan kantor (ekstensi `.mcpb`, tanpa instal Node.js)

Server dijalankan di satu komputer dengan `npm start` (`HOST=0.0.0.0`, port bebas mis. `PORT=3030`, firewall dibuka untuk port itu).
Komputer lain cukup memasang **Claude Desktop** lalu ekstensi penghubung:

1. Buat paketnya (sekali, di komputer server): `npx @anthropic-ai/mcpb pack extension extension/dist/accurate-kantor.mcpb`
2. Bagikan file `accurate-kantor.mcpb`. Isinya hanya penghubung (2 file, tanpa kode/token Accurate).
3. Di komputer lain: klik dua kali file tersebut di Claude Desktop, pilih **Install**, isi **Alamat server MCP** dan **Token MCP** (= `MCP_AUTH_TOKEN` server).

Node.js tidak perlu diinstal karena Claude Desktop membawa runtime-nya sendiri untuk ekstensi. Bila ekstensi gagal tersambung,
pesan error di Claude menjelaskan penyebabnya (token ditolak, server mati, komputer server tidak terjangkau).

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
* **Kapasitas Halaman**: `accurate_get` dengan `all_pages` maks. 50 halaman (100 baris/halaman). Untuk data lebih besar, ambil per periode (mis. per bulan).
* **Batas Respons**: Respons di atas 100.000 karakter (JSON ringkas) ditolak, bukan dipotong. Gunakan `fields` seperlunya dan persempit filter/periode.
* **Perhitungan oleh AI**: Ketelitian angka bergantung pada AI. Gunakan klien yang bisa menjalankan kode untuk data banyak.
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
3. **Penyangkalan Hasil Laporan Keuangan**: Server ini tidak menghitung. Seluruh perhitungan (rekap, Laba Rugi, beban, dan pos akun lainnya) dilakukan oleh AI berdasarkan data yang ditarik via API. **Hasil kalkulasi harus selalu dicocokkan dan diverifikasi kembali dengan Laporan Keuangan Resmi di dalam sistem Accurate Online sebelum digunakan untuk keputusan bisnis, audit, atau perpajakan.**
4. **Pembatasan Tanggung Jawab**: Dalam kondisi apa pun, pembuat, kontributor, atau pemegang hak cipta software ini TIDAK BERTANGGUNG JAWAB atas klaim, kerugian, kerusakan, atau tuntutan lain (baik langsung, tidak langsung, insidental, atau konsekuensial) yang timbul dari penggunaan, ketidakmampuan penggunaan, atau tindakan yang diambil berdasarkan data yang dihasilkan oleh perangkat lunak ini.