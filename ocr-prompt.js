// OCR prompt for the box-photo extraction flow.
//
// Kept in its own file so it's easy to edit / iterate on without touching
// server.js. The prompt is built per product type (disposable vs juice)
// because the known brand pools differ between the two. The brand pool is
// passed in from server.js (queried from the database) so it always stays in
// sync with the brands the shop actually carries — no more hardcoding.
function buildOcrPrompt(type, brandNames) {
  const label = type === "disposable" ? "disposable vape" : "vape juice";
  const poolLabel = type === "disposable" ? "disposables" : "juices";
  const brands = (brandNames || []).join(", ");
  const brandLine = brands
    ? `Brand names that exist for ${poolLabel} are: ${brands}. `
    : "";
  // The Freeze/Iced variant rule only applies to juice brands.
  const freezeLine =
    type === "juice"
      ? 'If the box has the word "Freeze" or "Iced" anywhere on it, it is the "Freeze" or "Iced" variant of that juice brand. '
      : "";
  return (
    `You are reading the front of a ${label} product box. ` +
    `Extract the brand name, flavor name, and nicotine strength. ` +
    `Reply with ONLY a JSON object, no other text: ` +
    `{"brand": "...", "flavor": "...", "mg": <number>}. ` +
    brandLine +
    "Flavor names should not be in all caps. Only the first letter of each word in the flavor names should be capitalized. " +
    freezeLine +
    `mg is nicotine in mg/ml. ` +
    'The numbers for mg might be stylized'
    `Use null for any field you cannot read.`
  );
}

module.exports = { buildOcrPrompt };
