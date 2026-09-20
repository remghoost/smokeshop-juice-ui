# smokeshop-juice-ui

A lightweight internal web tool for managing a **printable vape juice menu** for a smoke shop. Staff manage the juice list (brands, flavors, nicotine strength, stock, barcodes) in an admin panel, then print a clean paper menu.

## Tech Stack

- **Node.js** + **Express** (server-rendered, no frontend framework)
- **SQLite** via Node's built-in `node:sqlite` (no native dependency) — single-file database at `data/menu.db`
- **EJS** templates for the admin and print pages
- Plain vanilla JS/CSS for the client

## Running

```bash
npm install
npm start        # serves on http://localhost:3000 (or $PORT)
```

The database file and tables are created automatically on first start.

## Project Structure

| File | Purpose |
|---|---|
| `server.js` | Express app and all routes (admin, print, stock, barcode scan, sales log/undo, sales report, reorder). |
| `db.js` | `node:sqlite` helpers (`all`/`get`/`run`). Creates tables on startup and runs lightweight column migrations for older databases. |
| `data/menu.db` | SQLite database (auto-created). Holds `brands`, `juices`, `sales`, and `settings`. |
| `views/admin.ejs` | Admin panel page: Juices/Disposables type tabs, add-product form, sortable table with stock + barcode controls, and a right-side "Today's Sales" panel with per-sale Undo. |
| `views/print.ejs` | Printable juice menu page: active juices grouped by mg → brand → flavors. |
| `views/print-disposables.ejs` | Printable disposable menu page: active disposables grouped by brand → flavors (no mg grouping — all disposables share one mg). |
| `views/sales.ejs` | Sales report page: Daily (per-juice + detailed log), Last 7 Days (top sellers + daily totals), and Lifetime (all-time top sellers) tabs. |
| `views/reorder.ejs` | Reorder page: juices at/below a configurable threshold, with the threshold editable in the UI and a per-row **Ordered** toggle (greys the row out and sinks it to the bottom). |
| `public/js/admin.js` | Client logic: table sorting, stock +/-, barcode scanner handling, scan-mode toggle, and the Today's Sales panel (load/prepend/undo). |
| `public/js/theme.js` | Dark-mode toggle (persists the choice in a `theme` cookie) and the mobile hamburger nav. The theme class itself is applied by a small inline `<head>` script so there's no flash of the wrong theme. |
| `public/css/base.css` | Shared theme variables (light + `html.dark` palettes), the sticky top navigation, and the theme-toggle button. Loaded on every page before the page-specific stylesheet. |
| `public/css/admin.css` | Admin panel + report-page styling (stock controls, barcode column, scan toast, sales panel, report tabs). All colors reference the theme variables from `base.css`; includes responsive "card" tables for phones. |
| `public/css/print.css` | Print-optimized styling (2-column, Times New Roman, `@media print`). Theme-aware on screen, forced white/black when printing. |
| `views/partials/nav.ejs` | Shared top-nav partial (brand, page links with active highlighting, scan-mode button on the admin page, theme toggle, mobile hamburger). Included by every page. |
| `views/index.ejs`, `public/style.css` | Empty/unused legacy files. |

## Database Schema

- **brands** — `id`, `name` (unique), `type` (`'juice'` or `'disposable'` — separate brand pools)
- **juices** — `id`, `brand_id` (FK → brands), `flavor`, `mg` (nicotine strength), `type` (`'juice'` or `'disposable'`), `active` (0/1), `stock` (int, default 0), `barcode` (text, nullable), `ordered` (0/1, default 0 — "already ordered" flag for the reorder list)
- **sales** — `id`, `juice_id` (FK → juices), `barcode`, `sold_at` (ISO timestamp, UTC), `sold_date` (local `YYYY-MM-DD`, for daily grouping), `voided` (0/1, set when a sale is undone)
- **settings** — `key` (primary), `value`. Currently holds `reorder_threshold` (default `2`) and `disposable_mg` (default `50`, the fixed nicotine strength for all disposables).

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Admin panel — `?type=juice` (default) or `?type=disposable`. Brands + products of that type (active first), add-product form, sortable table. |
| `POST /add-brand` | Add a brand (JSON `{ name, type }`); `type` is `'juice'` or `'disposable'` (separate pools). Rejects duplicates. |
| `POST /add-juice` | Add a juice or disposable (form: brand, flavor, mg, optional barcode, type). For disposables the mg is ignored and the fixed `disposable_mg` setting is used. Duplicate-checked within the same type. New products start **disabled** with stock 0. |
| `POST /update-juice/:id` | Edit a product's brand / flavor / mg / barcode (same form as add, in edit mode). Duplicate-checked excluding the product itself. Stock and active status are preserved. |
| `POST /toggle-juice/:id` | Flip a juice's `active` flag. |
| `POST /stock/:id` | Adjust stock: `{ delta: ±n }` or `{ stock: n }`. Auto-disables at 0, re-enables above 0. |
| `POST /juice/:id/barcode` | Assign/update a barcode for a juice. |
| `POST /scan/lookup` | Look up a barcode without selling (used by Input Mode). |
| `POST /scan` | Sell one unit of the matching juice (Sell Mode). Auto-disables when stock hits 0. Also logs the sale to the `sales` table and returns the new sale in the response. |
| `GET /api/sales/today` | Today's sales (newest first) with a running total — feeds the admin panel's right-side "Today's Sales" panel. |
| `POST /sales/:id/undo` | Undo a sale: restores 1 to the juice's stock (re-enabling it if it had auto-disabled) and marks the log entry `voided`. |
| `GET /sales` | Sales report page. `?date=YYYY-MM-DD` (defaults to today) and `?type=all|juice|disposable` (defaults to all). Daily / Last 7 Days / Lifetime tabs. |
| `GET /reorder` | Reorder page: juices at/below the `reorder_threshold` setting. Already-ordered items are listed last. |
| `POST /juice/:id/toggle-ordered` | Flip a juice's `ordered` flag (reorder list: mark as ordered / undo). |
| `POST /settings/reorder-threshold` | Update the reorder threshold (JSON `{ value }`). |
| `GET /print` | Printable menu of active **juices** only (grouped by mg → brand). |
| `GET /print/disposables` | Printable menu of active **disposables** only (grouped by brand → flavors). |

## Functionality

### Admin Panel (`/`)
- **Type tabs** — `Juices` (default) and `Disposables` switch which product list, brand pool, and add-form is shown (`/?type=disposable`). The two pools are fully independent.
- Add brands (via the `+` button) and products (brand / flavor / mg / optional barcode). For disposables the MG field is hidden (all disposables share a fixed mg, stored in the `disposable_mg` setting, default `50`).
- Sortable table (Brand, Flavor, MG, Stock columns) — click a header to sort **descending**, click again for **ascending**. Inactive products have no checkbox; they're simply greyed out (see Auto Disable / Re-enable).
- **Stock controls** per product: `−` / `+` buttons and an editable number field. Selling one = press `−`.
- **Barcode column** per product: shows `Yes` if a barcode is set, or an `Add` button to assign one (same behavior as the old `Scan` button).
- **Responsive layout** — the page is wider and the table scrolls horizontally if needed, so the right-side Today's Sales panel never overlaps the table. On narrower windows the panel stacks below the table instead of sitting beside it.
- **Edit** per product: reuses the top add-form in "edit" mode — the form pre-fills with the row's brand / flavor / mg / barcode, the submit button becomes `Update`, and a `Cancel` button appears. Submitting posts to `POST /update-juice/:id`; stock and active status are unchanged.
- **Today's Sales panel** (right side): a running tally of today's barcode-scan sales, newest first, each with an **Undo** button. New sales appear instantly as they're scanned; Undo restores the stock and voids the entry. A link jumps to the full Sales report.

### Barcode Scanning
USB barcode scanners act as keyboards (they type the code fast and hit Enter), so no drivers or special APIs are needed. The client detects a **burst of fast keystrokes** (≥4 chars, <100ms apart, ending in Enter) and treats it as a scan.

Two modes, toggled by the button in the nav (persisted in `sessionStorage`):

- **Sell Mode (default)** — scanning a barcode sells one unit: stock decrements, the number updates in place, the sale is logged to the `sales` table and added to the Today's Sales panel, and a toast confirms. Unknown barcodes and disabled juices show an error toast.
- **Input Mode** — scanning a **new** barcode fills the Barcode field in the add form (then pick brand/flavor/mg and submit). Scanning a barcode that's **already in the system** adds 1 to its stock instead. Clicking `Add` on a row (in the Barcode column) assigns the next scan to that specific juice.

### Auto Disable / Re-enable
- Selling the **last unit** (or setting stock to 0) sets `active = 0`, dropping the juice from the printed menu. The row dims in place.
- Adding stock back above 0 (scan in Input Mode, `+`, or typing a number) re-enables it.
- Newly added juices start disabled (stock 0) until the first bottle is scanned in.

### Print Menu (`/print` and `/print/disposables`)
- **`/print`** — lists only **active** juices, grouped by mg section → brand → bulleted flavor list. 2-column layout, Times New Roman, with a Print button hidden via `@media print`.
- **`/print/disposables`** — lists only **active** disposables, grouped by brand → bulleted flavor list (no mg section, since all disposables share one mg). Same 2-column / Times New Roman styling.

### Sales Logging & Undo
Every **barcode-scan sale** (Sell Mode) is written to the `sales` table with a timestamp and a local date. The admin panel's right-side **Today's Sales** panel shows the running tally for the day, newest first, with a per-sale **Undo** button.

- **Undo** (`POST /sales/:id/undo`) restores 1 to the juice's stock, re-enables it if it had auto-disabled, and marks the log entry `voided` (so it no longer counts toward tallies). The panel item dims and shows "undone".
- Only barcode scans are logged — manual `−`/`+` stock adjustments are not, so the log reflects actual register sales.
- Undo is the safety net for accidental double-scans: the sale commits instantly (fast happy path) and can be reversed if needed.

### Sales Report (`/sales`)
A report page with a **type filter** (All / Juices / Disposables) and three tabs (voided sales are excluded from all counts):

- **Daily** — pick any date (defaults to today). Per-product quantities sold that day, plus a detailed timestamped log (including undone entries, marked).
- **Last 7 Days** — top products by quantity over the trailing 7 days, plus per-day unit totals for spotting trends.
- **Lifetime** — all-time top sellers, ordered by quantity.

### Reorder (`/reorder`)
Lists every juice whose stock is **at or below** a configurable threshold, so you can see what needs reordering. The threshold is editable in the UI (stored in the `settings` table as `reorder_threshold`, default `2`) and applies immediately.

- **Ordered toggle** — each row has an **Ordered** button. Clicking it sets the juice's `ordered` flag (`POST /juice/:id/toggle-ordered`), which greys the row out (like an out-of-stock row) and sinks it to the bottom of the list so you can work through the list top-down. The button becomes **Undo** to reverse it (e.g. if you misclicked). The flag is independent of stock/active status — it's just a "I've already placed this order" marker.

### Notifications
Scan/stock feedback appears as a **fixed-position toast** in the top-right (success / error / warn / info) so it never shifts the page layout.

### Appearance & Navigation
- **Dark mode** — a 🌙/☀️ toggle in the top nav switches between a light and a dark theme. The choice is saved in a `theme` cookie (1-year expiry) and applied by a small inline `<head>` script before paint, so there's no flash of the wrong theme on load. All colors are driven by CSS variables in `public/css/base.css` (`:root` for light, `html.dark` for dark), so every page — including the print pages — follows the theme. When actually printing, the print pages force a white background / black text regardless of the saved theme.
- **Top navigation** — every page shares a sticky top nav (`views/partials/nav.ejs`) with a "Vape Menu" brand link, the page links (Admin / Print Menu / Print Disposables / Sales / Reorder) with the current page highlighted, the Sell/Input scan-mode button (admin page only), and the theme toggle. On narrow screens the links collapse behind a hamburger (☰) button so they never wrap to a second row.
- **Mobile-friendly** — on phones (≤640px) the data tables reflow into stacked "cards": each row becomes a card and each cell shows its column name (via a `data-label` attribute), so nothing — including the reorder **Ordered** button — is pushed off-screen. The add-product form stacks to a single column, the Today's Sales panel drops below the table, and buttons get larger (≥44px) touch targets.
- **Accessibility** — visible keyboard focus outlines on all interactive elements, ARIA labels on the nav/theme/scan buttons, and `rem`-based sizing so the whole UI scales with the browser's font-size setting (useful for low-vision users). A `prefers-reduced-motion` media query disables animations for users who ask for it.

---

## ⚠️ Note for LLMs / Future Contributors

**When you add or change functionality in this repo, you MUST:**

1. Update the relevant sections above (Project Structure, Database Schema, Routes, Functionality) to reflect the change.
2. Append a new entry to the **Change Log** below, newest first, with a short date and a concise description of what changed and why.
3. Do not attempt to run the server and check functionality. You only have access to one terminal, so you cannot do two things at once.

Keep the README accurate and current — it is the primary reference for anyone (human or AI) picking up this project.

---

## Change Log

- **2026-09-09** — Replaced the native `sqlite3` package with Node's built-in `node:sqlite` (`DatabaseSync`). The native prebuilt binary was compiled against glibc 2.38 and failed to load on Ubuntu 22.04 (glibc 2.35) with `GLIBC_2.38 not found`. `node:sqlite` is built into Node (unflagged since v23.4, stable in v24), so there's no native binary, no glibc/build-toolchain dependency, and it works on any OS/arch. `db.js` was rewritten around the synchronous `DatabaseSync` API while keeping the same `all`/`get`/`run` helper interface, so `server.js` is unchanged. Removed `sqlite3` from `package.json` (and its transitive deps) from the lockfile.

- **2026-09-08** — Fixed a broken EJS include in `views/partials/nav.ejs`. The partial's doc comment contained a live `<%- include('partials/nav', ...) %>` tag; EJS processes `<% %>` tags even inside HTML comments, so rendering the nav triggered a recursive include of `partials/nav` resolved relative to `views/partials/` (→ `views/partials/partials/nav.ejs`, which doesn't exist), throwing "Could not find the include file". Reworded the comment to describe the include without a live EJS tag. All five nav-including views (admin, print, print-disposables, sales, reorder) now render.

- **2026-09-07** — Dark mode, shared top nav, and mobile/accessibility pass. Added a 🌙/☀️ theme toggle (top-right of the nav) that saves the choice in a `theme` cookie (1-year expiry); the class is applied by a small inline `<head>` script so there's no flash of the wrong theme. All colors now come from CSS variables in a new `public/css/base.css` (`:root` light / `html.dark` dark), loaded on every page before the page-specific stylesheet, so the admin, report, and print pages all follow the theme (print pages force white/black when actually printing). Replaced the per-page inline nav with a shared sticky `views/partials/nav.ejs` (brand + page links with active highlighting + scan-mode button on admin + theme toggle) that collapses to a hamburger on narrow screens so the buttons no longer wrap to a second row. New `public/js/theme.js` handles the toggle + hamburger. On phones (≤640px) the data tables reflow into stacked "cards" (each cell shows its column name via a `data-label` attribute) so nothing — including the reorder **Ordered** button — is pushed off-screen; the add form stacks to one column and buttons get ≥44px touch targets. Accessibility: visible keyboard focus outlines, ARIA labels on the nav/theme/scan buttons, `rem`-based sizing so the UI scales with the browser font size, and a `prefers-reduced-motion` query.

- **2026-09-07** — Reorder list "Ordered" toggle. New `ordered` column on `juices` (0/1, default 0, with a migration for existing DBs). Each reorder row gains an **Ordered** button (`POST /juice/:id/toggle-ordered`) that sets the flag, greys the row out (like an out-of-stock row), and sinks it to the bottom of the list so you can work through the list top-down; the button becomes **Undo** to reverse a misclick. The `/reorder` query now selects `ordered` and sorts ordered items last. The flag is independent of stock/active status — it's just a "I've already placed this order" marker.

- **2026-09-07** — Admin panel table cleanup + responsive layout. Removed the leading **Active** checkbox column (inactive products are still greyed out; Enable/Disable stays in Actions). Simplified the **Barcode** column to show `Yes` when a barcode is set or an `Add` button when it isn't (same behavior as the old `Scan` button). Sorting now starts **descending** on first click (click again for ascending) and the sort arrow is rendered via CSS. Made the layout adapt to window size: wider page, the table scrolls horizontally instead of being clipped, and the Today's Sales panel stacks below the table on narrower windows so it no longer overlaps the table.

- **2026-09-07** — Added disposable vape support: `type` column on `brands` and `juices` (separate brand pools) and a `disposable_mg` setting (default `50`). Admin panel gains Juices/Disposables type tabs (`/?type=disposable`); disposables use a fixed mg (hidden in the add form). New `GET /print/disposables` page (grouped by brand → flavors). Sales report gains an All/Juices/Disposables type filter (`?type=`). `POST /add-brand`, `POST /add-juice`, and `POST /update-juice/:id` now accept a `type`.

- **2026-09-07** — Added sales logging + undo, a sales report, and a reorder list. New `sales` table (barcode-scan sales only) and `settings` table (`reorder_threshold`, default 2). `POST /scan` now logs each sale; new `GET /api/sales/today` and `POST /sales/:id/undo` (restores stock, re-enables if needed, voids the entry). Admin panel gains a right-side "Today's Sales" panel with per-sale Undo. New `GET /sales` report (Daily / Last 7 Days / Lifetime tabs) and `GET /reorder` page with an adjustable threshold (`POST /settings/reorder-threshold`).
- **2026-09-07** — Added edit functionality: per-row `Edit` button reuses the top add-form in "edit" mode (pre-fills brand/flavor/mg/barcode, submit becomes `Update Juice`, `Cancel` resets). New `POST /update-juice/:id` route with a self-excluding duplicate check; stock and active status are preserved.
- **2026-09-07** — Auto-disable juice when stock hits 0; re-enable when stock goes back above 0. New juices start disabled.
- **2026-09-07** — Notifications moved to a fixed-position toast (no layout shift).
- **2026-09-07** — Input Mode: scanning an existing barcode adds 1 to stock instead of filling the form.
- **2026-09-07** — Added barcode scanning: `barcode` column, scanner burst detection, Sell/Input modes (persisted in `sessionStorage`), `POST /scan`, `POST /scan/lookup`, `POST /juice/:id/barcode`, barcode field in add form, per-row Scan button.
- **2026-09-07** — Initial implementation of stock tracking: `stock` column, `POST /stock/:id`, per-juice `−`/`+` buttons and editable number field in the admin table.
