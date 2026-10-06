// OCR prompt for the box-photo extraction flow.
//
// Kept in its own file so it's easy to edit / iterate on without touching
// server.js. The prompt is built per product type (disposable vs juice)
// because the known brand pools differ between the two.
function buildOcrPrompt(type) {
  const label = type === "disposable" ? "disposable vape" : "vape juice";
  return (
    `You are reading the front of a ${label} product box. ` +
    "The box is either for a disposable vape or vape juice" +
    `Extract the brand name, flavor name, and nicotine strength. ` +
    `Reply with ONLY a JSON object, no other text: ` +
    `{"brand": "...", "flavor": "...", "mg": <number>}. ` +
    "Brand names that exist for disposables are: Geek Bar Pulse, Geek Bar Pulse X, Geek Bar Pulse X2, Foger Pod, Foger Kit, Flum UT Bar, Flum Mello Pro, Foger Bit, Movkin Pod, Movkin Kit." +
    "Flavor names should not be in all caps. Only the first letter of each word should be capatalized." +
    "Brand names that exist for juices are: Juice Head, Juice Head (Freeze), Reds, Reds (Iced), The One, Pod Juice, Pod Juice (Freeze), Cloud Nurdz, and Cloud Nurdz (Freeze)" +
    'If the box has the word "Freeze" or "Iced" anywhere on it, it is the "Freeze" or "Iced" variant of that juice brand.' +
    `mg is nicotine in mg/ml. ` +
    `Use null for any field you cannot read.`
  );
}

module.exports = { buildOcrPrompt };
