import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articles } from "./content/articles.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const siteUrl = "https://furryfriend.cc";
const updated = "2026-07-31";
const ledger = JSON.parse(fs.readFileSync(path.join(root, "content", "editorial-ledger.json"), "utf8"));
const jobBySlug = new Map(ledger.jobs.map((job) => [job.slug, job]));

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function jsonLd(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function nav(active = "") {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="site-header">
    <a class="skip-link" href="#main">Skip to the answer</a>
    <div class="nav-shell">
      <a class="brand" href="/" aria-label="FurryFriend home">
        <img src="/assets/pawsome-logo.png" alt="" width="42" height="42">
        <span><strong>FurryFriend</strong><small>a Pawsome3D guide</small></span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
      <nav id="site-nav" aria-label="Primary navigation">
        ${link("/guides/", "Guides", "guides")}
        ${link("/about/", "About", "about")}
        ${link("/editorial-policy/", "Editorial policy", "policy")}
      </nav>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer"><div>
    <p><strong>FurryFriend</strong> is an educational guide by Pawsome3D.</p>
    <p class="footer-links"><a href="/about/">About</a><a href="/editorial-policy/">Editorial policy</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="https://pawsome3d.com">Pawsome3D</a></p>
    <p class="fine-print">Kind, practical pet-keepsake guidance. No veterinary, mental-health, legal, or financial advice.</p>
  </div></footer>`;
}

function page({ title, description, pathname, body, active, noindex = false, structuredData = [] }) {
  const canonical = `${siteUrl}${pathname}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  ${noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="FurryFriend">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${siteUrl}/og.png">
  <meta property="og:image:alt" content="FurryFriend — helpful answers for keeping your pet’s story close">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#faf9f5">
  <link rel="icon" href="/assets/pawsome-logo.png">
  <link rel="stylesheet" href="/styles.css">
  ${structuredData.map((entry) => `<script type="application/ld+json">${jsonLd(entry)}</script>`).join("\n  ")}
</head>
<body>
  ${nav(active)}
  <main id="main">${body}</main>
  ${footer()}
  <script src="/site.js" defer></script>
</body>
</html>`;
}

function writeRoute(pathname, html) {
  const target = pathname === "/"
    ? path.join(dist, "index.html")
    : path.join(dist, pathname.replace(/^\//, ""), "index.html");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
}

function card(article) {
  return `<article class="guide-card" data-guide-card data-search="${esc(`${article.title} ${article.topic} ${article.dek}`.toLowerCase())}">
    <a class="card-image" href="/guides/${article.slug}/"><img src="${article.image}" alt="${esc(article.imageAlt)}" width="640" height="400" loading="lazy"></a>
    <div class="card-body"><p class="eyebrow">${esc(article.topic)} · ${article.readMinutes} min</p>
      <h3><a href="/guides/${article.slug}/">${esc(article.title)}</a></h3>
      <p>${esc(article.dek)}</p>
      <span class="preview-tag">Editorial preview</span>
    </div>
  </article>`;
}

function buildHome() {
  const featured = articles.map(card).join("");
  const body = `<section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Clear answers. Thoughtful keepsakes.</p>
      <h1>Helpful answers for keeping your pet’s story close.</h1>
      <p class="lede">Practical guidance for pet memorials, photo-to-3D keepsakes, meaningful gifts, and creative ways to celebrate the details that make a pet unforgettable.</p>
      <div class="hero-actions"><a class="button primary" href="/guides/">Browse the guides</a><a class="button secondary" href="/editorial-policy/">How we check claims</a></div>
      <p class="trust-line">No keyword stuffing. No invented reviews. No product promise without evidence.</p>
    </div>
    <div class="hero-art" aria-label="A warm 3D pet keepsake illustration"><img src="/assets/furball3d.jpg" alt="A luminous stylized 3D dog figure" width="760" height="760"></div>
  </section>
  <section class="answer-search" aria-labelledby="question-heading">
    <div><p class="eyebrow">Start with your question</p><h2 id="question-heading">What are you trying to figure out?</h2><p>Search these first editorial previews. Unanswered questions will become reviewed guide candidates once secure intake is added.</p></div>
    <label for="guide-search">Search guides</label><input id="guide-search" data-guide-search type="search" placeholder="Try “one photo,” “memorial,” or “gift”" autocomplete="off">
    <p class="search-status" data-search-status aria-live="polite"></p>
  </section>
  <section class="section-shell" aria-labelledby="featured-heading"><div class="section-heading"><p class="eyebrow">Four essential starting points</p><h2 id="featured-heading">Answers made for real decisions</h2></div><div class="guide-grid" data-guide-grid>${featured}</div></section>
  <section class="truth-panel"><div><p class="eyebrow">A guide by Pawsome3D</p><h2>Helpful first. Product fit second.</h2></div><p>FurryFriend explains the decision before suggesting a product. Animation, prepaid gifts, and historical collections stay labeled as concepts until their exact live flows are proven.</p><a href="/editorial-policy/">Read the editorial policy</a></section>`;
  return page({
    title: "FurryFriend — Practical Pet Keepsake Guides",
    description: "Kind, practical answers about pet memorials, custom 3D keepsakes, photo preparation, thoughtful gifts, and creative pet avatars.",
    pathname: "/",
    body,
    structuredData: [
      { "@context": "https://schema.org", "@type": "Organization", name: "FurryFriend", url: siteUrl, parentOrganization: { "@type": "Organization", name: "Pawsome3D", url: "https://pawsome3d.com" } },
      { "@context": "https://schema.org", "@type": "WebSite", name: "FurryFriend", url: siteUrl, description: "Practical pet keepsake guides by Pawsome3D." }
    ]
  });
}

function buildGuides() {
  const body = `<section class="page-hero compact"><p class="eyebrow">FurryFriend guides</p><h1>Begin with the question in front of you.</h1><p class="lede">Browse clear, decision-focused previews. Each guide is held from search indexing until a human records final approval.</p></section>
  <section class="section-shell"><label for="guide-search">Filter by topic or question</label><input id="guide-search" data-guide-search type="search" placeholder="Search all guide previews" autocomplete="off"><p class="search-status" data-search-status aria-live="polite"></p><div class="guide-grid" data-guide-grid>${articles.map(card).join("")}</div></section>`;
  return page({ title: "Pet Keepsake Guides | FurryFriend", description: "Browse practical guides about memorials, photo-to-3D creation, unique dog gifts, and historically inspired pet portraits.", pathname: "/guides/", body, active: "guides" });
}

function buildArticle(article) {
  const job = jobBySlug.get(article.slug);
  if (!job) throw new Error(`Missing editorial job for ${article.slug}`);
  const approved = job.state === "published" && job.approvedBy && job.approvedAt;
  const articlePath = `/guides/${article.slug}/`;
  const sections = article.sections.map((section) => `<section><h2>${esc(section.heading)}</h2>${section.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</section>`).join("");
  const body = `<article class="article-shell">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/guides/">Guides</a><span aria-hidden="true">/</span><span>${esc(article.topic)}</span></nav>
    ${approved ? "" : '<aside class="preview-banner"><strong>Editorial preview</strong><span>This page is complete enough to review, but is held from search indexing until a human publish approval is recorded.</span></aside>'}
    <header class="article-header"><p class="eyebrow">${esc(article.topic)} · ${article.readMinutes} minute read</p><h1>${esc(article.title)}</h1><p class="lede">${esc(article.dek)}</p><div class="byline"><span>By FurryFriend Editorial</span><span>Product review: pending</span><time datetime="${updated}">Updated July 31, 2026</time></div></header>
    <img class="article-hero" src="${article.image}" alt="${esc(article.imageAlt)}" width="1024" height="640">
    ${article.notice ? `<aside class="fact-note"><strong>Before you begin</strong><p>${esc(article.notice)}</p></aside>` : ""}
    <section class="takeaways"><h2>Key takeaways</h2><ul>${article.takeaways.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>
    <div class="article-content">${sections}
      <section class="checklist"><h2>A quick decision checklist</h2><ul>${article.checklist.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>
      <aside class="article-cta"><div><p class="eyebrow">When Pawsome3D fits</p><h2>${esc(article.cta.label)}</h2><p>${esc(article.cta.note)}</p></div><a class="button primary" href="${article.cta.href}">${esc(article.cta.label)}</a></aside>
      <section class="source-notes"><h2>Source and review notes</h2><p>This preview uses current first-party Pawsome3D entry points and the product-truth gates recorded in the FurryFriend editorial brief. It makes no delivery-time, price, material, warranty, or guaranteed-likeness claim.</p><p><a href="/editorial-policy/">See how AI assistance, evidence, corrections, and human approval work.</a></p></section>
    </div>
  </article>`;
  return page({
    title: `${article.title} | FurryFriend`,
    description: article.metaDescription,
    pathname: articlePath,
    body,
    active: "guides",
    noindex: !approved,
    structuredData: [{
      "@context": "https://schema.org",
      "@graph": [
        ...(approved ? [{ "@type": "Article", headline: article.title, description: article.metaDescription, datePublished: job.approvedAt.slice(0, 10), dateModified: updated, author: { "@type": "Organization", name: "FurryFriend Editorial" }, reviewedBy: { "@type": "Person", name: job.approvedBy }, publisher: { "@type": "Organization", name: "Pawsome3D", url: "https://pawsome3d.com" }, mainEntityOfPage: `${siteUrl}${articlePath}` }] : []),
        { "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: siteUrl },
          { "@type": "ListItem", position: 2, name: "Guides", item: `${siteUrl}/guides/` },
          { "@type": "ListItem", position: 3, name: article.title, item: `${siteUrl}${articlePath}` }
        ] }
      ]
    }]
  });
}

function infoPage({ pathname, title, description, active, content }) {
  return page({ title: `${title} | FurryFriend`, description, pathname, active, body: `<section class="page-hero compact"><p class="eyebrow">FurryFriend</p><h1>${esc(title)}</h1><p class="lede">${esc(description)}</p></section><article class="prose-page">${content}</article>` });
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, "public"), dist, { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
for (const name of ["pawsome-logo.png", "furball3d.jpg", "fidostyles.jpg", "pawprints.png", "animation-studio.png"]) {
  fs.copyFileSync(path.join(root, "..", "public", "brand", name), path.join(dist, "assets", name));
}

writeRoute("/", buildHome());
writeRoute("/guides/", buildGuides());
for (const article of articles) writeRoute(`/guides/${article.slug}/`, buildArticle(article));

writeRoute("/about/", infoPage({ pathname: "/about/", title: "About FurryFriend", active: "about", description: "A kind, practical pet-keepsake guide created by Pawsome3D.", content: `<h2>Our purpose</h2><p>FurryFriend helps pet parents make thoughtful choices about photos, memorials, digital models, physical keepsakes, and gifts. We lead with the answer and recommend Pawsome3D only when it is genuinely relevant.</p><h2>What this site is not</h2><p>It is not a substitute for veterinary or mental-health care. It is not a review farm, a city-page network, or a machine that publishes every generated draft. We do not invent customers, experts, results, prices, or product availability.</p><h2>Ownership</h2><p>FurryFriend is operated as a Pawsome3D educational guide. Commercial relationships are disclosed where a product link appears.</p>` }));

writeRoute("/editorial-policy/", infoPage({ pathname: "/editorial-policy/", title: "Editorial policy", active: "policy", description: "How FurryFriend uses evidence, AI assistance, product-truth gates, and human approval.", content: `<h2>Answer first</h2><p>Every guide begins with a real customer question and a practical decision. Search phrases help us understand language; they do not justify repetitive or thin pages.</p><h2>The SALTI-style review cascade</h2><ol><li>Qualify the question and sensitivity.</li><li>Collect sources and record claim-level evidence.</li><li>Plan an answer with explicit unknowns.</li><li>Check whether Pawsome3D is relevant.</li><li>Draft only from approved evidence.</li><li>Review structure and search clarity.</li><li>Run fact, safety, originality, and grief-sensitivity checks.</li><li>Require a named human publish approval.</li><li>Monitor corrections and stale claims.</li></ol><h2>Current product-truth gates</h2><p>Animation remains a concept until the customer workflow passes production acceptance. “Send a Pawprint” is not described as a prepaid entitlement or reward. Historical roles are creative concepts, not an available limited-edition collection.</p><h2>AI assistance</h2><p>AI may help organize questions, outlines, and drafts. It cannot approve a product claim or publish a page. Drafts remain visible to editors with their evidence and warnings.</p><h2>Corrections</h2><p>Until a dedicated correction form is configured, report a correction through the contact route on Pawsome3D and include the FurryFriend page title. A correction is reviewed before the public page changes.</p>` }));

writeRoute("/privacy/", infoPage({ pathname: "/privacy/", title: "Privacy", description: "Plain-language privacy information for FurryFriend readers.", content: `<h2>Browsing</h2><p>This first version uses no advertising tracker and no third-party analytics script. Standard hosting logs may record technical request information needed for security and reliability.</p><h2>Questions and photos</h2><p>The public question-intake feature is not enabled yet. Do not send pet photos through this guide site. When question intake is added, it will explain retention, rate limits, and editorial use before submission.</p><h2>Product links</h2><p>Links to Pawsome3D take you to a separate product service with its own account and privacy terms.</p>` }));

writeRoute("/terms/", infoPage({ pathname: "/terms/", title: "Terms", description: "The basic terms for using FurryFriend’s educational guides.", content: `<h2>Educational information</h2><p>FurryFriend provides general educational content. It does not provide veterinary, mental-health, legal, or financial advice.</p><h2>Product details</h2><p>Prices, availability, delivery timing, materials, warranties, and purchase terms must be verified on the current product or checkout page. An article does not override those terms.</p><h2>Respectful use</h2><p>Do not misuse the site, attempt unauthorized access, or submit content you do not have permission to share.</p>` }));

const notFound = page({ title: "Page not found | FurryFriend", description: "That FurryFriend page could not be found.", pathname: "/404.html", noindex: true, body: `<section class="not-found"><p class="eyebrow">404</p><h1>That trail ends here.</h1><p>The guide may have moved, or the address may be incomplete.</p><a class="button primary" href="/guides/">Browse all guides</a></section>` });
fs.writeFileSync(path.join(dist, "404.html"), notFound);

const indexable = ["/", "/guides/", "/about/", "/editorial-policy/", "/privacy/", "/terms/"];
for (const article of articles) {
  const job = jobBySlug.get(article.slug);
  if (job?.state === "published" && job.approvedBy && job.approvedAt) indexable.push(`/guides/${article.slug}/`);
}
fs.writeFileSync(path.join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
fs.writeFileSync(path.join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable.map((route) => `\n  <url><loc>${siteUrl}${route}</loc><lastmod>${updated}</lastmod></url>`).join("")}\n</urlset>\n`);
fs.writeFileSync(path.join(dist, "build-manifest.json"), `${JSON.stringify({ site: "furryfriend.cc", builtAt: new Date().toISOString(), articleCount: articles.length, publishedArticleCount: indexable.length - 6, editorialSchemaVersion: ledger.schemaVersion }, null, 2)}\n`);

console.log(`FurryFriend build complete: ${articles.length} editorial previews, ${indexable.length} indexable routes`);
