#!/usr/bin/env -S npx tsx
/**
 * Generates the furryfriend.cc site: index, five articles, privacy and terms.
 *
 * The shop section is built from the live Shopify catalog rather than
 * hand-written, so prices and links cannot drift from the store. Re-run after
 * a catalog sync and redeploy.
 *
 *   npx tsx scripts/manual/build-furryfriend-site.ts --out /tmp/ffsite
 *
 * Copy rules this site follows, deliberately:
 *   - No invented customers. An earlier draft carried named "case studies"
 *     (Alex and Barnaby, Luna, Buster) that were not real people, alongside a
 *     "join thousands of pet parents" claim against a user base of 20.
 *   - Anything not shipped is labelled as in development in the copy itself,
 *     not only in a badge. Futures and the health tools are real projects and
 *     are described as underway, never as available.
 *   - Articles lead with something useful. A reader who takes the advice and
 *     never buys anything should still have been served.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getPool, closePool } from "../../db";

const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > 0 ? process.argv[outFlag + 1] : "ffsite";

const STORE = "https://pawprints-by-pawsome3d.myshopify.com";
const APP = "https://pawsome3d.com";
const SITE = "https://furryfriend.cc";

interface Product {
  handle: string; title: string; min_price: string; currency_code: string;
  product_url: string; featured_image_url: string; pawprint_personalizable: number;
}

const esc = (s: string) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const STYLE = `
  :root{--ink:#1f1a17;--muted:#6b615a;--line:#e7e0d9;--bg:#fffdfb;--panel:#fff;
        --accent:#c2410c;--accent-soft:#fff2ea;--radius:16px}
  @media (prefers-color-scheme:dark){:root{--ink:#f2ede9;--muted:#a99f97;--line:#332c27;--bg:#141110;
        --panel:#1c1817;--accent:#fb923c;--accent-soft:#2a1b12}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:0 20px}
  .narrow{max-width:720px}
  a{color:inherit}
  header{border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:10}
  .bar{display:flex;align-items:center;gap:18px;padding:14px 0;flex-wrap:wrap}
  .brand{font-weight:800;font-size:18px;text-decoration:none;margin-right:auto}
  nav{display:flex;gap:16px;flex-wrap:wrap}
  nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:14px}
  nav a:hover{color:var(--accent)}
  .btn{display:inline-block;padding:11px 18px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;border:0;cursor:pointer}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-ghost{border:1px solid var(--line);color:var(--ink);background:transparent}
  h1{font-size:clamp(30px,5vw,46px);line-height:1.12;letter-spacing:-.02em;margin:0 0 14px}
  h2{font-size:clamp(21px,3vw,29px);line-height:1.22;letter-spacing:-.01em;margin:34px 0 10px}
  h3{font-size:17px;margin:0 0 6px;line-height:1.35}
  p{margin:0 0 14px}
  ul{margin:0 0 16px;padding-left:20px}li{margin-bottom:7px}
  .lede{font-size:19px;color:var(--muted);max-width:62ch}
  section{padding:52px 0;border-bottom:1px solid var(--line)}
  .eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
  .sub{color:var(--muted);max-width:66ch;margin:0 0 24px}
  .grid{display:grid;gap:16px}
  .g2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .g3{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
  .g4{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;text-decoration:none;display:block}
  .card:hover{border-color:var(--accent)}
  .card-body{padding:15px}
  .shot{aspect-ratio:1;background:var(--accent-soft);overflow:hidden}
  .shot img{width:100%;height:100%;object-fit:cover;display:block}
  .price{font-weight:800;margin:6px 0 0}
  .tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;margin-bottom:8px}
  .tag-personal,.tag-cat{background:var(--accent-soft);color:var(--accent)}
  .tag-dev{background:var(--accent-soft);color:var(--accent);border:1px dashed var(--accent)}
  .feature{padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
  .ico{font-size:26px;line-height:1;margin-bottom:10px}
  .note{background:var(--accent-soft);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
  .cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
  details{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--panel);margin-bottom:10px}
  summary{font-weight:700;cursor:pointer}
  details p{margin:10px 0 0;color:var(--muted)}
  footer{padding:34px 0;color:var(--muted);font-size:14px}
  .small{font-size:13px;color:var(--muted)}
  figure{margin:0}
  .ba{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
  .ba img{width:100%;height:auto;border-radius:var(--radius);display:block;border:1px solid var(--line)}
  .ba figcaption{font-size:12px;color:var(--muted);margin-top:6px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .signup{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  .signup input{flex:1 1 240px;padding:12px 14px;border-radius:999px;border:1px solid var(--line);
                background:var(--panel);color:var(--ink);font-size:15px}
  article img.hero{width:100%;height:auto;border-radius:var(--radius);border:1px solid var(--line);margin-bottom:22px}
  /* Explicit width/height attributes are kept on every <img> to reserve layout
     space and avoid content shift while loading. Without height:auto the
     attribute wins over the fluid width and the picture stretches. */
  img{max-width:100%}
  .meta{color:var(--muted);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
`;

function head(title: string, description: string, canonical: string, extraJsonLd = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
${extraJsonLd}
<style>${STYLE}</style>
</head>
<body>
<header><div class="wrap bar">
  <a class="brand" href="/">🐾 FurryFriend</a>
  <nav>
    <a href="/#shop">Shop</a>
    <a href="/#make">What you can make</a>
    <a href="/#read">Guides</a>
    <a href="/#futures">Futures</a>
    <a href="/#roadmap">Roadmap</a>
  </nav>
  <a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">Visit the shop</a>
</div></header>`;
}

const SIGNUP = `
  <div class="note" id="keep-in-touch">
    <h3>Get told when Futures opens</h3>
    <p class="small">We're building in the open. Ask to be kept posted and we'll write when the AR
    game is playable and when the health tools are ready to try — no more than that.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="${STORE}/pages/contact" target="_blank" rel="noopener">Keep me posted ↗</a>
    </div>
    <p class="small" style="margin-top:10px">Opens our shop's contact form. Say "keep me posted" and
    leave your email — that's all we need.</p>
  </div>`;


function footer(): string {
  return `<footer><div class="wrap">
  <p>© 2026 FurryFriend.cc — pet keepsakes and the studio behind them.
  <a href="${APP}" target="_blank" rel="noopener">Pawsome3D</a> ·
  <a href="${STORE}" target="_blank" rel="noopener">Shop</a> ·
  <a href="/privacy.html">Privacy</a> ·
  <a href="/terms.html">Terms</a></p>
  <p class="small">Futures and the health features described on this site are in development and not
  yet available. Nothing here is veterinary advice.</p>
</div></footer>
</body></html>`;
}

// ── Articles ────────────────────────────────────────────────────────────────
interface Article {
  slug: string; title: string; metaTitle: string; description: string;
  category: string; readMin: number; hero: string; heroAlt: string;
  excerpt: string; body: string; cta: "shop" | "studio";
}

const ARTICLES: Article[] = [
  {
    slug: "honor-a-pets-memory",
    title: "How to Honor a Beloved Pet's Memory",
    metaTitle: "How to Honor a Beloved Pet's Memory — Ideas That Actually Help",
    description: "Practical, unsentimental ways to memorialise a pet: start from one specific detail, choose a form that fits your grief, and avoid the keepsakes people regret.",
    category: "Memorials", readMin: 8, hero: "/img/stock-tuck.jpg",
    heroAlt: "A dog resting calmly, looking toward the camera",
    excerpt: "Start with one true detail: the look they gave you at the door, the white patch on one paw, the sound of their tag crossing the room.",
    cta: "shop",
    body: `
<p>Most advice about pet memorials starts with the object. That's backwards. Start with one
specific, true detail — the look they gave you at the door, the white patch on one paw, the sound
of their tag crossing the room at 6am. A memorial that carries a detail like that will mean
something in ten years. A generic one won't, however much it cost.</p>

<h2>Give yourself permission to wait</h2>
<p>There is no deadline. Grief in the first weeks is loud, and decisions made inside it tend to be
either too large or too fast. Many people find that the object they actually want becomes obvious
around the three-month mark, once the sharpest part has passed and they can think about the whole
animal rather than the ending.</p>
<p>If you want to do something immediately, do something reversible: gather the photos into one
folder, write down three stories while you still remember the details, ask family for the pictures
on their phones that you've never seen.</p>

<h2>Choose a form that matches how you grieve</h2>
<ul>
  <li><strong>If you want them present daily</strong> — something functional wins. A mug you use
  every morning gets more contact than a framed print in a hallway.</li>
  <li><strong>If you want a moment to visit</strong> — a single considered piece on a wall or shelf
  creates a place to go. Don't scatter reminders through the house; that tends to ambush you.</li>
  <li><strong>If you want to hold something</strong> — a tactile keepsake, a blanket, a printed
  figure. Physical presence matters more to some people than image quality does.</li>
  <li><strong>If you're grieving with others</strong> — make more than one. Shared objects give a
  family a way to talk about it without having to start the conversation.</li>
</ul>

<h2>The keepsakes people regret</h2>
<p>Two patterns come up repeatedly. The first is the <em>hyper-realistic portrait that isn't quite
right</em> — close enough to read as your pet, wrong enough to unsettle you every time. If a piece
makes you flinch, it will keep doing that. Better a stylised version that captures the character
than a photoreal one that misses the eyes.</p>
<p>The second is <strong>the memorial made too soon and too big</strong>: a large commission
ordered in week one, arriving in week six to a person who has moved somewhere different
emotionally. Small and early, or considered and later — the middle is where the regret lives.</p>

<h2>Choosing the photo</h2>
<p>The best source photo is rarely the most beautiful one. Look for the picture where their
posture is characteristic — the head tilt, the way they sat, the ridiculous sprawl. A technically
perfect portrait of a dog holding still like they never did in life makes a worse memorial than a
slightly soft photo of them being unmistakably themselves.</p>
<p>Practically: face toward the camera, decent light, eyes visible. Avoid heavy motion blur and
very dark shots.</p>

<h2>Include the ordinary</h2>
<p>Whatever you make, write down the small things nobody photographs: where they slept, what they
were afraid of, the noise they made when you came home. Objects fade in meaning without the story
attached. A short note kept with the keepsake is the part your family will thank you for.</p>`,
  },
  {
    slug: "photo-to-animated-3d-video",
    title: "How to Turn a Single Photo Into an Animated 3D Video",
    metaTitle: "Turn One Pet Photo Into an Animated 3D Video — What Actually Works",
    description: "What a single photo can and cannot give you, how to choose the right source image, and a realistic account of where AI pet animation succeeds and fails.",
    category: "3D & animation", readMin: 9, hero: "/img/3d-hero.jpg",
    heroAlt: "A 3D-rendered dog model shown against a neutral background",
    excerpt: "One photo can start the process, but it cannot reveal every hidden angle. Knowing what it can't see is the difference between a good result and an uncanny one.",
    cta: "studio",
    body: `
<p>A single photograph contains one viewpoint. Everything behind your pet's head, the far side of
their body, the shape of an ear from the back — none of it is in the file. Modern AI fills those
gaps by inference: it has seen enough dogs and cats to make a confident guess. Understanding that
this is a <em>guess</em> is what separates people who get good results from people who are
disappointed.</p>

<h2>What one photo gives you reliably</h2>
<ul>
  <li><strong>Face and markings</strong> — the part facing the camera reconstructs well, because
  it's directly observed rather than inferred.</li>
  <li><strong>Silhouette and proportion</strong> — overall build, leg length, body shape.</li>
  <li><strong>Coat colour and pattern</strong> — on the visible side.</li>
</ul>

<h2>What it guesses, and sometimes gets wrong</h2>
<ul>
  <li><strong>The far side</strong> — asymmetric markings are frequently mirrored or invented. If
  your pet has a patch on one side only, expect to correct it.</li>
  <li><strong>Ear geometry from behind</strong> — a common source of the "not quite them" feeling.</li>
  <li><strong>Fur length under the body</strong> — often smoothed.</li>
  <li><strong>Anything occluded</strong> — a tail tucked out of frame is a tail the model invents.</li>
</ul>

<h2>Choosing your source photo</h2>
<p>This decides most of the outcome. In rough order of importance:</p>
<ul>
  <li><strong>Facing the camera</strong>, head up, eyes visible.</li>
  <li><strong>Even, diffuse light</strong> — overcast daylight or a bright room. Harsh sun creates
  hard shadows the model reads as markings.</li>
  <li><strong>Clean separation from the background</strong> — a pet against a busy patterned rug is
  harder to isolate than one on a plain floor.</li>
  <li><strong>Sharp</strong> — motion blur becomes smeared geometry.</li>
</ul>
<p>A slightly imperfect photo of your pet looking at you beats a magazine-quality shot of the back
of their head.</p>

<h2>From still to motion</h2>
<p>Animation is a separate step with different failure modes. Image-to-video models generate motion
by predicting plausible next frames, which means they're good at gentle, natural movement and bad
at anything sudden. Ask for a slow camera push and soft head movement and you'll usually get
something lovely. Ask for a backflip and you'll get a smeared mess.</p>
<p>Keep clips short. Eight seconds of convincing motion is worth more than thirty seconds that
drift away from your pet's likeness — and drift is what happens as clip length grows.</p>

<h2>A realistic workflow</h2>
<ol>
  <li>Pick three candidate photos rather than one. The best source is often not the one you expect.</li>
  <li>Generate, then look specifically at the eyes and ears — that's where the uncanny lives.</li>
  <li>If it's close but wrong, try a different source photo before trying different settings.</li>
  <li>Once you have a still you'd frame, animate that. Don't animate something you're unsure of;
  motion amplifies every flaw.</li>
</ol>
<p>And a note on expectations: this technology is genuinely good and genuinely imperfect. When it
works it's startling. When it doesn't, it's usually the photo — not you.</p>`,
  },
  {
    slug: "gifts-for-dog-owners",
    title: "10 Unique Gifts for Dog Owners Who Have Everything",
    metaTitle: "10 Gifts for Dog Owners Who Have Everything (That Get Used)",
    description: "Gift ideas that notice the relationship rather than the dog: what to buy for the owner who already owns every toy, sorted by budget and by how well you know them.",
    category: "Gift ideas", readMin: 6, hero: "/img/pp-chef.jpg",
    heroAlt: "A stylised chef-themed pet portrait",
    excerpt: "The best gift is not the most unusual object. It's the one that notices a relationship — the dog's routines, the owner's humour, how much planning the occasion allows.",
    cta: "shop",
    body: `
<p>The person who "has everything" usually has every <em>dog product</em>. What they rarely have is
something that acknowledges their specific dog — the particular ridiculous animal in their house,
not dogs in general. That's the gap worth aiming at.</p>

<h2>If you know the dog well</h2>
<ul>
  <li><strong>A custom portrait in a style that's a joke between you.</strong> The dog as a
  Renaissance noble, a chef, an athlete. It works because it requires knowing the dog's personality
  well enough to pick the right absurdity.</li>
  <li><strong>Something they use daily with the dog on it.</strong> A mug, a feeding mat, a mouse
  pad. Frequency of contact beats grandeur.</li>
  <li><strong>A blanket.</strong> Quietly the highest-satisfaction gift in this category — it's
  useful, it's tactile, and the dog will lie on it, which is the point.</li>
</ul>

<h2>If you know the owner better than the dog</h2>
<ul>
  <li><strong>Playing cards or a game</strong> with the dog worked in — social, low-commitment, and
  it doesn't require you to have nailed the dog's likeness.</li>
  <li><strong>A bandana.</strong> Small, hard to get wrong, photographs well — which is what the
  owner actually wants.</li>
  <li><strong>Wall art for a room they've mentioned decorating.</strong> Listen for the complaint
  about a blank wall; that's the brief.</li>
</ul>

<h2>If the occasion is difficult</h2>
<ul>
  <li><strong>For a dog who has died</strong> — ask first, always. Some people want the reminder
  immediately; others need months. "I'd like to make something for you when you're ready" is a
  better gift than the object itself arriving unannounced.</li>
  <li><strong>For a new adoption</strong> — wait a few weeks. The name sometimes changes, and so
  does the owner's sense of who this animal is.</li>
  <li><strong>For a senior dog</strong> — this is the moment for the good portrait. Don't wait.</li>
</ul>

<h2>The one rule</h2>
<p>Use a photo the owner already loves. Ask them to send you their favourite picture of the dog
"for something", and use that. It's already been chosen by the person who knows the dog best, and
you avoid the trap of picking a technically better photo that doesn't look like <em>their</em> dog
to them.</p>

<h2>What to avoid</h2>
<p>Anything that requires the dog to cooperate — costumes, elaborate accessories, anything the
animal will remove within four minutes. And anything sized to the dog: weights change, and a
gift that no longer fits becomes a small sadness rather than a pleasure.</p>`,
  },
  {
    slug: "cat-as-historical-figure",
    title: "What Your Cat Would Look Like as a Pre-1900 Historical Figure",
    metaTitle: "Your Cat as a Historical Figure — Choosing a Role That Fits",
    description: "A guide to picking the right historical role for your cat based on their actual posture and temperament, and why matching the animal beats picking a costume.",
    category: "Historical & fun", readMin: 6, hero: "/img/pp-queen.jpg",
    heroAlt: "A pet rendered as a regal historical portrait",
    excerpt: "The trick is not putting any cat in an old costume. Start with the cat's real posture and expression, then choose a role that makes those traits feel inevitable.",
    cta: "studio",
    body: `
<p>Put a random cat in a ruff and you get a costume. Put <em>your</em> cat in the role their face
was already auditioning for and you get a portrait people stop and look at. The difference is
entirely in the casting.</p>

<h2>Start with the cat, not the century</h2>
<p>Watch how they hold themselves for a day. Almost every cat falls into one of a handful of
postures, and each has an obvious historical counterpart.</p>
<ul>
  <li><strong>The loaf, eyes half closed, unbothered</strong> → a magistrate, a bishop, a Dutch
  merchant who has already counted the money. Heavy fabrics, dark background, one hand of light.</li>
  <li><strong>Upright, alert, staring past you</strong> → a naval officer or an explorer. Give them
  a horizon and a high collar.</li>
  <li><strong>Chaotic, caught mid-motion</strong> → a duellist, a stage performer, a Romantic poet
  in disarray. Motion suits them; don't force stillness.</li>
  <li><strong>Small, wide-eyed, permanently startled</strong> → an apprentice or a young scholar
  surrounded by books far too large for them. Comedy through scale.</li>
  <li><strong>Enormous and serene</strong> → royalty. Obviously royalty.</li>
</ul>

<h2>Match the era to the coat</h2>
<p>This is the trick nobody mentions. A long-haired cat carries volume — Elizabethan collars,
powdered-wig eras, anything with silhouette. A sleek short-hair reads better in tailored, austere
periods: Regency, Victorian mourning dress, military uniform. Fighting the coat produces the
"costume" look; working with it produces a portrait.</p>
<p>Tabby markings behave like patterned fabric, so keep the clothing plainer or the image becomes
noisy. Solid black cats are the easiest subjects in history and the hardest to light — ask for a
strong rim light or they vanish into the background.</p>

<h2>Keep the face honest</h2>
<p>The most common mistake is over-styling until the animal is gone. The costume, the lighting and
the era are the joke; the cat has to remain recognisably itself for the joke to land. If a friend
can't identify your cat in the picture within two seconds, it's gone too far — restart with a
plainer setting.</p>

<h2>The pre-1900 rule</h2>
<p>There's a practical reason this era works so well: portraiture before photography was about
<em>status and character</em> rather than likeness. Sitters were painted as they wished to be
understood. That is exactly the right register for a cat, an animal that has never once doubted
its own importance.</p>`,
  },
  {
    slug: "letter-from-an-adopted-stray",
    title: "From Puppy to Parent: A Letter from an Adopted Stray",
    metaTitle: "A Letter from an Adopted Stray — On Adjusting to a New Home",
    description: "A short piece written from a rescue dog's point of view, with practical notes underneath on what the first weeks with an adopted dog actually require.",
    category: "Pet stories & adoption", readMin: 6, hero: "/img/before-pup.jpg",
    heroAlt: "A young spaniel resting on a bed",
    excerpt: "Before I knew your name or the warmth of a bed, I knew what it felt like to be small in a big, noisy world.",
    cta: "studio",
    body: `
<p><em>Written as a piece of fiction, from the perspective of a rescue dog. The practical notes
underneath are not fiction.</em></p>

<p>Before I knew your name or the warmth of a bed, I knew what it felt like to be small in a big,
noisy world. I knew which bins were worth the risk. I knew the sound a car makes when it is slowing
down for you rather than driving past.</p>

<p>When you brought me home I did not trust the quiet. Quiet had always meant something was about
to happen. So I sat by the door for three days and watched you, and you let me, which is the first
kind thing anybody had done that I understood.</p>

<p>You kept doing small things. You put food down and walked away instead of standing over it. You
never reached for my collar from above. When I flinched at the broom you put it away and did not
make it a lesson. None of it looked like training. All of it was.</p>

<p>It took a season before I slept on my side with my back to you. I know that seems like nothing.
It is the single largest thing I have ever done.</p>

<p>I am not the dog you met. I am a dog who found out what it is like to be certain of the next
meal, and it turns out that changes almost everything about a personality. The nervousness you were
warned about was not who I was. It was arithmetic.</p>

<h2>What the first weeks actually need</h2>
<p>The story above is sentimental on purpose. This part isn't.</p>
<ul>
  <li><strong>Expect three days, three weeks, three months.</strong> Roughly: three days to stop
  panicking, three weeks to learn the routine, three months to show you who they actually are. The
  dog you adopt is not the dog you'll have.</li>
  <li><strong>Shrink the world first.</strong> One room, one routine, few visitors. Space is not a
  kindness to an animal that can't yet predict anything.</li>
  <li><strong>Don't correct fear.</strong> Fear responds to distance and time, not instruction.
  Punishing a flinch teaches concealment, and a dog who conceals fear is a dog who bites without
  warning later.</li>
  <li><strong>Let them opt in.</strong> Sit on the floor, look away, wait. Approaching a frightened
  dog is the fastest way to slow everything down.</li>
  <li><strong>Take photos from week one.</strong> Not for social media — for you. The change between
  the dog who arrives and the dog at six months is enormous, and it happens too gradually to notice
  without evidence.</li>
</ul>

<p>That last one is why we build what we build. The pictures from the first week rarely feel worth
keeping at the time. They're the ones that matter most later.</p>`,
  },
];

function productCard(p: Product): string {
  const personal = p.pawprint_personalizable ? `<span class="tag tag-personal">Add your pet</span>` : "";
  return `
        <a class="card" href="${esc(p.product_url)}" target="_blank" rel="noopener">
          <div class="shot"><img src="${esc(p.featured_image_url)}" alt="${esc(p.title)}" loading="lazy" width="400" height="400"></div>
          <div class="card-body">${personal}
            <h3>${esc(p.title)}</h3><p class="price">$${esc(p.min_price)} ${esc(p.currency_code)}</p>
          </div></a>`;
}

function articleCard(a: Article): string {
  return `
        <a class="card" href="/${a.slug}.html">
          <div class="shot"><img src="${a.hero}" alt="${esc(a.heroAlt)}" loading="lazy" width="400" height="400"></div>
          <div class="card-body">
            <span class="tag tag-cat">${esc(a.category)} · ${a.readMin} min</span>
            <h3>${esc(a.title)}</h3>
            <p class="small">${esc(a.excerpt)}</p>
          </div></a>`;
}

function articlePage(a: Article): string {
  const jsonLd = `<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":${JSON.stringify(a.title)},
"description":${JSON.stringify(a.description)},"image":"${SITE}${a.hero}",
"mainEntityOfPage":"${SITE}/${a.slug}.html",
"publisher":{"@type":"Organization","name":"FurryFriend","url":"${SITE}/"}}
</script>`;
  const cta = a.cta === "shop"
    ? `<div class="cta-row"><a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">Browse keepsakes ↗</a>
        <a class="btn btn-ghost" href="${APP}" target="_blank" rel="noopener">Make the art first ↗</a></div>`
    : `<div class="cta-row"><a class="btn btn-primary" href="${APP}" target="_blank" rel="noopener">Try it free on Pawsome3D ↗</a>
        <a class="btn btn-ghost" href="${STORE}" target="_blank" rel="noopener">Or browse the shop ↗</a></div>`;

  return `${head(a.metaTitle, a.description, `${SITE}/${a.slug}.html`, jsonLd)}
<section><div class="wrap narrow">
  <article>
    <p class="meta">${esc(a.category)} · ${a.readMin} min read</p>
    <h1>${esc(a.title)}</h1>
    <p class="lede">${esc(a.excerpt)}</p>
    <img class="hero" src="${a.hero}" alt="${esc(a.heroAlt)}" width="900" height="600">
    ${a.body}
  </article>
  ${cta}
</div></section>
<section><div class="wrap narrow">${SIGNUP}
  <p class="small" style="margin-top:22px"><a href="/#read">← All guides</a></p>
</div></section>
${footer()}`;
}

function indexPage(products: Product[], personalizable: number, lowest: string): string {
  const featured = [
    ...products.filter((p) => p.pawprint_personalizable),
    ...products.filter((p) => !p.pawprint_personalizable),
  ].slice(0, 8);

  const jsonLd = `<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebSite","name":"FurryFriend","url":"${SITE}/",
"description":"Pet keepsakes, 3D pet avatars, and the technology behind them.",
"publisher":{"@type":"Organization","name":"FurryFriend","url":"${SITE}/"}}
</script>`;

  return `${head(
    "FurryFriend — Pet Keepsakes, 3D Pet Avatars & What We're Building Next",
    "Turn a pet photo into custom art, printed keepsakes and a 3D avatar. Shop keepsakes, read practical guides, and follow Futures — the AR game we're building on the same pet models.",
    `${SITE}/`, jsonLd)}

<section>
  <div class="wrap">
    <p class="eyebrow">We're just getting started</p>
    <h1>Your pet, turned into something you can keep.</h1>
    <p class="lede">FurryFriend is the front door to two things: a shop of custom pet keepsakes you
    can order today, and <strong>Pawsome3D</strong>, a free studio that turns one photo of your pet
    into art, video and a 3D avatar. We're a small, new operation — and we'd rather tell you exactly
    what's ready and what we're still building than pretend otherwise.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="#shop">Shop keepsakes from $${esc(lowest)}</a>
      <a class="btn btn-ghost" href="${APP}" target="_blank" rel="noopener">Try the studio free ↗</a>
    </div>
    <h2>One photo in. Something else out.</h2>
    <p class="sub">This is a real example — the photo on the left, made in the studio into the
    picture on the right.</p>
    <div class="ba">
      <figure><img src="/img/before-pup.jpg" alt="Original snapshot of a spaniel on a bed" width="900" height="600"><figcaption>The photo</figcaption></figure>
      <figure><img src="/img/after-halloween.jpg" alt="The same spaniel rendered into a Halloween scene with pumpkins and lights" width="900" height="1116"><figcaption>Made in the studio</figcaption></figure>
    </div>
  </div>
</section>

<section id="shop">
  <div class="wrap">
    <p class="eyebrow">Shop</p>
    <h2>Keepsakes you can order right now</h2>
    <p class="sub">Mugs, canvas, blankets, feeding mats, playing cards and more. ${personalizable}
    of these can be personalised with your own pet's portrait — make the art in the studio, then put
    it on the thing you actually use.</p>
    <div class="grid g4">${featured.map(productCard).join("")}
    </div>
    <div class="cta-row"><a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener">See the full shop ↗</a></div>
  </div>
</section>

<section id="make">
  <div class="wrap">
    <p class="eyebrow">What you can make</p>
    <h2>One photo. Four different things.</h2>
    <p class="sub">Everything below works today on Pawsome3D, and starting is free. You upload a
    clear photo of your pet — facing the camera, decent light — and the studio does the rest.</p>
    <div class="grid g2">
      <div class="feature"><div class="ico">🎨</div><h3>PawPrints — custom pet art</h3>
        <p class="small">Pick a theme and your pet is re-rendered into it: a Halloween scene, a
        Renaissance portrait, seasonal artwork. <strong>Use it for:</strong> a print for the wall, a
        gift, or the design that goes onto a mug or canvas in the shop above.</p></div>
      <div class="feature"><div class="ico">✂️</div><h3>Background removal</h3>
        <p class="small">Cut your pet cleanly out of a busy photo — fur edges and all — so they can
        sit on any background. <strong>Use it for:</strong> prepping a photo before making art, or
        getting a clean cutout for a product design.</p></div>
      <div class="feature"><div class="ico">🎬</div><h3>Video Studio</h3>
        <p class="small">Turn a still photo into a short cinematic clip with camera motion and
        lighting. <strong>Use it for:</strong> a birthday or memorial reel, or something to post
        rather than another still.</p></div>
      <div class="feature"><div class="ico">📐</div><h3>3D avatar &amp; Fur Bin</h3>
        <p class="small">Generate a 3D model of your pet and keep every creation in your Fur Bin to
        download later. <strong>Use it for:</strong> viewing your pet in 3D, and — soon — playing as
        them. See Futures below.</p></div>
    </div>
    <h2>Photo in, 3D model out</h2>
    <p class="sub">The same pipeline that makes the art also builds a 3D version of your pet. This
    is a real one — the photo on the left, the model the studio generated from it on the right.</p>
    <div class="ba">
      <figure><img src="/img/3d-before-shiba.jpg" alt="Studio photograph of a white Shiba-type dog standing on a grey background" loading="lazy" width="800" height="800"><figcaption>The photo</figcaption></figure>
      <figure><img src="/img/3d-after-shiba.jpg" alt="A 3D model of the same white dog, rendered from a different angle" loading="lazy" width="800" height="450"><figcaption>The 3D model</figcaption></figure>
    </div>
    <p class="small">Notice the model is shown from an angle the photo never saw — that far side is
    reconstructed rather than observed, which is exactly what the
    <a href="/photo-to-animated-3d-video.html">guide on single-photo 3D</a> gets into.</p>

    <h2>A few made in the studio</h2>
    <div class="grid g3">
      <figure class="card"><div class="shot"><img src="/img/pp-christmas.jpg" alt="A dog rendered into a festive Christmas scene" loading="lazy" width="700" height="700"></div></figure>
      <figure class="card"><div class="shot"><img src="/img/pp-queen.jpg" alt="A pet rendered as a regal historical portrait" loading="lazy" width="700" height="700"></div></figure>
      <figure class="card"><div class="shot"><img src="/img/pp-sports.jpg" alt="A pet rendered in a sports-themed portrait" loading="lazy" width="700" height="700"></div></figure>
      <figure class="card"><div class="shot"><img src="/img/pp-ghost.jpg" alt="A dog rendered as a ghostly figure" loading="lazy" width="700" height="700"></div></figure>
      <figure class="card"><div class="shot"><img src="/img/pp-chef.jpg" alt="A dog rendered as a chef" loading="lazy" width="700" height="700"></div></figure>
      <figure class="card"><div class="shot"><img src="/img/pp-holiday.jpg" alt="A pet rendered in a holiday scene" loading="lazy" width="700" height="700"></div></figure>
    </div>
    <div class="cta-row"><a class="btn btn-primary" href="${APP}" target="_blank" rel="noopener">Start free on Pawsome3D ↗</a></div>
  </div>
</section>

<section id="read">
  <div class="wrap">
    <p class="eyebrow">Guides</p>
    <h2>Helpful first. Product fit second.</h2>
    <p class="sub">Practical writing about memorials, photos, gifts and the technology. If you read
    one of these, take the advice and never buy anything, we've still done our job.</p>
    <div class="grid g3">${ARTICLES.map(articleCard).join("")}
    </div>
  </div>
</section>

<section id="futures">
  <div class="wrap">
    <p class="eyebrow">In development</p>
    <h2>Futures — an AR game starring your actual pet</h2>
    <p class="sub">This is the part we're most excited about, and it is genuinely being built right
    now. <strong>Futures</strong> is an augmented-reality game that uses the very same 3D model
    Pawsome3D makes from your photo. Not a lookalike, not a preset character — your pet, as the
    playable character, dropped into the room you're standing in.</p>
    <div class="grid g2">
      <div class="feature"><div class="ico">🕹️</div><h3>Your model, not a stand-in</h3>
        <p class="small">Because the game reads the same rigged 3D file the studio produces, a pet
        you create today is a character you can play later. Making an avatar now is not wasted
        work.</p></div>
      <div class="feature"><div class="ico">📱</div><h3>In your actual room</h3>
        <p class="small">Built on the AR paths phones already support, so your pet appears at real
        scale on the floor in front of you rather than in a window on a screen.</p></div>
    </div>
    <h3 style="margin-top:26px">Running today</h3>
    <p class="sub">This is an actual capture from the build as it stands — a pet model and scene
    objects placed onto real ground through the camera. Rough, and real.</p>
    <div class="ba">
      <figure><img src="/img/ar-now.jpg" alt="Camera view of a 3D dog and a doghouse model placed on a real grass field" loading="lazy" width="700" height="869"><figcaption>Today</figcaption></figure>
      <figure><img src="/img/ar-target.jpg" alt="A more finished rendering of the same scene, showing the intended visual quality" loading="lazy" width="700" height="1254"><figcaption>Where it's heading</figcaption></figure>
    </div>
    <p class="small">Left is the current build. Right is the target — better lighting, shadows that
    sit properly on the ground, and materials that hold up at close range. The gap between those two
    pictures is most of what we're working on.</p>
    <p class="note"><span class="tag tag-dev">Honest status</span><br>
    Futures is <strong>in active development and not playable yet</strong>. We don't have a release
    date, and we're not taking money for it. We're mentioning it because it's the reason the 3D side
    of the studio exists, and because anything you create now will carry forward into it.</p>
    ${SIGNUP}
  </div>
</section>

<section id="roadmap">
  <div class="wrap">
    <p class="eyebrow">On the roadmap</p>
    <h2>Where we're heading next</h2>
    <p class="sub">Longer-term work we've started but haven't shipped. Listed here so you know the
    direction — not as things you can use today.</p>
    <div class="grid g2">
      <div class="feature"><span class="tag tag-dev">In development</span><h3>Pet health scan</h3>
        <p class="small">Using the same photo-to-3D pipeline to help you track visible, physical
        changes over time — body condition, posture, how your pet is carrying themselves — from the
        pictures you already take.</p></div>
      <div class="feature"><span class="tag tag-dev">In development</span><h3>Ongoing monitoring</h3>
        <p class="small">Turning those scans into a timeline, so a slow change over months is
        something you can actually see rather than something you notice too late.</p></div>
    </div>
    <p class="note"><strong>To be clear about this one:</strong> the health features are early,
    unreleased, and will never be a diagnosis. Nothing we build replaces a veterinarian. The goal is
    to help you notice a change worth asking a vet about — that's all, and we'd rather say so now
    than oversell it later.</p>
  </div>
</section>

<section id="faq">
  <div class="wrap">
    <p class="eyebrow">FAQ</p>
    <h2>Straight answers</h2>
    <details><summary>What does it cost to try?</summary><p>Creating an account and starting in the
      studio is free. Keepsakes in the shop are priced individually, starting at $${esc(lowest)}.</p></details>
    <details><summary>What kind of photo works best?</summary><p>One clear, well-lit photo with your
      pet facing the camera. Faces turned away, heavy motion blur, or very dark shots are what
      usually disappoint. You can always try another photo.</p></details>
    <details><summary>Can I put my pet's art on a product?</summary><p>Yes — ${personalizable}
      products in the shop are personalisable. You make the artwork in the studio and it goes onto
      the item.</p></details>
    <details><summary>Can I play the AR game yet?</summary><p>Not yet. Futures is in development
      with no release date. Your 3D models will carry over when it's ready.</p></details>
    <details><summary>Is the health scan available?</summary><p>No — it's early and unreleased, and
      it is not a veterinary diagnostic. It's intended to help you spot changes worth raising with
      your vet.</p></details>
    <details><summary>Who is behind this?</summary><p>A small independent team. We launched
      recently, we're building in the open, and we'd rather be honest about what's finished than
      inflate the numbers.</p></details>
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
${footer()}`;
}

function legalPage(title: string, desc: string, slug: string, body: string): string {
  return `${head(`${title} — FurryFriend`, desc, `${SITE}/${slug}.html`)}
<section><div class="wrap narrow">
  <h1>${esc(title)}</h1>
  <p class="small">Last updated 20 August 2026.</p>
  ${body}
</div></section>
${footer()}`;
}

const PRIVACY = `
<p>FurryFriend.cc is an informational site operated by the team behind Pawsome3D. This page explains
what happens to your information here.</p>
<h2>What this site collects</h2>
<p>This site is static. It sets no tracking cookies, runs no analytics scripts, and does not build a
profile of you. The only information you can give us is an email address, and only if you type it
into the sign-up form yourself.</p>
<h2>The email sign-up</h2>
<p>If you submit your email, it is sent to our Shopify store and stored there as a marketing
contact, tagged so we know it came from this site. We use it to tell you when features we've
described as in development become available. You can unsubscribe from any message we send, and we
will delete your address on request.</p>
<h2>Links to other services</h2>
<p>Links to our shop and to Pawsome3D take you to separate services with their own privacy
practices. Photographs you upload are handled by Pawsome3D under its own privacy policy, not this
one. Product pages are served by Shopify, which sets its own cookies once you arrive there.</p>
<h2>Images on this page</h2>
<p>Example images are of pets belonging to the team, used with permission. We do not publish
customer photographs without explicit consent.</p>
<h2>Contacting us</h2>
<p>For any question about your data, or to have an email address removed, contact us through
<a href="${APP}" target="_blank" rel="noopener">Pawsome3D</a>.</p>`;

const TERMS = `
<p>Plain-language terms for using this website.</p>
<h2>What this site is</h2>
<p>FurryFriend.cc publishes guides about pet keepsakes and points to two places you can act: our
shop, and the Pawsome3D studio. Purchases are made on those services and are governed by their
terms, not these.</p>
<h2>Features described as in development</h2>
<p>Some things on this site — the Futures AR game and the pet health scanning and monitoring
features — are explicitly described as in development. They are not available, they have no release
date, and nothing here is an offer to sell them or a promise that they will ship in any particular
form. We describe them because we're building in the open, not as a commitment.</p>
<h2>Health features are not veterinary advice</h2>
<p>Nothing on this site is veterinary advice, diagnosis or treatment. The health features we
describe are intended to help you notice physical changes worth discussing with a veterinarian. They
will not diagnose illness and must never delay professional care. If you are worried about your
animal, contact a vet.</p>
<h2>Guides and accuracy</h2>
<p>The guides reflect our honest experience and are general in nature. Your results with any
photograph or product will vary. We correct errors when we find them.</p>
<h2>Your content</h2>
<p>Photographs you upload are handled by Pawsome3D under its terms. This site does not accept
uploads.</p>
<h2>Changes</h2>
<p>We may update these terms as the products change. The date at the top reflects the most recent
revision.</p>`;

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
  const lowest = products[0].min_price;

  fs.mkdirSync(OUT, { recursive: true });
  const write = (name: string, html: string) => {
    fs.writeFileSync(path.join(OUT, name), html, "utf8");
    console.log(`  ${name.padEnd(34)} ${(html.length / 1024).toFixed(1)} KB`);
  };

  console.log("Writing pages:");
  write("index.html", indexPage(products, personalizable, lowest));
  for (const a of ARTICLES) write(`${a.slug}.html`, articlePage(a));
  write("privacy.html", legalPage("Privacy", "What FurryFriend collects, which is almost nothing, and what happens to an email address if you give us one.", "privacy", PRIVACY));
  write("terms.html", legalPage("Terms", "Plain-language terms, including that features described as in development are not available and that nothing here is veterinary advice.", "terms", TERMS));

  const sitemap = ["", ...ARTICLES.map((a) => a.slug), "privacy", "terms"]
    .map((s) => `  <url><loc>${SITE}/${s ? s + ".html" : ""}</loc></url>`).join("\n");
  fs.writeFileSync(path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>\n`);
  fs.writeFileSync(path.join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log("  sitemap.xml + robots.txt");
  console.log(`\n${products.length} sellable products, ${personalizable} personalizable, from $${lowest}`);
  await closePool();
})().catch((err) => { console.error(err?.message || err); process.exit(1); });
