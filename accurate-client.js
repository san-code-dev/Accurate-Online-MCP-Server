// Klien HTTP Accurate Online (API Token). Dirancang READ-ONLY di level paling bawah:
//  - hanya HTTP GET ke /accurate/api/*; satu-satunya POST yang diizinkan adalah api-token.do (cek host),
//  - semua URL (termasuk host hasil api-token.do dan target redirect 308) wajib berada di domain accurate.id,
//  - setiap path dicek bentuknya oleh readonly-guard.
import crypto from "node:crypto";
import { assertSafeShape } from "./readonly-guard.js";

export function createAccurateClient(opts) {
  const {
    token,
    secret,
    sigEncoding = "base64",
    accountApi = "https://account.accurate.id/api",
    allowedHostSuffixes = [".accurate.id"],
    allowInsecureHttp = false, // hanya untuk pengujian lokal
    timeoutMs = 20_000,
    maxParallel = 4, // batas Accurate: 8 per detik / 8 paralel
    hostTtlMs = 12 * 60 * 60 * 1000,
  } = opts;
  if (!token || !secret) throw new Error("token dan secret wajib diisi");

  const tokenCheckUrl = `${accountApi}/api-token.do`;

  function assertAccurateUrl(u) {
    const url = u instanceof URL ? u : new URL(u);
    if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
      throw new Error(`Diblokir: protokol tidak diizinkan (${url.protocol})`);
    }
    const ok = allowedHostSuffixes.some((s) => url.hostname === s.replace(/^\./, "") || url.hostname.endsWith(s));
    if (!ok) throw new Error(`Diblokir: host '${url.hostname}' bukan host Accurate yang diizinkan.`);
    return url;
  }

  function authHeaders() {
    const timestamp = Date.now().toString(); // epoch milidetik (format yang diterima Accurate)
    const signature = crypto.createHmac("sha256", secret).update(timestamp).digest(sigEncoding);
    return {
      Authorization: `Bearer ${token}`,
      "X-Api-Timestamp": timestamp,
      "X-Api-Signature": signature,
      Accept: "application/json",
    };
  }

  let active = 0;
  const waiters = [];
  async function withSlot(fn) {
    if (active >= maxParallel) await new Promise((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  }

  let cachedHost = null;

  async function request(url, { method = "GET", query = {} } = {}) {
    const isTokenCheck = method === "POST" && url === tokenCheckUrl;
    if (method !== "GET" && !isTokenCheck) {
      throw new Error("Diblokir: hanya HTTP GET yang diizinkan (server read-only).");
    }
    let target = assertAccurateUrl(url);
    for (const [k, v] of Object.entries(query)) target.searchParams.set(String(k), String(v));

    return withSlot(async () => {
      let res;
      for (let hop = 0; hop < 3; hop++) {
        res = await fetch(target, {
          method,
          headers: authHeaders(), // ditandatangani ulang tiap percobaan
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 308 && res.headers.get("location")) {
          // Host berubah. Ikuti hanya jika tujuan tetap domain Accurate (token tidak boleh bocor ke host lain).
          target = assertAccurateUrl(new URL(res.headers.get("location"), target));
          cachedHost = null;
          continue;
        }
        break;
      }
      if (res.status === 308) throw new Error("Terlalu banyak redirect 308 dari Accurate.");

      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Respons bukan JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      if (!res.ok || body?.s === false) {
        const detail = Array.isArray(body?.d) ? body.d.join("; ") : JSON.stringify(body).slice(0, 300);
        throw new Error(`Accurate error (HTTP ${res.status}): ${detail}`);
      }
      return body;
    });
  }

  async function getHost(force = false) {
    if (cachedHost && !force && Date.now() - cachedHost.at < hostTtlMs) return cachedHost;
    const body = await request(tokenCheckUrl, { method: "POST" });
    const d = body?.d ?? {};
    // Dokumentasi menulis "data usaha"; cari juga nama lain agar tahan terhadap perbedaan penamaan.
    const usaha =
      d["data usaha"] ?? d.database ?? Object.values(d).find((v) => v && typeof v === "object" && typeof v.host === "string");
    if (!usaha?.host) {
      throw new Error(`Host tidak ditemukan di respons api-token.do. Kunci pada "d": [${Object.keys(d).join(", ")}]`);
    }
    assertAccurateUrl(usaha.host);
    cachedHost = {
      host: usaha.host,
      alias: usaha.alias ?? null,
      databaseId: usaha.id ?? null,
      user: d.user?.email ?? null,
      at: Date.now(),
    };
    return cachedHost;
  }

  /** path relatif, mis. "glaccount/list.do". Selalu GET. */
  async function api(path, query = {}) {
    assertSafeShape(path);
    const { host } = await getHost();
    return request(`${host}/accurate/api/${path}`, { query });
  }

  return { getHost, api, request };
}
