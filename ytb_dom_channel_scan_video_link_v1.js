/**
 * YouTube Link Extractor – v2 (fix relative URLs + more sources + auto-scroll)
 * - Bắt: watch?v=, /shorts/, youtu.be, /embed/
 * - Nguồn: <a href>, <iframe src>, <video/src><source src>, <link href>, plain text
 * - Chuẩn hoá thành canonical: https://www.youtube.com/watch?v=<ID>
 * - Auto-scroll trang hiện tại; dừng khi không tăng link hoặc không tăng chiều cao
 */

(async () => {
  const CONFIG = {
    scroll: {
      enabled: true,
      delayMs: 1200,
      stopWhenNoGrowth: true,
      alsoStopWhenNoNewLinks: true,
      maxScrolls: 100,
      scrollBy: () => window.scrollTo(0, document.documentElement.scrollHeight),
    },
    export: {
      csvFilename: "youtube_links.csv",
      jsonFilename: "youtube_links.json",
      csvAddBom: true,
      csvEol: "\r\n",
      downloadFiles: true,
    },
    normalize: {
      toCanonicalWatch: true,
      detectShorts: true,
    },
    console: {
      showTable: true,
      logEveryScroll: true,
    }
  };

  // --- Helpers ---
  const toCanonicalWatch = (id) => `https://www.youtube.com/watch?v=${id}`;

  // Gỡ lớp redirect phổ biến (Facebook, Google, …)
  const unwrapRedirect = (url) => {
    try {
      const u = new URL(url);
      // facebook l.php?u=...
      if (/facebook\.com$/i.test(u.hostname) && u.pathname.includes('/l.php')) {
        const target = u.searchParams.get('u'); if (target) return decodeURIComponent(target);
      }
      // google /url?q=...
      if (/google\./i.test(u.hostname) && u.pathname === '/url') {
        const q = u.searchParams.get('q'); if (q) return q;
      }
      return url;
    } catch { return url; }
  };

  // Nhận diện & lấy videoId từ nhiều dạng URL (đÃ chuẩn hoá absolute)
  const parseYouTube = (absUrl) => {
    try {
      const raw = unwrapRedirect(absUrl);
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, "");
      let videoId = null, type = null;

      if (/^youtube\.com$/i.test(host)) {
        if (u.pathname === "/watch") {
          videoId = u.searchParams.get("v"); type = "watch";
        } else if (u.pathname.startsWith("/shorts/")) {
          videoId = u.pathname.split("/shorts/")[1]?.split(/[?#]/)[0]; type = "shorts";
        } else if (u.pathname.startsWith("/embed/")) {
          videoId = u.pathname.split("/embed/")[1]?.split(/[?#]/)[0]; type = "embed";
        }
      } else if (/^m\.youtube\.com$/i.test(host)) {
        if (u.pathname === "/watch") { videoId = u.searchParams.get("v"); type = "watch"; }
      } else if (/^youtu\.be$/i.test(host)) {
        videoId = u.pathname.slice(1).split(/[?#]/)[0]; type = "youtu.be";
      }

      if (videoId && /^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
        const canonicalUrl = toCanonicalWatch(videoId);
        const isShort = CONFIG.normalize.detectShorts ? (type === "shorts" || /\/shorts\//.test(raw)) : false;
        return { videoId, canonicalUrl, originalUrl: raw, type, isShort };
      }
      return null;
    } catch { return null; }
  };

  const dedupe = (items) => {
    const seen = new Set(); const out = [];
    for (const it of items) {
      const key = it.videoId || it.canonicalUrl || it.originalUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(it);
    }
    return out;
  };

  const toCSV = (data) => {
    if (!data.length) return "";
    const keys = Array.from(data.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
    const head = keys.join(",") + CONFIG.export.csvEol;
    const rows = data.map(r => keys.map(k => {
      const v = String(r[k] ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ");
      return `"${v}"`;
    }).join(",")).join(CONFIG.export.csvEol);
    return head + rows + CONFIG.export.csvEol;
  };

  const downloadText = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    if (!CONFIG.export.downloadFiles) { console.log(`[Download disabled] ${filename}`, blob); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // Thu thập từ DOM: DÙNG .href / .src (absolute) để không bị rơi link tương đối
  const collectAbsoluteURLsFromDOM = () => {
    const urls = [];

    document.querySelectorAll('a[href]').forEach(a => { try { if (a.href) urls.push(a.href); } catch {} });
    document.querySelectorAll('iframe[src]').forEach(el => { try { if (el.src) urls.push(el.src); } catch {} });
    document.querySelectorAll('video[src]').forEach(el => { try { if (el.src) urls.push(el.src); } catch {} });
    document.querySelectorAll('source[src]').forEach(el => { try { if (el.src) urls.push(el.src); } catch {} });
    document.querySelectorAll('link[href]').forEach(el => { try { if (el.href) urls.push(el.href); } catch {} });

    // Thêm cả text để bắt link dán trần (protocol full)
    const txt = document.body ? (document.body.innerText || document.body.textContent || "") : "";
    const reFull = /https?:\/\/[^\s"'<>]+/g;
    let m; while ((m = reFull.exec(txt)) !== null) urls.push(m[0]);

    return urls;
  };

  // Auto-scroll
  const autoScroll = async (getCount) => {
    if (!CONFIG.scroll.enabled) return;
    const { delayMs, stopWhenNoGrowth, alsoStopWhenNoNewLinks, maxScrolls, scrollBy } = CONFIG.scroll;
    let lastH = 0, lastC = 0;
    for (let i = 0; i < maxScrolls; i++) {
      scrollBy();
      await new Promise(r => setTimeout(r, delayMs));
      const h = document.documentElement.scrollHeight;
      const c = getCount();

      if (CONFIG.console.logEveryScroll) console.log(`[Scroll] step=${i+1} height=${h} links=${c}`);
      const noGrowth = stopWhenNoGrowth && h === lastH;
      const noNew = alsoStopWhenNoNewLinks && c === lastC && c > 0; // chỉ dừng vì “no new” sau khi đã từng có link
      if (noGrowth || noNew) break;

      lastH = h; lastC = c;
    }
  };

  // --- MAIN ---
  try {
    let items = [];

    // Lần quét đầu
    collectAbsoluteURLsFromDOM().forEach(u => { const p = parseYouTube(u); if (p) items.push(p); });

    // Auto-scroll và tiếp tục thu thập
    await autoScroll(() => {
      collectAbsoluteURLsFromDOM().forEach(u => { const p = parseYouTube(u); if (p) items.push(p); });
      return dedupe(items).length;
    });

    items = dedupe(items);

    if (CONFIG.console.showTable && items.length) {
      console.table(items.map(x => ({
        videoId: x.videoId,
        type: x.type,
        isShort: x.isShort,
        canonicalUrl: x.canonicalUrl,
        originalUrl: x.originalUrl,
      })));
    }

    // Xuất
    const json = JSON.stringify(items, null, 2);
    downloadText(json, CONFIG.export.jsonFilename, "application/json;charset=utf-8;");
    const csv = toCSV(items);
    const parts = CONFIG.export.csvAddBom ? ["\uFEFF", csv] : [csv];
    downloadText(parts.join(""), CONFIG.export.csvFilename, "text/csv;charset=utf-8;");

    console.log(`✅ Tổng link YouTube unique: ${items.length}`);
    if (!items.length) console.warn("Không thấy link YouTube. Trang này có thể không chứa link, hoặc link nằm trong iframe cross-origin khác domain mà script không truy cập được.");
  } catch (err) {
    console.error("❌ Lỗi:", err);
  }
})();
