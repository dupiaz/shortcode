/**
 * YouTube Scraper – Channel‑Named Exports (Console Template)
 * ---------------------------------------------------------
 * Nâng cấp từ bản refactor chuẩn hoá:
 *  - Tự phát hiện tên kênh → đặt tên file `${TenKenh}_video.*` và `${TenKenh}_short.*`
 *  - Tách dữ liệu Video thường vs Shorts khi xuất.
 *  - Giữ nguyên cấu hình, helpers, parser, dedupe, filters, log tiến trình.
 *
 * Cách dùng:
 * 1) Mở trang kênh (tab Videos) hoặc trang có lưới video.
 * 2) DevTools → Console: dán toàn bộ file → Enter.
 * 3) Tuỳ chỉnh CONFIG.fetch / CONFIG.filters nếu cần.
 */

(async () => {
  /* ==========================================================
   * 1) CONFIG – Toàn bộ cấu hình tập trung 1 chỗ
   * ========================================================== */
  const CONFIG = {
    selectors: {
      container: "ytd-rich-grid-media",       // đổi nếu layout khác: ytd-video-renderer, ytd-grid-video-renderer, …
      titleLink: "a#video-title-link",
      titleAlt: "a#video-title",
      metadataLine: "#metadata-line span",
      duration: "ytd-thumbnail-overlay-time-status-renderer span",
    },

    scroll: {
      delayMs: 2000,
      stopWhenNoGrowth: true,
      maxScrollsWhenCount: 30,
      hardCapWhenAll: 500,
    },

    fetch: {
      mode: "count",          // "count" | "all"
      targetCount: 50,
      limitToTarget: true,
      stopWhenReached: true,
    },

    filters: {
      includeShorts: true,      // false = loại Shorts
      minDurationSec: 0,
      maxDurationSec: Infinity,
      titleIncludes: [],        // AND tất cả từ khoá
      titleExcludes: [],
      publishedFrom: null,      // ví dụ: "2024-01-01T00:00:00.000Z"
      publishedTo: null,
    },

    export: {
      csvFilename: "youtube_videos.csv", // sẽ bị override bởi tên kênh khi tách nhóm
      jsonFilename: "youtube_videos.json",
      timestampFormat: "iso",            // "iso" | "local"
      csvDelimiter: ",",
      csvAddBom: true,                    // BOM để Excel không lỗi tiếng Việt
      csvEol: "\r\n",
      flattenObjectsInCSV: true,
      downloadFiles: true,
    },

    thumbnails: ["default", "mqdefault", "hqdefault", "maxresdefault"],

    console: {
      showTable: true,
      showCount: true,
      logEveryScroll: true,
      previewFields: ["title", "url", "duration", "views", "dateText", "scrapedAt"],
    },

    baseUrl: "https://www.youtube.com",
  };

  /* ==========================================================
   * 2) Namespaces (Modules)
   * ========================================================== */
  const Utils = {
    getScrapedAt() {
      const now = new Date();
      if (CONFIG.export.timestampFormat === "local") {
        return new Intl.DateTimeFormat(undefined, {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        }).format(now).replace(",", "");
      }
      return now.toISOString();
    },
    hhmmssToSeconds(str) {
      if (!str) return null;
      const s = String(str).trim();
      const parts = s.split(":").map(n => parseInt(n, 10));
      if (parts.some(n => Number.isNaN(n))) return null;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return null;
    },
    buildThumbnails(videoId) {
      if (!videoId) return {};
      const allowed = new Set(CONFIG.thumbnails);
      const map = {
        default: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
        mqdefault: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        hqdefault: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        maxresdefault: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      };
      return Object.fromEntries(Object.entries(map).filter(([k]) => allowed.has(k)));
    },
    extractVideoId(url) {
      if (!url) return null;
      try {
        const u = new URL(url);
        let id = u.searchParams.get("v");
        if (!id && u.pathname.startsWith("/shorts/")) {
          id = u.pathname.split("/shorts/")[1]?.split(/[?/]/)[0] || null;
        }
        return id || null;
      } catch (_) { return null; }
    },
    getCurrentDomCount() {
      return document.querySelectorAll(CONFIG.selectors.container).length;
    },
  };

  const Parsers = {
    parseViews(text) {
      if (!text) return null;
      let s = text.trim()
        .replace(/\u00A0/g, " ")
        .replace(/views|lượt xem|lượt xem/gi, "")
        .replace(/,/g, "")
        .trim();
      const multipliers = [
        { re: /(k|nghìn|ngan|ngàn|ngan\b|n)\b/i, m: 1e3 },
        { re: /(m|triệu|tr)\b/i, m: 1e6 },
        { re: /(b|tỷ|ty)\b/i, m: 1e9 },
      ];
      s = s.replace(/\.(?=\d{3}\b)/g, "");
      s = s.replace(/,(?=\d{3}\b)/g, "");
      s = s.replace(/(\d)[\.,](\d)/g, "$1.$2");
      for (const { re, m } of multipliers) {
        if (re.test(s)) {
          const num = parseFloat(s.replace(re, ""));
          return Number.isFinite(num) ? Math.round(num * m) : null;
        }
      }
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    },
    parsePublishedAt(text) {
      if (!text) return null;
      const s = text.trim().toLowerCase();
      const agoRules = [
        { unit: "second", re: /(\d+)\s*(seconds?|giây)\s*(ago|trước)/ },
        { unit: "minute", re: /(\d+)\s*(minutes?|phút)\s*(ago|trước)/ },
        { unit: "hour",   re: /(\d+)\s*(hours?|giờ)\s*(ago|trước)/ },
        { unit: "day",    re: /(\d+)\s*(days?|ngày)\s*(ago|trước)/ },
        { unit: "week",   re: /(\d+)\s*(weeks?|tuần)\s*(ago|trước)/ },
        { unit: "month",  re: /(\d+)\s*(months?|tháng)\s*(ago|trước)/ },
        { unit: "year",   re: /(\d+)\s*(years?|năm)\s*(ago|trước)/ },
      ];
      for (const { unit, re } of agoRules) {
        const m = s.match(re);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n)) {
            const d = new Date();
            switch (unit) {
              case "second": d.setSeconds(d.getSeconds() - n); break;
              case "minute": d.setMinutes(d.getMinutes() - n); break;
              case "hour":   d.setHours(d.getHours() - n); break;
              case "day":    d.setDate(d.getDate() - n); break;
              case "week":   d.setDate(d.getDate() - n * 7); break;
              case "month":  d.setMonth(d.getMonth() - n); break;
              case "year":   d.setFullYear(d.getFullYear() - n); break;
            }
            return d;
          }
        }
      }
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? new Date(parsed) : null;
    },
  };

  const Filters = {
    isShorts(item) {
      if (!item) return false;
      if (item.url && /\/shorts\//.test(item.url)) return true;
      const dur = item.durationSec;
      return Number.isFinite(dur) && dur < 60;
    },
    pass(item) {
      const f = CONFIG.filters;
      if (!f.includeShorts && Filters.isShorts(item)) return false;
      const d = item.durationSec;
      if (Number.isFinite(f.minDurationSec) && d != null && d < f.minDurationSec) return false;
      if (Number.isFinite(f.maxDurationSec) && d != null && d > f.maxDurationSec) return false;
      if (Array.isArray(f.titleIncludes) && f.titleIncludes.length > 0) {
        const title = (item.title || "").toLowerCase();
        for (const kw of f.titleIncludes) {
          if (!title.includes(String(kw).toLowerCase())) return false;
        }
      }
      if (Array.isArray(f.titleExcludes) && f.titleExcludes.length > 0) {
        const title = (item.title || "").toLowerCase();
        for (const kw of f.titleExcludes) {
          if (title.includes(String(kw).toLowerCase())) return false;
        }
      }
      const p = item.publishedAt instanceof Date ? item.publishedAt : null;
      if (p) {
        if (f.publishedFrom && p < new Date(f.publishedFrom)) return false;
        if (f.publishedTo && p > new Date(f.publishedTo)) return false;
      }
      return true;
    }
  };

  const Scroll = {
    async auto() {
      const { delayMs, stopWhenNoGrowth, maxScrollsWhenCount, hardCapWhenAll } = CONFIG.scroll;
      const { mode, targetCount, stopWhenReached } = CONFIG.fetch;
      let lastHeight = 0;
      if (mode === "all") {
        for (let i = 0; i < hardCapWhenAll; i++) {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise(r => setTimeout(r, delayMs));
          const newHeight = document.documentElement.scrollHeight;
          if (CONFIG.console.logEveryScroll) console.log(`[Scroll][all] step=${i+1} height=${newHeight}`);
          if (stopWhenNoGrowth && newHeight === lastHeight) break;
          lastHeight = newHeight;
        }
        return;
      }
      for (let i = 0; i < maxScrollsWhenCount; i++) {
        if (stopWhenReached && targetCount && Utils.getCurrentDomCount() >= targetCount) break;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(r => setTimeout(r, delayMs));
        const newHeight = document.documentElement.scrollHeight;
        if (CONFIG.console.logEveryScroll) console.log(`[Scroll][count] step=${i+1} height=${newHeight}`);
        if (stopWhenNoGrowth && newHeight === lastHeight) break;
        lastHeight = newHeight;
      }
    }
  };

  const Scraper = {
    scrapeRaw() {
      const s = CONFIG.selectors;
      const scrapedAt = Utils.getScrapedAt();
      const nodes = document.querySelectorAll(s.container);
      if (!nodes || nodes.length === 0) return [];
      const list = Array.from(nodes).map((el) => {
        const titleEl = el.querySelector(s.titleLink) || el.querySelector(s.titleAlt);
        const title = titleEl?.innerText?.trim() || null;
        const href = titleEl?.getAttribute("href") || null;
        const url = href ? CONFIG.baseUrl + href : null;
        const videoId = Utils.extractVideoId(url);
        const thumbnails = Utils.buildThumbnails(videoId);
        const spans = el.querySelectorAll(s.metadataLine);
        const viewsRaw = spans?.[0]?.innerText?.trim() || null;
        const dateText = spans?.[1]?.innerText?.trim() || null;
        const durationRaw = el.querySelector(s.duration)?.innerText?.trim() || null;
        const views = Parsers.parseViews(viewsRaw);
        const publishedAt = Parsers.parsePublishedAt(dateText);
        const durationSec = Utils.hhmmssToSeconds(durationRaw);
        return {
          title, url, videoId, thumbnails,
          duration: durationRaw, durationSec,
          viewsRaw, views,
          dateText, publishedAt,
          scrapedAt,
        };
      });
      return list;
    },
    dedupe(items) {
      const seenId = new Set();
      const seenUrl = new Set();
      const out = [];
      for (const it of items) {
        if (it.videoId) {
          if (seenId.has(it.videoId)) continue;
          seenId.add(it.videoId);
          out.push(it);
        } else if (it.url) {
          if (seenUrl.has(it.url)) continue;
          seenUrl.add(it.url);
          out.push(it);
        } else {
          out.push(it);
        }
      }
      return out;
    },
    applyFilters(items) {
      return items.filter(Filters.pass);
    },
    maybeLimit(items) {
      if (CONFIG.fetch.mode === "count" && CONFIG.fetch.limitToTarget && CONFIG.fetch.targetCount) {
        return items.slice(0, CONFIG.fetch.targetCount);
      }
      return items;
    },
  };

  const Exporters = {
    toCSV(data, filename) {
      if (!data || data.length === 0) return;
      const { csvDelimiter, csvAddBom, csvEol, flattenObjectsInCSV } = CONFIG.export;
      const allKeys = Array.from(data.reduce((set, row) => {
        Object.keys(row).forEach(k => set.add(k));
        return set;
      }, new Set()));
      const header = allKeys.join(csvDelimiter) + csvEol;
      const rows = data.map(row =>
        allKeys.map(k => {
          let v = row[k];
          if (flattenObjectsInCSV && v && typeof v === "object") v = JSON.stringify(v);
          v = String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ");
          return `"${v}"`;
        }).join(csvDelimiter)
      ).join(csvEol);
      const csvContent = header + rows + csvEol;
      const parts = csvAddBom ? ["\uFEFF", csvContent] : [csvContent];
      const blob = new Blob(parts, { type: "text/csv;charset=utf-8;" });
      if (!CONFIG.export.downloadFiles) { console.log("[CSV] Blob ready", blob); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    },
    toJSON(data, filename) {
      if (!data || data.length === 0) return;
      const jsonContent = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
      if (!CONFIG.export.downloadFiles) { console.log("[JSON] Blob ready", blob); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    },
  };

  /** Meta – lấy tên kênh & tiện ích tên file */
  const Meta = {
    getChannelName() {
      const candidates = [
        () => document.querySelector('ytd-c4-tabbed-header-renderer #channel-name #text')?.textContent,
        () => document.querySelector('ytd-channel-name#channel-name yt-formatted-string')?.textContent,
        () => document.querySelector('meta[itemprop="name"]')?.getAttribute('content'),
        () => (document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '')
                .replace(/\s*-\s*YouTube\s*$/i, ''),
        () => document.title.replace(/\s*-\s*YouTube\s*$/i, ''),
      ];
      for (const fn of candidates) {
        try { const v = fn(); if (v && v.trim()) return v.trim(); } catch(_) {}
      }
      return 'youtube';
    },
    toSafeFilename(str) {
      return String(str || 'youtube')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9-_.\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 80);
    }
  };

  /* ==========================================================
   * 3) MAIN – Scroll → Scrape → Dedupe → Filter → Limit → Export
   * ========================================================== */
  try {
    await Scroll.auto();
    const raw = Scraper.scrapeRaw();
    const unique = Scraper.dedupe(raw);
    const filtered = Scraper.applyFilters(unique);
    const videos = Scraper.maybeLimit(filtered);

    if (CONFIG.console.showCount) {
      const modeMsg = CONFIG.fetch.mode === "all" ? "(all)" : `/ target ${CONFIG.fetch.targetCount}`;
      console.log(`✅ Tổng sau lọc/dedupe: ${videos.length} ${modeMsg}`);
    }
    if (CONFIG.console.showTable && videos.length > 0) {
      console.table(
        videos.map(v => ({
          title: v.title, url: v.url, duration: v.duration,
          views: v.views, date: v.dateText, scrapedAt: v.scrapedAt,
        }))
      );
    }

    // Xuất file: tách Video thường vs Shorts + đặt tên theo tên kênh
    if (videos.length > 0) {
      const channel = Meta.toSafeFilename(Meta.getChannelName());
      const shorts = videos.filter(v => Filters.isShorts(v));
      const longs  = videos.filter(v => !Filters.isShorts(v));

      if (longs.length > 0) {
        Exporters.toCSV(longs, `${channel}_video.csv`);
        Exporters.toJSON(longs, `${channel}_video.json`);
        console.log(`📥 Đã xuất: ${channel}_video.csv, ${channel}_video.json`);
      }
      if (shorts.length > 0) {
        Exporters.toCSV(shorts, `${channel}_short.csv`);
        Exporters.toJSON(shorts, `${channel}_short.json`);
        console.log(`📥 Đã xuất: ${channel}_short.csv, ${channel}_short.json`);
      }
      if (longs.length === 0 && shorts.length === 0) {
        console.warn('⚠️ Không có dữ liệu hợp lệ để xuất.');
      }
    } else {
      console.warn('⚠️ Không có video sau khi áp dụng lọc/dedupe. Kiểm tra selector hoặc nới bộ lọc.');
    }
  } catch (err) {
    console.error('❌ Lỗi không mong muốn:', err);
  }
})();
