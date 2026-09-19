const express = require("express");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Format a Date as a local YYYY-MM-DD string (for daily grouping)
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Read a setting value (falls back to a default if not set)
async function getSetting(key, fallback) {
  const row = await db.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

// Helper to get all brands and juices of a given type for the admin home page
async function getAdminData(type) {
  const brands = await db.all(
    "SELECT * FROM brands WHERE type = ? ORDER BY name ASC",
    [type],
  );
  const juices = await db.all(
    `SELECT j.*, b.name as brand_name
     FROM juices j
     JOIN brands b ON j.brand_id = b.id
     WHERE j.type = ?
     ORDER BY j.active DESC, j.mg ASC, b.name ASC, j.flavor ASC`,
    [type],
  );
  return { brands, juices };
}

// Admin Panel (type = 'juice' or 'disposable')
app.get("/", async (req, res) => {
  const msgParam = req.query.message;
  const type = req.query.type === "disposable" ? "disposable" : "juice";
  try {
    const { brands, juices } = await getAdminData(type);
    let message = null;
    if (msgParam) {
      message = {
        text: msgParam,
        type:
          msgParam.includes("error") || msgParam.includes("already exists")
            ? "error"
            : "success",
      };
    }
    res.render("admin", { brands, juices, message, type });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Add Brand (type = 'juice' or 'disposable' — separate brand pools)
app.post("/add-brand", async (req, res) => {
  const { name, type } = req.body;
  const brandType = type === "disposable" ? "disposable" : "juice";
  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Brand name is required" });
  }
  try {
    await db.run("INSERT INTO brands (name, type) VALUES (?, ?)", [
      name.trim(),
      brandType,
    ]);
    res.status(200).send("Brand added");
  } catch (err) {
    if (err.message.includes("UNIQUE constraint failed")) {
      res.status(400).json({ error: "Brand already exists" });
    } else {
      res.status(500).json({ error: "Database error" });
    }
  }
});

// Resolve the mg for a product: disposables use a fixed setting, juices use the form value
async function resolveMg(productType, formMg) {
  if (productType === "disposable") {
    return parseInt(await getSetting("disposable_mg", "50"), 10);
  }
  return parseInt(formMg, 10);
}

// Add Juice / Disposable
app.post("/add-juice", async (req, res) => {
  const { brand_id, flavor, mg, barcode, type } = req.body;
  const productType = type === "disposable" ? "disposable" : "juice";
  const label = productType === "disposable" ? "Disposable" : "Juice";
  const base = productType === "disposable" ? "/?type=disposable" : "/";

  if (!brand_id || !flavor) {
    return res.redirect(`${base}?message=Missing fields`);
  }

  const productMg = await resolveMg(productType, mg);
  if (isNaN(productMg)) {
    return res.redirect(`${base}?message=Missing fields`);
  }

  try {
    // Check for duplicates (within the same type)
    const existing = await db.get(
      "SELECT id, active FROM juices WHERE brand_id = ? AND flavor = ? AND mg = ? AND type = ?",
      [brand_id, flavor, productMg, productType],
    );

    if (existing) {
      if (existing.active === 1) {
        return res.redirect(
          `${base}?message=This ${label.toLowerCase()} already exists and is active`,
        );
      } else {
        return res.redirect(
          `${base}?message=This ${label.toLowerCase()} exists but is inactive. Please find it in the list and enable it.`,
        );
      }
    }

    const cleanBarcode = barcode && barcode.trim() ? barcode.trim() : null;
    // New products start disabled (stock 0) - scanning one in re-enables it
    await db.run(
      "INSERT INTO juices (brand_id, flavor, mg, type, active, stock, barcode) VALUES (?, ?, ?, ?, 0, 0, ?)",
      [brand_id, flavor, productMg, productType, cleanBarcode],
    );
    res.redirect(`${base}?message=${label} added (disabled until stock is added)`);
  } catch (err) {
    console.error(err);
    res.redirect(`${base}?message=Database error occurred`);
  }
});

// Update Juice / Disposable (edit brand / flavor / mg / barcode)
app.post("/update-juice/:id", async (req, res) => {
  const id = req.params.id;
  const { brand_id, flavor, mg, barcode, type } = req.body;
  const productType = type === "disposable" ? "disposable" : "juice";
  const label = productType === "disposable" ? "Disposable" : "Juice";
  const base = productType === "disposable" ? "/?type=disposable" : "/";

  if (!brand_id || !flavor) {
    return res.redirect(`${base}?message=Missing fields`);
  }

  try {
    const juice = await db.get("SELECT id FROM juices WHERE id = ?", [id]);
    if (!juice) {
      return res.redirect(`${base}?message=Not found`);
    }

    const productMg = await resolveMg(productType, mg);
    if (isNaN(productMg)) {
      return res.redirect(`${base}?message=Missing fields`);
    }

    // Check for duplicates, excluding the product being edited
    const existing = await db.get(
      "SELECT id, active FROM juices WHERE brand_id = ? AND flavor = ? AND mg = ? AND type = ? AND id != ?",
      [brand_id, flavor, productMg, productType, id],
    );

    if (existing) {
      if (existing.active === 1) {
        return res.redirect(
          `${base}?message=This ${label.toLowerCase()} already exists and is active`,
        );
      } else {
        return res.redirect(
          `${base}?message=This ${label.toLowerCase()} exists but is inactive. Please find it in the list and enable it.`,
        );
      }
    }

    const cleanBarcode = barcode && barcode.trim() ? barcode.trim() : null;
    // Only the identity fields change; stock and active status are preserved
    await db.run(
      "UPDATE juices SET brand_id = ?, flavor = ?, mg = ?, barcode = ? WHERE id = ?",
      [brand_id, flavor, productMg, cleanBarcode, id],
    );
    res.redirect(`${base}?message=${label} updated`);
  } catch (err) {
    console.error(err);
    res.redirect(`${base}?message=Database error occurred`);
  }
});

// Assign / update a barcode for a juice
app.post("/juice/:id/barcode", async (req, res) => {
  const id = req.params.id;
  const { barcode } = req.body || {};

  try {
    const juice = await db.get("SELECT id FROM juices WHERE id = ?", [id]);
    if (!juice) return res.status(404).json({ error: "Juice not found" });

    const cleanBarcode = barcode && barcode.trim() ? barcode.trim() : null;
    await db.run("UPDATE juices SET barcode = ? WHERE id = ?", [
      cleanBarcode,
      id,
    ]);
    res.status(200).json({ barcode: cleanBarcode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Look up a barcode without selling
app.post("/scan/lookup", async (req, res) => {
  const { code } = req.body || {};
  if (!code || !code.trim()) {
    return res.status(400).json({ error: "No barcode provided" });
  }

  try {
    const juice = await db.get(
      `SELECT j.id, j.flavor, j.mg, j.active, j.stock, b.name as brand_name
       FROM juices j
       JOIN brands b ON j.brand_id = b.id
       WHERE j.barcode = ?`,
      [code.trim()],
    );

    if (!juice) {
      return res.status(200).json({ found: false, code: code.trim() });
    }

    res.status(200).json({
      found: true,
      id: juice.id,
      label: `${juice.brand_name} - ${juice.flavor} (${juice.mg}mg)`,
      stock: juice.stock,
      active: juice.active === 1,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Barcode scan: sell one unit of the matching juice
app.post("/scan", async (req, res) => {
  const { code } = req.body || {};
  if (!code || !code.trim()) {
    return res.status(400).json({ error: "No barcode provided" });
  }

  try {
    const juice = await db.get(
      `SELECT j.id, j.flavor, j.mg, j.active, j.stock, b.name as brand_name
       FROM juices j
       JOIN brands b ON j.brand_id = b.id
       WHERE j.barcode = ?`,
      [code.trim()],
    );

    if (!juice) {
      return res.status(200).json({ unknown: true, code: code.trim() });
    }

    if (juice.active !== 1) {
      return res.status(200).json({
        inactive: true,
        id: juice.id,
        label: `${juice.brand_name} - ${juice.flavor} (${juice.mg}mg)`,
      });
    }

    const newStock = Math.max(0, juice.stock - 1);
    // Auto-disable when the last unit is sold
    if (newStock === 0) {
      await db.run("UPDATE juices SET stock = ?, active = 0 WHERE id = ?", [
        newStock,
        juice.id,
      ]);
    } else {
      await db.run("UPDATE juices SET stock = ? WHERE id = ?", [
        newStock,
        juice.id,
      ]);
    }

    // Log the sale (barcode scans only) so it can be tallied / undone
    const now = new Date();
    const soldAt = now.toISOString();
    const soldDate = localDateStr(now);
    const sale = await db.run(
      "INSERT INTO sales (juice_id, barcode, sold_at, sold_date, voided) VALUES (?, ?, ?, ?, 0)",
      [juice.id, code.trim(), soldAt, soldDate],
    );

    res.status(200).json({
      sold: true,
      id: juice.id,
      label: `${juice.brand_name} - ${juice.flavor} (${juice.mg}mg)`,
      stock: newStock,
      outOfStock: newStock === 0,
      deactivated: newStock === 0,
      sale: {
        id: sale.id,
        juice_id: juice.id,
        label: `${juice.brand_name} - ${juice.flavor} (${juice.mg}mg)`,
        barcode: code.trim(),
        sold_at: soldAt,
        voided: 0,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Toggle Juice Status
app.post("/toggle-juice/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const juice = await db.get("SELECT active FROM juices WHERE id = ?", [id]);
    if (!juice) return res.status(404).send("Juice not found");

    const newStatus = juice.active === 1 ? 0 : 1;
    await db.run("UPDATE juices SET active = ? WHERE id = ?", [newStatus, id]);
    res.status(200).send("Status updated");
  } catch (err) {
    res.status(500).send("Internal Server Error");
  }
});

// Adjust Stock (delta = +/- change, or set stock directly)
app.post("/stock/:id", async (req, res) => {
  const id = req.params.id;
  const { delta, stock } = req.body || {};

  try {
    const juice = await db.get("SELECT stock, active FROM juices WHERE id = ?", [id]);
    if (!juice) return res.status(404).json({ error: "Juice not found" });

    let newStock;
    if (stock !== undefined && stock !== null && stock !== "") {
      newStock = parseInt(stock, 10);
    } else if (delta !== undefined && delta !== null && delta !== "") {
      newStock = juice.stock + parseInt(delta, 10);
    } else {
      return res.status(400).json({ error: "No stock value provided" });
    }

    if (isNaN(newStock) || newStock < 0) {
      return res.status(400).json({ error: "Stock cannot be negative" });
    }

    // Auto-disable when stock hits 0, re-enable when stock goes back above 0
    const result = { stock: newStock };
    if (newStock === 0 && juice.active === 1) {
      await db.run("UPDATE juices SET stock = ?, active = 0 WHERE id = ?", [
        newStock,
        id,
      ]);
      result.deactivated = true;
    } else if (newStock > 0 && juice.active === 0) {
      await db.run("UPDATE juices SET stock = ?, active = 1 WHERE id = ?", [
        newStock,
        id,
      ]);
      result.reactivated = true;
    } else {
      await db.run("UPDATE juices SET stock = ? WHERE id = ?", [newStock, id]);
    }
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Print View (juices, grouped by mg)
app.get("/print", async (req, res) => {
  try {
    const juices = await db.all(`
            SELECT j.flavor, b.name as brand_name, j.mg
            FROM juices j
            JOIN brands b ON j.brand_id = b.id
            WHERE j.active = 1 AND j.type = 'juice'
            ORDER BY j.mg ASC, b.name ASC, j.flavor ASC
        `);
    res.render("print", { juices });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Print View (disposables, grouped by brand only — all share one mg)
app.get("/print/disposables", async (req, res) => {
  try {
    const disposables = await db.all(`
            SELECT j.flavor, b.name as brand_name
            FROM juices j
            JOIN brands b ON j.brand_id = b.id
            WHERE j.active = 1 AND j.type = 'disposable'
            ORDER BY b.name ASC, j.flavor ASC
        `);
    res.render("print-disposables", { disposables });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Today's sales (for the admin panel's right-side tally)
app.get("/api/sales/today", async (req, res) => {
  try {
    const today = localDateStr(new Date());
    const sales = await db.all(
      `SELECT s.id, s.sold_at, s.voided, s.barcode,
              j.id as juice_id, j.flavor, j.mg, j.stock, j.active,
              b.name as brand_name
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.sold_date = ?
       ORDER BY s.id DESC`,
      [today],
    );
    const total = sales.filter((s) => s.voided === 0).length;
    res.status(200).json({ date: today, total, sales });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Undo a sale: restore stock, re-enable if needed, void the log entry
app.post("/sales/:id/undo", async (req, res) => {
  const id = req.params.id;
  try {
    const sale = await db.get(
      `SELECT s.id, s.voided, j.id as juice_id, j.stock, j.active,
              j.flavor, j.mg, b.name as brand_name
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.id = ?`,
      [id],
    );
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (sale.voided === 1) {
      return res.status(400).json({ error: "Sale already undone" });
    }

    const newStock = sale.stock + 1;
    // Re-enable if the juice had auto-disabled (stock was 0)
    if (newStock > 0 && sale.active === 0) {
      await db.run("UPDATE juices SET stock = ?, active = 1 WHERE id = ?", [
        newStock,
        sale.juice_id,
      ]);
    } else {
      await db.run("UPDATE juices SET stock = ? WHERE id = ?", [
        newStock,
        sale.juice_id,
      ]);
    }
    await db.run("UPDATE sales SET voided = 1 WHERE id = ?", [id]);

    res.status(200).json({
      undone: true,
      id,
      juice_id: sale.juice_id,
      label: `${sale.brand_name} - ${sale.flavor} (${sale.mg}mg)`,
      stock: newStock,
      reactivated: newStock > 0 && sale.active === 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Sales report page (Daily / Last 7 Days / Lifetime), filterable by type
app.get("/sales", async (req, res) => {
  try {
    const today = localDateStr(new Date());
    const date = req.query.date || today;
    const type = req.query.type || "all"; // 'all' | 'juice' | 'disposable'

    // Type filter clause (applied to the juices table)
    const typeClause =
      type === "juice" || type === "disposable" ? "AND j.type = ?" : "";
    const typeParam =
      type === "juice" || type === "disposable" ? [type] : [];

    // Daily: per-juice counts for the chosen date + detailed log
    const daily = await db.all(
      `SELECT j.id, j.flavor, j.mg, b.name as brand_name, COUNT(*) as qty
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.sold_date = ? AND s.voided = 0 ${typeClause}
       GROUP BY j.id
       ORDER BY qty DESC, b.name ASC, j.flavor ASC`,
      [date, ...typeParam],
    );
    const dailyLog = await db.all(
      `SELECT s.id, s.sold_at, s.voided, s.barcode,
              j.flavor, j.mg, b.name as brand_name
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.sold_date = ? ${typeClause}
       ORDER BY s.id DESC`,
      [date, ...typeParam],
    );

    // Last 7 days: per-juice totals + per-day totals
    const weekJuices = await db.all(
      `SELECT j.id, j.flavor, j.mg, b.name as brand_name, COUNT(*) as qty
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.voided = 0 AND s.sold_date >= date(?, '-6 days') AND s.sold_date <= ? ${typeClause}
       GROUP BY j.id
       ORDER BY qty DESC, b.name ASC, j.flavor ASC`,
      [date, date, ...typeParam],
    );
    const weekDays = await db.all(
      `SELECT s.sold_date as day, COUNT(*) as qty
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       WHERE s.voided = 0 AND s.sold_date >= date(?, '-6 days') AND s.sold_date <= ? ${typeClause}
       GROUP BY s.sold_date
       ORDER BY s.sold_date ASC`,
      [date, date, ...typeParam],
    );

    // Lifetime: all-time per-juice totals
    const lifetime = await db.all(
      `SELECT j.id, j.flavor, j.mg, b.name as brand_name, COUNT(*) as qty
       FROM sales s
       JOIN juices j ON s.juice_id = j.id
       JOIN brands b ON j.brand_id = b.id
       WHERE s.voided = 0 ${typeClause}
       GROUP BY j.id
       ORDER BY qty DESC, b.name ASC, j.flavor ASC`,
      typeParam,
    );

    res.render("sales", {
      date,
      today,
      type,
      daily,
      dailyLog,
      weekJuices,
      weekDays,
      lifetime,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Reorder page: juices at/below the threshold (already-ordered items sink to the bottom)
app.get("/reorder", async (req, res) => {
  try {
    const threshold = parseInt(await getSetting("reorder_threshold", "2"), 10);
    const juices = await db.all(
      `SELECT j.id, j.flavor, j.mg, j.stock, j.active, j.ordered, b.name as brand_name
       FROM juices j
       JOIN brands b ON j.brand_id = b.id
       WHERE j.stock <= ?
       ORDER BY j.ordered ASC, j.stock ASC, b.name ASC, j.flavor ASC`,
      [threshold],
    );
    res.render("reorder", { juices, threshold });
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
  }
});

// Toggle the "ordered" flag on a juice (reorder list: mark as ordered / undo)
app.post("/juice/:id/toggle-ordered", async (req, res) => {
  const id = req.params.id;
  try {
    const juice = await db.get("SELECT ordered FROM juices WHERE id = ?", [id]);
    if (!juice) return res.status(404).json({ error: "Juice not found" });

    const newOrdered = juice.ordered === 1 ? 0 : 1;
    await db.run("UPDATE juices SET ordered = ? WHERE id = ?", [newOrdered, id]);
    res.status(200).json({ ordered: newOrdered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// Update the reorder threshold
app.post("/settings/reorder-threshold", async (req, res) => {
  const value = parseInt((req.body || {}).value, 10);
  if (isNaN(value) || value < 0) {
    return res.status(400).json({ error: "Threshold must be a number 0 or greater" });
  }
  try {
    await db.run(
      "INSERT INTO settings (key, value) VALUES ('reorder_threshold', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(value)],
    );
    res.status(200).json({ threshold: value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
