// Keep section labels independent of model-generated notes. Prioritize shallow headings
// so a long run of subsections cannot evict a later appendix at the parent level.
function buildOutline(rows) {
  if (!Array.isArray(rows)) return;
  const headings = [];
  const levels = [...new Set(rows.map(row => row?.level))]
    .filter(level => Number.isInteger(level) && level >= 1 && level <= 6)
    .sort((a, b) => a - b);
  let bytes = 0;
  let partial = false;
  for (const level of levels.slice(0, levels[0] === 1 ? 2 : 1)) {
    for (const [order, row] of rows.entries()) {
      if (row?.level !== level || typeof row.title !== 'string') continue;
      const title = row.title.replace(/\s+/gu, ' ').trim();
      if (!title) continue;
      const size = Buffer.byteLength(title);
      if (size > 512 || bytes + size > 4096 || headings.length >= 96) {
        partial = true;
        continue;
      }
      bytes += size;
      headings.push({ level, title, order });
    }
  }
  if (headings.length) return {
    headings: headings.sort((a, b) => a.order - b.order).map(({ level, title }) => ({ level, title })),
    partial,
  };
}
module.exports = { buildOutline };
