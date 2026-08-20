#!/usr/bin/env -S npx tsx
/**
 * Generates the furryfriend.cc landing page.
 *
 * The shop section is built from the live Shopify catalog rather than
 * hand-written, so prices and links cannot drift from the store. Re-run after
 * a catalog sync and redeploy.
 *
 *   npx tsx scripts/manual/build-furryfriend-site.ts --out /tmp/furryfriend/index.html
 *
 * Copy rules this page follows, deliberately:
 *   - No invented customers. An earlier draft carried named "case studies"
 *     (Alex and Barnaby, Luna, Buster) that were not real people, alongside a
 *     "join thousands of pet parents" claim against a user base of 20.
 *   - Anything not shipped is labelled as in development, in the copy itself
 *     and not only in a badge. Futures and the health tools are real projects
 *     and are described as underway, never as available.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getPool, closePool } from "../../db";

const outFlag = process.argv.indexOf("--out");
const outPath = outFlag > 0 ? process.argv[outFlag + 1] : "furryfriend/index.html";

const STORE = "https://pawprints-by-pawsome3d.myshopify.com";
const APP = "https://pawsome3d.com";

interface Product {
  handle: string; title: string; min_price: string; currency_code: string;
  product_url: string; featured_image_url: string; pawprint_personalizable: number;
}

const esc = (s: string) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function productCard(p: Product): string {
  const personal = p.pawprint_personalizable
    ? `<span class="tag tag-personal">Add your pet</span>`
    : "";
  return `
        <a class="card product" href="${esc(p.product_url)}" target="_blank" rel="noopener">
          <div class="shot"><img src="${esc(p.featured_image_url)}" alt="${esc(p.title)}" loading="lazy" width="400" height="400"></div>
          <div class="card-body">
            ${personal}
            <h3>${esc(p.title)}</h3>
            <p class="price">$${esc(p.min_price)} ${esc(p.currency_code)}</p>
          </div>
        </a>`;
}

function page(products: Product[], personalizableCount: number, lowest: string): string {
  // Personalizable products lead: they are the only ones that connect the
  // studio to the store, which is the whole reason this site exists.
  const featured = [
    ...products.filter((p) => p.pawprint_personalizable),
    ...products.filter((p) => !p.pawprint_personalizable),
  ].slice(0, 8);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FurryFriend — Pet Keepsakes, 3D Pet Avatars &amp; What We're Building Next</title>
<meta name="description" content="Turn a pet photo into custom art, printed keepsakes and a 3D avatar. See the shop, learn how Pawsome3D works, and follow Futures — the AR game we're building on the same pet models.">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://furryfriend.cc/">
<meta property="og:title" content="FurryFriend — Pet Keepsakes &amp; 3D Pet Avatars">
<meta property="og:description" content="Custom pet keepsakes from a single photo, a free 3D pet avatar studio, and an AR game in development built on the same models.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://furryfriend.cc/">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebSite","name":"FurryFriend","url":"https://furryfriend.cc/",
"description":"Pet keepsakes, 3D pet avatars, and the technology behind them.",
"publisher":{"@type":"Organization","name":"FurryFriend","url":"https://furryfriend.cc/"}}
</script>
<style>
  :root{
    --ink:#1f1a17; --muted:#6b615a; --line:#e7e0d9; --bg:#fffdfb; --panel:#fff;
    --accent:#c2410c; --accent-soft:#fff2ea; --radius:16px;
  }
  @media (prefers-color-scheme: dark){
    :root{ --ink:#f2ede9; --muted:#a99f97; --line:#332c27; --bg:#141110; --panel:#1c1817;
           --accent:#fb923c; --accent-soft:#2a1b12; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  a{color:inherit}
  header{border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:10}
  .bar{display:flex;align-items:center;gap:18px;padding:14px 0;flex-wrap:wrap}
  .brand{font-weight:800;font-size:18px;text-decoration:none;margin-right:auto}
  nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:14px}
  nav a:hover{color:var(--accent)}
  nav{display:flex;gap:16px;flex-wrap:wrap}
  .btn{display:inline-block;padding:11px 18px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-ghost{border:1px solid var(--line);color:var(--ink)}
  h1{font-size:clamp(30px,5vw,46px);line-height:1.12;letter-spacing:-.02em;margin:0 0 14px}
  h2{font-size:clamp(22px,3vw,30px);line-height:1.2;letter-spacing:-.01em;margin:0 0 10px}
  h3{font-size:17px;margin:0 0 6px;line-height:1.3}
  p{margin:0 0 14px}
  .lede{font-size:19px;color:var(--muted);max-width:62ch}
  section{padding:56px 0;border-bottom:1px solid var(--line)}
  .eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
  .sub{color:var(--muted);max-width:66ch;margin:0 0 26px}
  .grid{display:grid;gap:16px}
  .g2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .g4{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;
        text-decoration:none;display:block}
  .card-body{padding:16px}
  .product .shot{aspect-ratio:1;background:var(--accent-soft);overflow:hidden}
  .product img{width:100%;height:100%;object-fit:cover;display:block}
  .product:hover{border-color:var(--accent)}
  .price{font-weight:800;margin:6px 0 0}
  .tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
       padding:4px 9px;border-radius:999px;margin-bottom:8px}
  .tag-personal{background:var(--accent-soft);color:var(--accent)}
  .tag-dev{background:var(--accent-soft);color:var(--accent);border:1px dashed var(--accent)}
  .feature{padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
  .feature .ico{font-size:26px;line-height:1;margin-bottom:10px}
  .note{background:var(--accent-soft);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
  .cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
  details{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--panel);margin-bottom:10px}
  summary{font-weight:700;cursor:pointer}
  details p{margin:10px 0 0;color:var(--muted)}
  footer{padding:34px 0;color:var(--muted);font-size:14px}
  .small{font-size:13px;color:var(--muted)}
</style>
</head>
<body>

<header>
  <div class="wrap bar">
    <a class="brand" href="/">🐾 FurryFriend</a>
    <nav>
      <a href="#shop">Shop</a>
      <a href="#make">What you can make</a>
      <a href="#futures">Futures</a>
      <a href="#roadmap">Roadmap</a>
      <a href="#faq">FAQ</a>
    </nav>
    <a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">Visit the shop</a>
  </div>
</header>

<section>
  <div class="wrap">
    <p class="eyebrow">We're just getting started</p>
    <h1>Your pet, turned into something you can keep.</h1>
    <p class="lede">
      FurryFriend is the front door to two things: a shop of custom pet keepsakes you can
      order today, and <strong>Pawsome3D</strong>, a free studio that turns one photo of your
      pet into art, video, and a 3D avatar. We're a small, new operation — and we'd rather
      tell you exactly what's ready and what we're still building than pretend otherwise.
    </p>
    <div class="cta-row">
      <a class="btn btn-primary" href="#shop">Shop keepsakes from $${esc(lowest)}</a>
      <a class="btn btn-ghost" href="${APP}" target="_blank" rel="noopener">Try the studio free ↗</a>
    </div>
  </div>
</section>

<section id="shop">
  <div class="wrap">
    <p class="eyebrow">Shop</p>
    <h2>Keepsakes you can order right now</h2>
    <p class="sub">
      Mugs, canvas, blankets, feeding mats, playing cards and more. ${personalizableCount} of these
      can be personalised with your own pet's portrait — make the art in the studio, then put it
      on the thing you actually use.
    </p>
    <div class="grid g4">${featured.map(productCard).join("")}
    </div>
    <div class="cta-row">
      <a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">See the full shop ↗</a>
    </div>
  </div>
</section>

<section id="make">
  <div class="wrap">
    <p class="eyebrow">What you can make</p>
    <h2>One photo. Four different things.</h2>
    <p class="sub">
      Everything below works today on Pawsome3D, and starting is free. You upload a clear photo
      of your pet — facing the camera, decent light — and the studio does the rest.
    </p>
    <div class="grid g2">
      <div class="feature">
        <div class="ico">🎨</div>
        <h3>PawPrints — custom pet art</h3>
        <p class="small">
          Pick a theme and your pet is re-rendered into it: a Halloween scene, a Renaissance
          portrait, seasonal artwork. <strong>Use it for:</strong> a print for the wall, a gift,
          or the design that goes onto a mug or canvas in the shop above.
        </p>
      </div>
      <div class="feature">
        <div class="ico">✂️</div>
        <h3>Background removal</h3>
        <p class="small">
          Cut your pet cleanly out of a busy photo — fur edges and all — so they can sit on any
          background. <strong>Use it for:</strong> prepping a photo before making art, or getting
          a clean cutout for a product design.
        </p>
      </div>
      <div class="feature">
        <div class="ico">🎬</div>
        <h3>Video Studio</h3>
        <p class="small">
          Turn a still photo into a short cinematic clip with camera motion and lighting, built on
          image-to-video models. <strong>Use it for:</strong> a birthday or memorial reel, or
          something to post rather than another still.
        </p>
      </div>
      <div class="feature">
        <div class="ico">📐</div>
        <h3>3D avatar &amp; Fur Bin</h3>
        <p class="small">
          Generate a 3D model of your pet and keep every creation in your Fur Bin to download
          later. <strong>Use it for:</strong> viewing your pet in 3D, and — soon — playing as
          them. See Futures below.
        </p>
      </div>
    </div>
    <div class="cta-row">
      <a class="btn btn-primary" href="${APP}" target="_blank" rel="noopener">Start free on Pawsome3D ↗</a>
    </div>
  </div>
</section>

<section id="futures">
  <div class="wrap">
    <p class="eyebrow">In development</p>
    <h2>Futures — an AR game starring your actual pet</h2>
    <p class="sub">
      This is the part we're most excited about, and it is genuinely being built right now.
      <strong>Futures</strong> is an augmented-reality game that uses the very same 3D model
      Pawsome3D makes from your photo. Not a lookalike, not a preset character — your pet,
      as the playable character, dropped into the room you're standing in.
    </p>
    <div class="grid g2">
      <div class="feature">
        <div class="ico">🕹️</div>
        <h3>Your model, not a stand-in</h3>
        <p class="small">
          Because the game reads the same rigged GLB the studio produces, a pet you create today
          is a character you can play later. Making an avatar now is not wasted work.
        </p>
      </div>
      <div class="feature">
        <div class="ico">📱</div>
        <h3>In your actual room</h3>
        <p class="small">
          Built on the AR paths phones already support, so your pet appears at real scale on the
          floor in front of you rather than in a window on a screen.
        </p>
      </div>
    </div>
    <p class="note">
      <span class="tag tag-dev">Honest status</span><br>
      Futures is <strong>in active development and not playable yet</strong>. We don't have a
      release date, and we're not taking money for it. We're mentioning it because it's the
      reason the 3D side of the studio exists, and because anything you create now will carry
      forward into it.
    </p>
  </div>
</section>

<section id="roadmap">
  <div class="wrap">
    <p class="eyebrow">On the roadmap</p>
    <h2>Where we're heading next</h2>
    <p class="sub">
      Longer-term work we've started but haven't shipped. Listed here so you know the direction —
      not as things you can use today.
    </p>
    <div class="grid g2">
      <div class="feature">
        <span class="tag tag-dev">In development</span>
        <h3>Pet health scan</h3>
        <p class="small">
          Using the same photo-to-3D pipeline to help you track visible, physical changes over
          time — body condition, posture, how your pet is carrying themselves — from the pictures
          you already take.
        </p>
      </div>
      <div class="feature">
        <span class="tag tag-dev">In development</span>
        <h3>Ongoing monitoring</h3>
        <p class="small">
          Turning those scans into a timeline, so a slow change over months is something you can
          actually see rather than something you notice too late.
        </p>
      </div>
    </div>
    <p class="note">
      <strong>To be clear about this one:</strong> the health features are early, unreleased, and
      will never be a diagnosis. Nothing we build replaces a veterinarian. The goal is to help you
      notice a change worth asking a vet about — that's all, and we'd rather say so now than
      oversell it later.
    </p>
  </div>
</section>

<section id="faq">
  <div class="wrap">
    <p class="eyebrow">FAQ</p>
    <h2>Straight answers</h2>
    <details><summary>What does it cost to try?</summary>
      <p>Creating an account and starting in the studio is free. Keepsakes in the shop are priced
      individually, starting at $${esc(lowest)}.</p></details>
    <details><summary>What kind of photo works best?</summary>
      <p>One clear, well-lit photo with your pet facing the camera. Faces turned away, heavy motion
      blur, or very dark shots are what usually disappoint. You can always try another photo.</p></details>
    <details><summary>Can I put my pet's art on a product?</summary>
      <p>Yes — ${personalizableCount} products in the shop are personalisable. You make the artwork in
      the studio and it goes onto the item.</p></details>
    <details><summary>Can I play the AR game yet?</summary>
      <p>Not yet. Futures is in development with no release date. Your 3D models will carry over
      when it's ready.</p></details>
    <details><summary>Is the health scan available?</summary>
      <p>No — it's early and unreleased, and it is not a veterinary diagnostic. It's intended to help
      you spot changes worth raising with your vet.</p></details>
    <details><summary>Who is behind this?</summary>
      <p>A small independent team. We launched recently, we're building in the open, and we'd rather
      be honest about what's finished than inflate the numbers.</p></details>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Two ways in</h2>
    <p class="sub">Browse something to keep, or make something first — either is a fine place to start.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">Shop keepsakes ↗</a>
      <a class="btn btn-ghost" href="${APP}" target="_blank" rel="noopener">Create free on Pawsome3D ↗</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <p>© 2026 FurryFriend.cc — pet keepsakes and the studio behind them.
    <a href="${APP}" target="_blank" rel="noopener">Pawsome3D</a> ·
    <a href="${STORE}" target="_blank" rel="noopener">Shop</a></p>
    <p class="small">Futures and the health features described above are in development and not yet
    available. Nothing on this site is veterinary advice.</p>
  </div>
</footer>

</body>
</html>
`;
}

(async () => {
  const pool = getPool();
  const [rows]: any = await pool.query(
    `SELECT handle, title, min_price, currency_code, product_url, featured_image_url, pawprint_personalizable
       FROM shopify_store_products
      WHERE active = 1 AND available_for_sale = 1 AND featured_image_url IS NOT NULL
      ORDER BY CAST(min_price AS DECIMAL(10,2))`,
  );
  const products = rows as Product[];
  if (!products.length) throw new Error("No sellable products found — run the catalog sync first.");

  const personalizable = products.filter((p) => p.pawprint_personalizable).length;
  const html = page(products, personalizable, products[0].min_price);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`  ${products.length} sellable products, ${personalizable} personalizable, from $${products[0].min_price}`);
  await closePool();
})().catch((err) => { console.error(err?.message || err); process.exit(1); });
