// Returns CWorkshop's board catalogue as a compact list.
// CWorkshop has no public API: this reads the same search endpoint their
// online cutlist tool uses. Results are cached at Vercel's edge for a day,
// so CWorkshop is called at most a handful of times per day.

const BASE = "https://app.cworkshop.co.uk/decors/search/cutting-list.json";
const PAGE = 40; // the endpoint returns at most 40 decors per category per call

async function search(params) {
  const qs = new URLSearchParams({ phrase: "", offset: "0", limit: String(PAGE), categoryId: "", projectId: "0", ...params });
  const r = await fetch(`${BASE}?${qs}`, {
    headers: { "Accept": "application/json", "User-Agent": "cutlist-converter (Kelsey Smith Furniture)" },
  });
  if (!r.ok) throw new Error(`CWorkshop returned ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  try {
    const first = await search({});
    const categories = (first.items || []).map(c => ({ id: c.id, name: c.name }));
    const decors = [];

    await Promise.all(categories.map(async cat => {
      for (let offset = 0; offset < 5000; offset += PAGE) {
        const page = await search({ categoryId: String(cat.id), offset: String(offset) });
        const item = (page.items || []).find(i => i.id === cat.id);
        if (!item || !item.decors?.length) break;
        for (const d of item.decors) {
          decors.push({
            code: d.code,
            name: d.name,
            brand: cat.name,
            core: d.core?.name || "",
            length: d.length,
            width: d.width,
          });
        }
        if (!item.exceeded) break;
      }
    }));

    // De-duplicate by code (a decor can appear in more than one category)
    const seen = new Set();
    const unique = decors.filter(d => (seen.has(d.code) ? false : (seen.add(d.code), true)));
    unique.sort((a, b) => a.brand.localeCompare(b.brand) || a.code.localeCompare(b.code));

    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ fetchedAt: new Date().toISOString(), count: unique.length, decors: unique });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Couldn't load the CWorkshop catalogue.", detail: String(err.message || err) });
  }
}
