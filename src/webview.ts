// pattern: Functional Core
// Renders a static HTML view of a case repo: the docket header plus every entry
// in order, with document links and content-hash badges.

import type { DocketEntryRecord, DocketRecord } from "./map.js";

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

const CSS = `:root{--fg:#1a1a1a;--mut:#666;--line:#e6e6e6;--accent:#7a2e2e}
*{box-sizing:border-box}body{font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);max-width:920px;margin:0 auto;padding:2rem}
header{border-bottom:2px solid var(--accent);padding-bottom:1rem;margin-bottom:1.5rem}
h1{font-size:1.6rem;margin:0 0 .3rem}.meta{color:var(--mut);margin:.2rem 0}.id{font-size:.8rem}.prov{font-size:.85rem;color:var(--mut)}
table{border-collapse:collapse;width:100%}th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);border-bottom:1px solid var(--line);padding:.4rem}
td{vertical-align:top;border-bottom:1px solid var(--line);padding:.6rem .4rem}
.num{font-variant-numeric:tabular-nums;color:var(--mut);width:3rem}.date{white-space:nowrap;color:var(--mut);width:6.5rem;font-size:.85rem}
.desc{margin:0}ul.docs{margin:.4rem 0 0;padding-left:1.1rem;font-size:.9rem}
code.cid{background:#f1e9e9;color:var(--accent);padding:0 .3rem;border-radius:3px;font-size:.74rem}
.nohash{color:#b0b0b0;font-size:.74rem}
footer{margin-top:2rem;color:var(--mut);font-size:.8rem;border-top:1px solid var(--line);padding-top:1rem}`;

interface CaseViewMeta {
  did?: string;
  handle?: string;
}

export function renderCaseHtml(
  docket: DocketRecord,
  entries: DocketEntryRecord[],
  meta: CaseViewMeta = {},
): string {
  const rows = entries
    .map((e) => {
      const docs = (e.documents ?? [])
        .map((d) => {
          const cid = d.contentCid
            ? `<code class="cid" title="content hash (CIDv1)">${esc(d.contentCid.slice(0, 18))}…</code>`
            : `<span class="nohash">unhashed</span>`;
          const pages = d.pageCount ? ` (${d.pageCount}pp)` : "";
          return `<li><a href="${esc(d.sourceUrl)}">Doc ${d.documentNumber ?? ""}${pages}</a> ${cid}</li>`;
        })
        .join("");
      const num = e.entryNumber != null ? String(e.entryNumber) : "·";
      return `<tr><td class="num">${num}</td><td class="date">${esc(e.dateFiled.slice(0, 10))}</td><td><p class="desc">${esc(e.description)}</p>${docs ? `<ul class="docs">${docs}</ul>` : ""}</td></tr>`;
    })
    .join("\n");
  const idline = [
    meta.handle ? `@${esc(meta.handle)}` : "",
    meta.did ? `<code>${esc(meta.did)}</code>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(docket.caseName)} — Cranch</title><style>${CSS}</style></head><body>
<header>
<h1>${esc(docket.caseName)}</h1>
<p class="meta">${esc(docket.docketNumber)} · ${esc(docket.court)} · filed ${esc((docket.dateFiled ?? "").slice(0, 10))} · Judge ${esc(docket.assignedJudge ?? "—")}</p>
${idline ? `<p class="id">${idline}</p>` : ""}
<p class="prov">Mirrored from <a href="${esc(docket.source.url ?? "#")}">CourtListener</a> · observed ${esc(docket.source.retrievedAt.slice(0, 10))} · ${entries.length} entries</p>
</header>
<table><thead><tr><th>#</th><th>Filed</th><th>Entry</th></tr></thead><tbody>
${rows}
</tbody></table>
<footer>Cranch — court dockets as AT Protocol repos. Each docket entry is a signed, content-addressed record; the case is a single repo you can <em>follow</em> and <em>browse</em>.</footer>
</body></html>`;
}
