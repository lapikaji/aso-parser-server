// server.js
// package.json: { "type": "module", "scripts": { "start": "node server.js" } }

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const APPLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const GPLAY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

let sharedBrowserPromise = null;

async function getSharedBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
  }
  return sharedBrowserPromise;
}

let heavyQueue = Promise.resolve();

function runHeavy(task) {
  const next = heavyQueue.then(task, task);
  heavyQueue = next.catch(() => {});
  return next;
}

process.on("SIGTERM", async () => {
  try {
    const browser = await sharedBrowserPromise;
    await browser?.close();
  } catch {}
  process.exit(0);
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "aso-parser-server" });
});

// === Google Play About endpoint ============================================
// GET /gplay/about?appId=com.spotify.music&gl=US&hl=en[&debug=1]
app.get("/gplay/about", async (req, res) => {
  const appId = String(req.query.appId || "").trim();
  const gl = String(req.query.gl || "US");
  const hl = String(req.query.hl || "en");
  const debug = String(req.query.debug || "") === "1";

  if (!appId) {
    res.status(400).json({ error: "appId is required" });
    return;
  }

  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&gl=${gl}&hl=${hl}`;

  let ctx, page;

  try {
    const browser = await getSharedBrowser();
    ctx = await browser.newContext({
      userAgent: GPLAY_UA,
      viewport: { width: 1280, height: 900 },
    });

    page = await ctx.newPage();

    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (["image", "media", "font"].includes(t)) return route.abort();
      route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(150);
    }

    const aboutBtn = page.getByRole("button", { name: /about this app/i });
    if (await aboutBtn.count()) {
      await aboutBtn.first().click({ timeout: 20000 }).catch(() => {});
    } else {
      await page.locator("text=/About this app/i").first().click({ timeout: 20000 }).catch(() => {});
    }

    const dialog = page.getByRole("dialog");
    if (await dialog.count()) {
      for (let i = 0; i < 6; i++) {
        await dialog.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
        await page.waitForTimeout(150);
      }
    }

    const result = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]') || document;

      const LABELS = [
        { field: "version", texts: ["Current version", "Version"] },
        { field: "updatedOn", texts: ["Updated on", "Updated"] },
        { field: "requiresAndroid", texts: ["Requires Android"] },
        { field: "downloads", texts: ["Downloads"] },
        { field: "iapRange", texts: ["In-app purchases"] },
        { field: "contentRating", texts: ["Content rating"] },
        { field: "releasedOn", texts: ["Released on"] },
        { field: "offeredBy", texts: ["Offered by"] },
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

        let sib = labelEl.nextElementSibling;
        for (let i = 0; i < 6 && sib; i++, sib = sib?.nextElementSibling) {
          const txt = (sib?.textContent || "").trim();
          if (txt) return txt;
        }

        let par = labelEl.parentElement;
        for (let i = 0; i < 3 && par; i++, par = par?.parentElement) {
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
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    try { await page?.close(); } catch {}
    try { await ctx?.close(); } catch {}
  }
});

// === iOS screenshots endpoint ============================================
// GET /apple/shots?id=1658514439&cc=us&lang=en&device=iphone&limit=12[&debug=1]
// device: iphone | ipad | all
app.get("/apple/shots", async (req, res) => {
  try {
    await runHeavy(async () => {
      const id = String(req.query.id || "").match(/\d{6,}/)?.[0];
      const cc = String(req.query.cc || "us").toLowerCase();
      const lang = String(req.query.lang || "en").toLowerCase();
      const device = String(req.query.device || "iphone").toLowerCase();
      const limit = Math.max(1, Number(req.query.limit || 20));
      const debug = String(req.query.debug || "") === "1";

      if (!id) return res.status(400).json({ error: "pass ?id=<numeric app id>" });

      const urlFor = (plat) =>
        `https://apps.apple.com/${cc}/app/id${id}?platform=${plat}&l=${encodeURIComponent(lang)}`;

      const result = {
        id,
        cc,
        lang,
        device,
        iphone: [],
        ipad: [],
        total: { iphone: 0, ipad: 0 },
      };

      const normalizeBase = (u) =>
        String(u || "")
          .replace(/&amp;/g, "&")
          .replace(/\/(?:\d+(?:x\d+)?(?:bb|sr)?(?:-\d+)?|\d+x0w)\.(?:png|jpe?g|webp)(?:\?.*)?$/i, "");

      const isLikelyShot = (u) => {
        if (!/^https?:\/\//i.test(u)) return false;
        if (!/mzstatic\.com\/image\/thumb\/(?:Purple|PurpleSource)/i.test(u)) return false;
        if (/(AppIcon|Artwork|MarketingArtwork|poster|videoposter|posterframe|previewimage|preview|trailer|mask|placeholder|gradient|Feature)/i.test(u)) return false;
        return true;
      };

      const upsizeForKind = (u, kind) => {
        const target = kind === "ipad" ? "1286x1714bb.webp" : "600x1300bb.webp";
        if (/\d+x\d+bb(?:-\d+)?\.(?:webp|jpg|jpeg|png)/i.test(u)) {
          return u.replace(/\/\d+x\d+bb(?:-\d+)?\.(webp|jpg|jpeg|png)$/i, `/${target}`);
        }
        if (/\/\d+x0w\.(?:webp|jpg|jpeg|png)$/i.test(u)) {
          return u.replace(/\/\d+x0w\.(webp|jpg|jpeg|png)$/i, `/${target}`);
        }
        return u.replace(/\/(?:[^/]+)$/i, () => `/${target}`);
      };

      async function collectFor(plat) {
        const kind = plat === "ipad" ? "ipad" : "iphone";
        const browser = await getSharedBrowser();
        const ctx = await browser.newContext({
          userAgent: APPLE_UA,
          extraHTTPHeaders: {
            "Accept-Language": `${lang}-${cc.toUpperCase()},${lang};q=0.9,en-US;q=0.8,en;q=0.7`,
          },
          viewport: { width: 1280, height: 1000 },
        });
        const page = await ctx.newPage();
        const byIdx = new Map();

        await page.route("**/*", (route) => {
          const t = route.request().resourceType();
          if (["media", "font"].includes(t)) return route.abort();
          route.continue();
        });

        const gridTokens =
          kind === "ipad"
            ? ["shelf-grid__list--grid-type-ScreenshotPad", "shelf-grid__list--grid-type-ScreenshotLarge"]
            : ["shelf-grid__list--grid-type-ScreenshotPhone"];

        const anyGridSel = 'ul[class*="shelf-grid__list--grid-type-"]';
        const primarySel = gridTokens.map((t) => `ul.${t}`).join(", ");
        const dialogSel = 'dialog[data-test-id="dialog"]';

        const grabOrdered = async () => {
          const items = await page.evaluate(({ gridTokens }) => {
            const roots = Array.from(document.querySelectorAll('ul[class*="shelf-grid__list--grid-type-"]')).filter((ul) =>
              gridTokens.some((t) => ul.className.includes(t))
            );

            const pickSet = (set) => {
              const parts = String(set || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              let best = null;
              let bestW = -1;
              for (const p of parts) {
                const m = p.match(/^(\S+)\s+(\d+)w$/);
                if (!m) continue;
                const u = m[1];
                const w = parseInt(m[2], 10) || 0;
                if (w > bestW) {
                  bestW = w;
                  best = u;
                }
              }
              return best;
            };

            const out = [];
            let seq = 0;

            for (const root of roots) {
              const lis = Array.from(root.querySelectorAll("li.shelf-grid__list-item"));
              for (const li of lis) {
                const idxAttr = li.getAttribute("data-index");
                const idx = /^\d+$/.test(idxAttr || "") ? Number(idxAttr) : seq++;
                let url = null;

                const pic = li.querySelector("picture");
                url = pickSet(
                  pic?.querySelector("source")?.getAttribute("srcset") ||
                  pic?.querySelector("source")?.getAttribute("data-srcset")
                );
                if (!url) url = pickSet(li.querySelector("img")?.getAttribute("srcset") || li.querySelector("img")?.getAttribute("data-srcset"));
                if (!url) url = li.querySelector("img")?.getAttribute("src") || li.querySelector("img")?.getAttribute("data-src");

                if (!url) {
                  const ns = li.querySelector("noscript");
                  const html = ns?.innerHTML || "";
                  const m1 = html.match(/(?:srcset|data-srcset)=["']([\s\S]*?)["']/i);
                  if (m1) url = pickSet(m1[1]);
                  if (!url) {
                    const m2 = html.match(/(?:src|data-src)=["']([^"']+)["']/i);
                    if (m2) url = m2[1];
                  }
                }

                if (!url) {
                  const html = li.innerHTML;
                  const all = html.match(/https?:\/\/[^"'()\s]+mzstatic\.com\/image\/thumb\/[^"'()\s]+/ig) || [];
                  if (all.length) url = all[all.length - 1];
                }

                if (url) out.push({ idx, url });
              }
            }

            return out;
          }, { gridTokens });

          for (const { idx, url } of items) {
            if (!byIdx.has(idx)) byIdx.set(idx, url);
          }
        };

        const pageByButtons = async () => {
          for (let i = 0; i < 50; i++) {
            const clicked = await page
              .evaluate((primarySel) => {
                const ul = document.querySelector(primarySel);
                if (!ul) return false;
                const wrap = ul.closest('[data-testid="shelf-component"]') || ul.parentElement;
                const btn =
                  wrap?.querySelector("button.shelf-grid-nav__arrow--right") ||
                  wrap?.querySelector('button[aria-label="Next Page"]') ||
                  wrap?.querySelector('button[aria-label^="Next"]');
                if (!btn || btn.disabled) return false;
                btn.click();
                return true;
              }, primarySel)
              .catch(() => false);
            await page.waitForTimeout(220);
            await grabOrdered();
            if (!clicked) break;
            if (byIdx.size >= limit) break;
          }
        };

        const scrollShelfToEnd = async () => {
          for (let i = 0; i < 80; i++) {
            const atEnd = await page
              .evaluate((primarySel) => {
                const ul = document.querySelector(primarySel);
                if (!ul) return true;
                const before = ul.scrollLeft;
                ul.scrollBy({ left: ul.clientWidth, behavior: "instant" });
                const after = ul.scrollLeft;
                return Math.abs(after - before) < 5 || after + ul.clientWidth >= ul.scrollWidth - 2;
              }, primarySel)
              .catch(() => true);
            await page.waitForTimeout(160);
            await grabOrdered();
            if (byIdx.size >= limit || atEnd) break;
          }
        };

        const sweepDialog = async () => {
          const first = (await page.$(`${primarySel} li[aria-hidden="false"]`)) || (await page.$(`${primarySel} li`));
          if (!first) return;
          await first.click().catch(() => {});
          await page.waitForSelector(dialogSel, { state: "visible", timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(180);

          const grabHero = async () => {
            const u = await page
              .evaluate((dialogSel) => {
                const root = document.querySelector(dialogSel);
                const hero = root?.querySelector('[data-testid="gallery-hero"]') || root;
                const pickSet = (set) => {
                  const parts = String(set || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  let best = null;
                  let bestW = -1;
                  for (const p of parts) {
                    const m = p.match(/^(\S+)\s+(\d+)w$/);
                    if (!m) continue;
                    const u = m[1];
                    const w = parseInt(m[2], 10) || 0;
                    if (w > bestW) {
                      bestW = w;
                      best = u;
                    }
                  }
                  return best;
                };

                let u = pickSet(hero?.querySelector("picture source")?.getAttribute("srcset") || hero?.querySelector("picture source")?.getAttribute("data-srcset"));
                if (!u) u = pickSet(hero?.querySelector("img")?.getAttribute("srcset") || hero?.querySelector("img")?.getAttribute("data-srcset"));
                if (!u) u = hero?.querySelector("img")?.getAttribute("src") || hero?.querySelector("img")?.getAttribute("data-src");

                if (!u) {
                  const ns = hero?.querySelector("noscript");
                  const html = ns?.innerHTML || "";
                  const m1 = html.match(/(?:srcset|data-srcset)=["']([\s\S]*?)["']/i);
                  if (m1) u = pickSet(m1[1]);
                  if (!u) {
                    const m2 = html.match(/(?:src|data-src)=["']([^"']+)["']/i);
                    if (m2) u = m2[1];
                  }
                }

                return u || null;
              }, dialogSel)
              .catch(() => null);

            if (u) {
              const nextIdx = byIdx.size ? Math.max(...byIdx.keys()) + 1 : 0;
              if (!byIdx.has(nextIdx)) byIdx.set(nextIdx, u);
            }
          };

          for (let i = 0; i < 30; i++) {
            await grabHero();
            if (byIdx.size >= limit) break;
            const moved = await page.keyboard.press("ArrowRight").then(() => true).catch(() => false);
            await page.waitForTimeout(170);
            if (!moved) break;
          }
          await page.keyboard.press("Escape").catch(() => {});
          if (debug) console.log(`[shots][${kind}] after-dialog count=${byIdx.size}`);
        };

        try {
          await page.goto(urlFor(plat), { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await page.waitForSelector(anyGridSel, { state: "attached", timeout: 15000 }).catch(() => {});

          await page.waitForTimeout(300);
          await page.evaluate(() => window.scrollBy(0, 600));
          await page.waitForTimeout(200);

          await grabOrdered();

          await pageByButtons();

          await scrollShelfToEnd();

          if (byIdx.size === 0) await sweepDialog();
        } catch (e) {
          console.log(`[shots][${kind}] error`, String((e && e.message) || e));
        } finally {
          await page.close().catch(() => {});
          await ctx.close().catch(() => {});
        }

        const dedup = new Set();
        const out = [];
        const ordered = [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);

        for (const raw of ordered) {
          if (!isLikelyShot(raw)) continue;
          const key = normalizeBase(raw);
          if (dedup.has(key)) continue;
          dedup.add(key);
          out.push(upsizeForKind(raw, kind));
        }

        return out.slice(0, limit);
      }

      async function fallbackLookup(kind) {
        try {
          const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(cc)}&entity=software`;
          const r = await fetch(url);
          if (!r.ok) return [];
          const j = await r.json();
          const app = j?.results?.[0] || {};
          const list = kind === "ipad" ? app.ipadScreenshotUrls || [] : app.screenshotUrls || [];
          return list.map((u) =>
            u.replace(/\/\d+x\d+bb\.(?:jpg|png|jpeg)/i, kind === "ipad" ? "/1286x1714bb.webp" : "/600x1300bb.webp")
          );
        } catch {
          return [];
        }
      }

      const wantIphone = device === "iphone" || device === "all";
      const wantIpad = device === "ipad" || device === "all";

      if (wantIphone) {
        result.iphone = await collectFor("iphone");
        if (result.iphone.length === 0) result.iphone = await fallbackLookup("iphone");
      }

      if (wantIpad) {
        result.ipad = await collectFor("ipad");
        if (result.ipad.length === 0) result.ipad = await fallbackLookup("ipad");
      }

      result.total.iphone = result.iphone.length;
      result.total.ipad = result.ipad.length;

      if (debug) console.log(`[shots] ${id} ${device} iphone=${result.total.iphone} ipad=${result.total.ipad}`);
      res.json(result);
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

// === App Store: subscription icons ==========================================
// GET /apple/subicons?id=1658514439&cc=us&lang=en&limit=12
app.get("/apple/subicons", async (req, res) => {
  try {
    await runHeavy(async () => {
      const id = String(req.query.id || "").match(/\d{6,}/)?.[0];
      const cc = String(req.query.cc || "us").toLowerCase();
      const lang = String(req.query.lang || "en").toLowerCase();
      const limit = Math.max(1, Number(req.query.limit || 30));

      if (!id) return res.status(400).json({ error: "pass ?id=<numeric app id>" });

      const url = `https://apps.apple.com/${cc}/app/id${id}?l=${encodeURIComponent(lang)}`;
      const result = { id, cc, lang, urls: [], total: 0 };

      const normalize = (u) =>
        String(u || "")
          .replace(/&amp;/g, "&")
          .replace(/\/(?:\d+x\d+bb(?:-\d+)?|\d+x0w)\.(?:png|jpe?g|webp)(?:\?.*)?$/i, "");

      const pickBestFromSrcset = (set) => {
        const parts = String(set || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!parts.length) return "";
        let best = "";
        let wbest = 0;
        const urls = [];
        for (const p of parts) {
          const u = p.split(/\s+/)[0];
          urls.push(u);
          const m = /(\d+)w/i.exec(p) || /\/(\d+)x\d+bb/i.exec(u) || /\/(\d+)x0w/i.exec(u);
          const w = m ? parseInt(m[1], 10) : 0;
          if (w > wbest) {
            wbest = w;
            best = u;
          }
        }
        if (best && /\.webp(?:\?|$)/i.test(best)) {
          const jpg = urls.find((u) => /\.jpe?g(?:\?|$)/i.test(u));
          if (jpg) best = jpg;
        }
        return best;
      };

      async function collectSubIcons() {
        const browser = await getSharedBrowser();
        const ctx = await browser.newContext({
          userAgent: APPLE_UA,
          extraHTTPHeaders: {
            "Accept-Language": `${lang}-${cc.toUpperCase()},${lang};q=0.9,en-US;q=0.8,en;q=0.7`,
          },
          viewport: { width: 1280, height: 1000 },
        });
        const page = await ctx.newPage();

        await page.route("**/*", (route) => {
          const t = route.request().resourceType();
          if (["media", "font"].includes(t)) return route.abort();
          route.continue();
        });

        const secSel = "#subscriptions";
        const gridSel = '#subscriptions ul[class*="shelf-grid__list--grid-type-InAppPurchaseLockup"], ul[class*="shelf-grid__list--grid-type-InAppPurchaseLockup"]';
        const rightArrowSel = "#subscriptions button.shelf-grid-nav__arrow--right";
        const byIdx = new Map();

        const grabFromGrid = async () => {
          const items = await page.evaluate(({ gridSel }) => {
            const root = document.querySelector(gridSel);
            if (!root) return [];
            const out = [];
            const lis = Array.from(root.querySelectorAll("li"));
            for (const li of lis) {
              const idxAttr = li.getAttribute("data-index");
              const idx = idxAttr && /^\d+$/.test(idxAttr) ? Number(idxAttr) : out.length;

              const pic = li.querySelector("picture");
              const srcsetJpg =
                pic?.querySelector('source[type="image/jpeg"]')?.getAttribute("srcset") ||
                pic?.querySelector("source")?.getAttribute("srcset") ||
                "";
              let set = srcsetJpg;

              if (!set) {
                const img = li.querySelector("img");
                set = img?.getAttribute("srcset") || img?.getAttribute("data-srcset") || img?.getAttribute("src") || "";
              }
              out.push({ idx, set });
            }
            return out;
          }, { gridSel });

          let picked = 0;
          for (const it of items) {
            const best = pickBestFromSrcset(it.set);
            if (best && !byIdx.has(it.idx)) {
              byIdx.set(it.idx, best);
              picked++;
            }
          }
          return picked;
        };

        const scrollShelfToEnd = async () => {
          for (let i = 0; i < 60; i++) {
            const atEnd = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return true;
              const before = el.scrollLeft;
              el.scrollBy({ left: el.clientWidth, behavior: "instant" });
              const after = el.scrollLeft;
              return Math.abs(after - before) < 5 || after + el.clientWidth >= el.scrollWidth - 2;
            }, gridSel);
            await page.waitForTimeout(120);
            await grabFromGrid();
            if (byIdx.size >= limit || atEnd) break;
          }
        };

        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForSelector(secSel, { timeout: 15000 }).catch(() => {});
          await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), secSel).catch(() => {});
          await page.waitForSelector(gridSel, { timeout: 15000 }).catch(() => {});

          await grabFromGrid();

          for (let i = 0; i < 40 && byIdx.size < limit; i++) {
            const clicked = await page
              .$eval(rightArrowSel, (b) => {
                if (!b || b.disabled) return false;
                b.click();
                return true;
              })
              .catch(() => false);
            await page.waitForTimeout(150);
            await grabFromGrid();
            if (!clicked) break;
          }

          if (byIdx.size < limit) await scrollShelfToEnd();
        } catch {}
        finally {
          await page.close().catch(() => {});
          await ctx.close().catch(() => {});
        }

        const ordered = [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([, u]) => u);
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

      const urls = await collectSubIcons();
      result.urls = urls;
      result.total = urls.length;
      res.json(result);
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log("aso parser service on", PORT));
