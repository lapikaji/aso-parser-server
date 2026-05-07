// server.js
// Требуется package.json c { "type": "module", "scripts": { "start": "node server.js" } }

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());

app.get("/gplay/about", async (req, res) => {
  const appId = String(req.query.appId || "").trim();
  const gl = (req.query.gl || "US").toString();
  const hl = (req.query.hl || "en").toString(); // держим en по умолчанию
  const debug = String(req.query.debug || "") === "1";

  if (!appId) {
    res.status(400).json({ error: "appId is required" });
    return;
  }

  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(
    appId
  )}&gl=${gl}&hl=${hl}`;

  let browser, ctx, page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });

    page = await ctx.newPage();

    // Чуть экономим трафик
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font"].includes(t)) return route.abort();
      route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // Прокрутим страницу, чтобы ленивая разметка ожила
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(150);
    }

    // Откроем модалку "About this app" (если есть)
    const aboutBtn = page.getByRole("button", { name: /about this app/i });
    if (await aboutBtn.count()) {
      await aboutBtn.first().click({ timeout: 20000 }).catch(() => {});
    } else {
      await page.locator('text=/About this app/i').first().click({ timeout: 20000 }).catch(() => {});
    }

    // Если модалка есть — тоже прокрутим её
    const dialog = page.getByRole("dialog");
    if (await dialog.count()) {
      for (let i = 0; i < 6; i++) {
        await dialog.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
        await page.waitForTimeout(150);
      }
    }

    // ===== Стабильный сбор значений по текстам лейблов =====
    const result = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]') || document;

      const LABELS = [
        { field: "version",         texts: ["Current version", "Version"] },
        { field: "updatedOn",       texts: ["Updated on", "Updated"] },
        { field: "requiresAndroid", texts: ["Requires Android"] },
        { field: "downloads",       texts: ["Downloads"] },
        { field: "iapRange",        texts: ["In-app purchases"] },
        { field: "contentRating",   texts: ["Content rating"] },
        { field: "releasedOn",      texts: ["Released on"] },
        { field: "offeredBy",       texts: ["Offered by"] },
      ];

      function findLabelNodes(rootEl, text) {
        const txt = text.trim().toLowerCase();
        const all = Array.from(rootEl.querySelectorAll("*"));
        return all.filter(
          (el) =>
            el.children.length === 0 &&
            (el.textContent || "").trim().toLowerCase() === txt
        );
      }

      function extractValueFromLabelNode(labelEl) {
        const tryClasses = ["reAt0b", "wVqUob", "htlgb", "xg1aie", "c8Tvdf"];

        for (const cls of tryClasses) {
          const v1 = labelEl.closest("div")?.querySelector(`div.${cls}`);
          if (v1 && v1.textContent.trim()) return v1.textContent.trim();
        }

        // Соседи справа
        let sib = labelEl.nextElementSibling;
        for (let i = 0; i < 6 && sib; i++, (sib = sib?.nextElementSibling)) {
          const txt = (sib?.textContent || "").trim();
          if (txt) return txt;
        }

        // Родители повыше
        let par = labelEl.parentElement;
        for (let i = 0; i < 3 && par; i++, (par = par?.parentElement)) {
          const txt = (par?.querySelector("div,span")?.textContent || "").trim();
          if (txt && txt !== (labelEl.textContent || "").trim()) return txt;
        }

        return "";
      }

      const out = {};
      const debugHits = [];

      for (const { field, texts } of LABELS) {
        let value = "";
        for (const t of texts) {
          const nodes = findLabelNodes(root, t);
          if (nodes.length) {
            value = extractValueFromLabelNode(nodes[0]);
            debugHits.push({
              field,
              matched: t,
              labelSample: nodes[0].outerHTML.slice(0, 120),
            });
            if (value) break;
          }
        }
        out[field] = value || "";
      }

      return { out, debugHits };
    });

    let { out, debugHits } = result;

    // Нормализация
if (out.downloads) out.downloads = out.downloads.replace(/\s*downloads?$/i, "").trim();
if (out.requiresAndroid) out.requiresAndroid = out.requiresAndroid.replace(/^android\s*/i, "").trim();
if (out.contentRating) out.contentRating = out.contentRating.replace(/\s*learn more$/i, "").trim();

    const data = {
      version: out.version || "",
      updatedOn: out.updatedOn || "",
      requiresAndroid: out.requiresAndroid || "",
      downloads: out.downloads || "",
      iapRange: out.iapRange || "",
      contentRating: out.contentRating || "",
      releasedOn: out.releasedOn || "",
      offeredBy: out.offeredBy || "",
    };

    if (debug) data._debug = { url, hits: debugHits };
    res.set("Cache-Control", "no-store");
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("gplay about service on", PORT));









// === iOS screenshots endpoint ============================================
// GET /apple/shots?id=1658514439&cc=us&lang=en&device=iphone&limit=12[&debug=1]
// device: iphone | ipad | all
app.get('/apple/shots', async (req, res) => {
  const id     = String(req.query.id || '').match(/\d{6,}/)?.[0];
  const cc     = String(req.query.cc || 'us').toLowerCase();
  const lang   = String(req.query.lang || 'en').toLowerCase();
  const device = String(req.query.device || 'iphone').toLowerCase();
  const limit  = Math.max(1, Number(req.query.limit || 20));
  const debug  = String(req.query.debug || '') === '1';
  if (!id) return res.status(400).json({ error: 'pass ?id=<numeric app id>' });

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const urlFor = (plat) => `https://apps.apple.com/${cc}/app/id${id}?platform=${plat}&l=${encodeURIComponent(lang)}`;

  const result = { id, cc, lang, device, iphone: [], ipad: [], total: { iphone: 0, ipad: 0 } };

  const normalizeBase = (u) => String(u||'')
    .replace(/&amp;/g,'&')
    .replace(/\/(?:\d+(?:x\d+)?(?:bb|sr)?(?:-\d+)?|\d+x0w)\.(?:png|jpe?g|webp)(?:\?.*)?$/i,''); // базовый путь без размеров

  const isLikelyShot = (u) => {
    if (!/^https?:\/\//i.test(u)) return false;
    if (!/mzstatic\.com\/image\/thumb\/(?:Purple|PurpleSource)/i.test(u)) return false;
    if (/(AppIcon|Artwork|MarketingArtwork|poster|videoposter|posterframe|previewimage|preview|trailer|mask|placeholder|gradient|Feature)/i.test(u)) return false;
    return true; // размеры больше не рубим жестко, мы их апскейпим
  };

  const upsizeForKind = (u, kind) => {
    const target = kind === 'ipad' ? '1286x1714bb.webp' : '600x1300bb.webp';
    // если уже есть суффикс с размерами — заменим на целевой, иначе добавим
    if (/\d+x\d+bb(?:-\d+)?\.(?:webp|jpg|jpeg|png)/i.test(u)) {
      return u.replace(/\/\d+x\d+bb(?:-\d+)?\.(webp|jpg|jpeg|png)$/i, `/${target}`);
    }
    if (/\/\d+x0w\.(?:webp|jpg|jpeg|png)$/i.test(u)) {
      return u.replace(/\/\d+x0w\.(webp|jpg|jpeg|png)$/i, `/${target}`);
    }
    // нет размеров в урле, просто приклеим целевой
    return u.replace(/\/(?:[^/]+)$/i, m => `/${target}`);
  };

  const pickFromSrcset = (set) => {
    const parts = String(set||'').split(',').map(s=>s.trim()).filter(Boolean);
    let best = null, bestW = -1;
    for (const p of parts) {
      const m = p.match(/^(\S+)\s+(\d+)w$/);
      if (!m) continue;
      const u = m[1]; const w = parseInt(m[2], 10) || 0;
      if (w > bestW) { bestW = w; best = u; }
    }
    return best;
  };

  async function collectFor(plat) {
    const kind = plat === 'ipad' ? 'ipad' : 'iphone';
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: { 'Accept-Language': `${lang}-${cc.toUpperCase()},${lang};q=0.9,en-US;q=0.8,en;q=0.7` },
      viewport: { width: 1440, height: 1400 }
    });
    const page = await ctx.newPage();
    const byIdx = new Map();

    const gridTokens = kind === 'ipad'
      ? ['shelf-grid__list--grid-type-ScreenshotPad','shelf-grid__list--grid-type-ScreenshotLarge']
      : ['shelf-grid__list--grid-type-ScreenshotPhone'];

    const anyGridSel = 'ul[class*="shelf-grid__list--grid-type-"]';
    const primarySel = gridTokens.map(t => `ul.${t}`).join(', ');
    const dialogSel  = 'dialog[data-test-id="dialog"]';

    const dbg = async (label) => {
      if (!debug) return;
      const d = await page.evaluate(({primarySel, gridTokens}) => {
        const roots = Array.from(document.querySelectorAll(primarySel));
        return {
          roots: roots.length,
          tokens: gridTokens,
          lists: roots.map((ul,i)=>({
            i, cls: ul.className,
            li: ul.querySelectorAll('li.shelf-grid__list-item').length,
            idx: Array.from(ul.querySelectorAll('li.shelf-grid__list-item')).map(li=>li.getAttribute('data-index')).filter(Boolean)
          }))
        };
      }, {primarySel, gridTokens}).catch(()=>null);
      console.log(`[shots][${kind}] ${label}: ${JSON.stringify(d)}`);
    };

    const grabOrdered = async () => {
      const items = await page.evaluate(({ gridTokens }) => {
        const roots = Array.from(document.querySelectorAll('ul[class*="shelf-grid__list--grid-type-"]'))
          .filter(ul => gridTokens.some(t => ul.className.includes(t)));

        const pickSet = (set) => {
          const parts = String(set||'').split(',').map(s=>s.trim()).filter(Boolean);
          let best = null, bestW = -1;
          for (const p of parts) {
            const m = p.match(/^(\S+)\s+(\d+)w$/);
            if (!m) continue;
            const u = m[1]; const w = parseInt(m[2], 10) || 0;
            if (w > bestW) { bestW = w; best = u; }
          }
          return best;
        };

        const out = [];
        let seq = 0;
        for (const root of roots) {
          const lis = Array.from(root.querySelectorAll('li.shelf-grid__list-item'));
          for (const li of lis) {
            const idxAttr = li.getAttribute('data-index');
            const idx = /^\d+$/.test(idxAttr||'') ? Number(idxAttr) : seq++;
            let url = null;

            const pic = li.querySelector('picture');
            url = pickSet(pic?.querySelector('source')?.getAttribute('srcset') || pic?.querySelector('source')?.getAttribute('data-srcset'));
            if (!url) url = pickSet(li.querySelector('img')?.getAttribute('srcset') || li.querySelector('img')?.getAttribute('data-srcset'));
            if (!url) url = li.querySelector('img')?.getAttribute('src') || li.querySelector('img')?.getAttribute('data-src');

            if (!url) {
              const ns = li.querySelector('noscript');
              const html = ns?.innerHTML || '';
              const m1 = html.match(/(?:srcset|data-srcset)=["']([\s\S]*?)["']/i);
              if (m1) url = pickSet(m1[1]);
              if (!url) {
                const m2 = html.match(/(?:src|data-src)=["']([^"']+)["']/i);
                if (m2) url = m2[1];
              }
            }

            if (!url) {
              // брут по html: берём последний урл
              const html = li.innerHTML;
              const all = html.match(/https?:\/\/[^"'()\s]+mzstatic\.com\/image\/thumb\/[^"'()\s]+/ig) || [];
              if (all.length) url = all[all.length - 1];
            }

            if (url) out.push({ idx, url });
          }
        }
        return out;
      }, { gridTokens });

      for (const { idx, url } of items) if (!byIdx.has(idx)) byIdx.set(idx, url);
    };

    const pageByButtons = async () => {
      for (let i = 0; i < 50; i++) {
        const clicked = await page.evaluate((primarySel) => {
          const ul = document.querySelector(primarySel);
          if (!ul) return false;
          const wrap = ul.closest('[data-testid="shelf-component"]') || ul.parentElement;
          const btn = wrap?.querySelector('button.shelf-grid-nav__arrow--right')
                  || wrap?.querySelector('button[aria-label="Next Page"]')
                  || wrap?.querySelector('button[aria-label^="Next"]');
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
        }, primarySel).catch(()=>false);
        await page.waitForTimeout(220);
        await grabOrdered();
        if (!clicked) break;
        if (byIdx.size >= limit) break;
      }
    };

    const scrollShelfToEnd = async () => {
      for (let i = 0; i < 80; i++) {
        const atEnd = await page.evaluate((primarySel) => {
          const ul = document.querySelector(primarySel);
          if (!ul) return true;
          const before = ul.scrollLeft;
          ul.scrollBy({ left: ul.clientWidth, behavior: 'instant' });
          const after = ul.scrollLeft;
          return Math.abs(after - before) < 5 || (after + ul.clientWidth >= ul.scrollWidth - 2);
        }, primarySel).catch(()=>true);
        await page.waitForTimeout(160);
        await grabOrdered();
        if (byIdx.size >= limit || atEnd) break;
      }
    };

    const sweepDialog = async () => {
      const first = await page.$(`${primarySel} li[aria-hidden="false"]`) || await page.$(`${primarySel} li`);
      if (!first) return;
      await first.click().catch(()=>{});
      await page.waitForSelector(dialogSel, { state: 'visible', timeout: 5000 }).catch(()=>{});
      await page.waitForTimeout(180);

      const grabHero = async () => {
        const u = await page.evaluate((dialogSel) => {
          const root = document.querySelector(dialogSel);
          const hero = root?.querySelector('[data-testid="gallery-hero"]') || root;
          const pickSet = (set) => {
            const parts = String(set||'').split(',').map(s=>s.trim()).filter(Boolean);
            let best = null, bestW = -1;
            for (const p of parts) {
              const m = p.match(/^(\S+)\s+(\d+)w$/);
              if (!m) continue;
              const u = m[1]; const w = parseInt(m[2], 10) || 0;
              if (w > bestW) { bestW = w; best = u; }
            }
            return best;
          };
          let u = pickSet(hero?.querySelector('picture source')?.getAttribute('srcset') || hero?.querySelector('picture source')?.getAttribute('data-srcset'));
          if (!u) u = pickSet(hero?.querySelector('img')?.getAttribute('srcset') || hero?.querySelector('img')?.getAttribute('data-srcset'));
          if (!u) u = hero?.querySelector('img')?.getAttribute('src') || hero?.querySelector('img')?.getAttribute('data-src');

          if (!u) {
            const ns = hero?.querySelector('noscript');
            const html = ns?.innerHTML || '';
            const m1 = html.match(/(?:srcset|data-srcset)=["']([\s\S]*?)["']/i);
            if (m1) u = pickSet(m1[1]);
            if (!u) {
              const m2 = html.match(/(?:src|data-src)=["']([^"']+)["']/i);
              if (m2) u = m2[1];
            }
          }
          return u || null;
        }, dialogSel).catch(()=>null);

        if (u) {
          const nextIdx = [...byIdx.keys()].length ? Math.max(...byIdx.keys()) + 1 : 0;
          if (!byIdx.has(nextIdx)) byIdx.set(nextIdx, u);
        }
      };

      for (let i = 0; i < 30; i++) {
        await grabHero();
        if (byIdx.size >= limit) break;
        const moved = await page.keyboard.press('ArrowRight').then(()=>true).catch(()=>false);
        await page.waitForTimeout(170);
        if (!moved) break;
      }
      await page.keyboard.press('Escape').catch(()=>{});
      if (debug) console.log(`[shots][${kind}] after-dialog count=${byIdx.size}`);
    };

    try {
      await page.goto(urlFor(plat), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
      await page.waitForSelector(anyGridSel, { state: 'attached', timeout: 15000 }).catch(()=>{});

      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(200);

      await dbg('after-wait');
      await grabOrdered();

      await pageByButtons();
      await dbg('after-buttons');

      await scrollShelfToEnd();
      await dbg('after-scroll');

      if (byIdx.size === 0) {
        await sweepDialog();
      }
    } catch (e) {
      console.log(`[shots][${kind}] error`, String(e && e.message || e));
    } finally {
      await browser.close().catch(()=>{});
    }

    // порядок, фильтр и апскейп размеров
    const dedup = new Set();
    const out = [];
    const ordered = [...byIdx.entries()].sort((a,b)=>a[0]-b[0]).map(([,u])=>u);

    for (const raw of ordered) {
      if (!isLikelyShot(raw)) continue;
      const key = normalizeBase(raw);
      if (dedup.has(key)) continue;
      dedup.add(key);
      out.push(upsizeForKind(raw, kind));
    }
    return out.slice(0, limit);
  }

  // фолбек через iTunes Lookup, если совсем пусто
  async function fallbackLookup(kind) {
    try {
      const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(cc)}&entity=software`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      const app = j?.results?.[0] || {};
      const list = kind === 'ipad' ? (app.ipadScreenshotUrls || []) : (app.screenshotUrls || []);
      return list.map(u => u.replace(/\/\d+x\d+bb\.(?:jpg|png|jpeg)/i, kind === 'ipad' ? '/1286x1714bb.webp' : '/600x1300bb.webp'));
    } catch { return []; }
  }

  const wantIphone = device === 'iphone' || device === 'all';
  const wantIpad   = device === 'ipad'   || device === 'all';

  if (wantIphone) {
    result.iphone = await collectFor('iphone');
    if (result.iphone.length === 0) result.iphone = await fallbackLookup('iphone');
  }
  if (wantIpad) {
    result.ipad = await collectFor('ipad');
    if (result.ipad.length === 0) result.ipad = await fallbackLookup('ipad');
  }

  result.total.iphone = result.iphone.length;
  result.total.ipad   = result.ipad.length;

  if (debug) {
    console.log(`[shots] return iphone=${result.total.iphone} ipad=${result.total.ipad}`);
  }
  res.json(result);
});







// === App Store: subscription icons ==========================================
// GET /apple/subicons?id=1658514439&cc=us&lang=en&limit=12
app.get('/apple/subicons', async (req, res) => {
  const id    = String(req.query.id || '').match(/\d{6,}/)?.[0];
  const cc    = String(req.query.cc || 'us').toLowerCase();
  const lang  = String(req.query.lang || 'en').toLowerCase();
  const limit = Math.max(1, Number(req.query.limit || 30));
  if (!id) return res.status(400).json({ error: 'pass ?id=<numeric app id>' });

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const url  = `https://apps.apple.com/${cc}/app/id${id}?l=${encodeURIComponent(lang)}`;

  const result = { id, cc, lang, urls: [], total: 0 };

  // нормализация и дедуп
  const normalize = (u) => String(u||'')
    .replace(/&amp;/g,'&')
    .replace(/\/(?:\d+x\d+bb(?:-\d+)?|\d+x0w)\.(?:png|jpe?g|webp)(?:\?.*)?$/i,'');

  const pickBestFromSrcset = (set) => {
    const parts = String(set||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!parts.length) return '';
    let best = '', wbest = 0;
    const urls = [];
    for (const p of parts) {
      const u = p.split(/\s+/)[0];
      urls.push(u);
      const m = /(\d+)w/i.exec(p) || /\/(\d+)x\d+bb/i.exec(u) || /\/(\d+)x0w/i.exec(u);
      const w = m ? parseInt(m[1],10) : 0;
      if (w > wbest) { wbest = w; best = u; }
    }
    if (best && /\.webp(?:\?|$)/i.test(best)) {
      const jpg = urls.find(u => /\.jpe?g(?:\?|$)/i.test(u));
      if (jpg) best = jpg;
    }
    return best;
  };

  async function collectSubIcons() {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: { 'Accept-Language': `${lang}-${cc.toUpperCase()},${lang};q=0.9,en-US;q=0.8,en;q=0.7` },
      viewport: { width: 1440, height: 1400 }
    });
    const page = await ctx.newPage();

    // полка подписок
    const secSel  = '#subscriptions';
    const gridSel = '#subscriptions ul[class*="shelf-grid__list--grid-type-InAppPurchaseLockup"], ul[class*="shelf-grid__list--grid-type-InAppPurchaseLockup"]';
    const rightArrowSel = '#subscriptions button.shelf-grid-nav__arrow--right';

    // копим строго по data-index
    const byIdx = new Map();

    const grabFromGrid = async () => {
      const items = await page.evaluate(({ gridSel }) => {
        const root = document.querySelector(gridSel);
        if (!root) return [];
        const out = [];
        const lis = Array.from(root.querySelectorAll('li'));
        for (const li of lis) {
          const idxAttr = li.getAttribute('data-index');
          const idx = idxAttr && /^\d+$/.test(idxAttr) ? Number(idxAttr) : out.length;

          const pic = li.querySelector('picture');
          const srcsetJpg = pic?.querySelector('source[type="image/jpeg"]')?.getAttribute('srcset')
                         || pic?.querySelector('source')?.getAttribute('srcset') || '';
          let set = srcsetJpg;

          if (!set) {
            const img = li.querySelector('img');
            set = img?.getAttribute('srcset') || img?.getAttribute('data-srcset') || img?.getAttribute('src') || '';
          }
          out.push({ idx, set });
        }
        return out;
      }, { gridSel });

      const picked = [];
      for (const it of items) {
        const best = pickBestFromSrcset(it.set);
        if (best && !byIdx.has(it.idx)) {
          byIdx.set(it.idx, best);
          picked.push(best);
        }
      }
      return picked.length;
    };

    const scrollShelfToEnd = async () => {
      for (let i = 0; i < 60; i++) {
        const atEnd = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true;
          const before = el.scrollLeft;
          el.scrollBy({ left: el.clientWidth, behavior: 'instant' });
          const after = el.scrollLeft;
          return Math.abs(after - before) < 5 || (after + el.clientWidth >= el.scrollWidth - 2);
        }, gridSel);
        await page.waitForTimeout(120);
        await grabFromGrid();
        if (byIdx.size >= limit || atEnd) break;
      }
    };

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector(secSel, { timeout: 15000 }).catch(()=>{});
      await page.evaluate((sel)=>document.querySelector(sel)?.scrollIntoView({block:'center'}), secSel);
      await page.waitForSelector(gridSel, { timeout: 15000 });

      await grabFromGrid();  // первый экран

      // жмём стрелку если есть
      for (let i = 0; i < 40 && byIdx.size < limit; i++) {
        const clicked = await page.$eval(rightArrowSel, b => { if (!b || b.disabled) return false; b.click(); return true; }).catch(()=>false);
        await page.waitForTimeout(150);
        await grabFromGrid();
        if (!clicked) break;
      }

      // на всякий случай докрутим скроллом
      if (byIdx.size < limit) await scrollShelfToEnd();
    } catch (_) {
      // вернём то что успели
    } finally {
      await browser.close().catch(()=>{});
    }

    // сортировка и дедуп
    const ordered = [...byIdx.entries()].sort((a,b)=>a[0]-b[0]).map(([,u])=>u);
    const seen = new Set();
    const clean = [];
    for (const u of ordered) {
      const k = normalize(u);
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(u);
      if (clean.length >= limit) break;
    }
    return clean;
  }

  try {
    const urls = await collectSubIcons();
    result.urls = urls;
    result.total = urls.length;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

