const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector("#site-nav");

toggle?.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(open));
  nav?.setAttribute("data-open", String(open));
});

nav?.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return;
  toggle?.setAttribute("aria-expanded", "false");
  nav.removeAttribute("data-open");
});

const search = document.querySelector("[data-guide-search]");
const cards = [...document.querySelectorAll("[data-guide-card]")];
const status = document.querySelector("[data-search-status]");

function filterGuides() {
  if (!(search instanceof HTMLInputElement)) return;
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  for (const card of cards) {
    const matches = !query || (card.getAttribute("data-search") || "").includes(query);
    card.hidden = !matches;
    if (matches) visible += 1;
  }
  if (status) status.textContent = query ? `${visible} guide${visible === 1 ? "" : "s"} found.` : "";
}

search?.addEventListener("input", filterGuides);
