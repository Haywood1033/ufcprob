// lib/html.js — just enough HTML reading for UFCStats' server-rendered tables, with no parser
// dependency: rows by class, cells, the <p> lines inside a cell, links, and entity decoding.
// UFCStats markup is regular (same templates since ~2015), so this stays small.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', eacute: 'é', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', atilde: 'ã', otilde: 'õ', ouml: 'ö', uuml: 'ü', auml: 'ä' };
const decode = s => String(s || '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e.toLowerCase()] ?? m;
});
// Block-level tags become spaces; inline tags (a, b, i, span) vanish so words stay whole.
const text = s => decode(String(s || '').replace(/<\/?(p|br|div|li|td|tr|th|ul|table)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// Every <tr ...>...</tr> whose opening tag matches `attrRe` (e.g. /b-fight-details__table-row/).
function rows(html, attrRe = /./) {
  const out = [];
  const re = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) if (attrRe.test(m[1])) out.push({ attrs: m[1], html: m[2] });
  return out;
}
const cells = rowHtml => [...String(rowHtml).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
const lines = cellHtml => {
  const ps = [...String(cellHtml).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => text(m[1]));
  return ps.length ? ps : [text(cellHtml)];
};
const links = html => [...String(html).matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: m[1], text: text(m[2]) }));
const attr = (attrs, name) => (String(attrs).match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || null;
const idFrom = (href, kind) => (String(href || '').match(new RegExp(`${kind}/([0-9a-f]+)`, 'i')) || [])[1] || null;

module.exports = { decode, text, rows, cells, lines, links, attr, idFrom };
