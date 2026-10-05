// ===== Type filter (All / Juices / Disposables) =====
// The unified table shows both types; this filters rows in place (no reload).
// The active filter is persisted in sessionStorage so it survives the page
// reload that happens after adding a product.
function applyFilter(filter) {
    const rows = document.querySelectorAll('#juice-table tbody tr');
    rows.forEach(row => {
        const show = row.dataset.type === filter;
        row.style.display = show ? '' : 'none';
    });
    document.querySelectorAll('#type-filter .type-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    try { sessionStorage.setItem('adminFilter', filter); } catch (e) {}
    // The form's type follows the active tab (drives the MG field + brand pool)
    const typeSel = document.getElementById('product-type');
    if (typeSel) {
        typeSel.value = filter;
        updateTypeDependentFields();
    }
}

// The currently active tab (the form's type follows this)
function getCurrentFilter() {
    const active = document.querySelector('#type-filter .type-tab.active');
    return active ? active.dataset.filter : 'juice';
}

function initFilter() {
    const container = document.getElementById('type-filter');
    const initial = container ? container.dataset.initial : 'juice';
    let saved = null;
    try { saved = sessionStorage.getItem('adminFilter'); } catch (e) {}
    if (saved === 'all') saved = null; // legacy value; fall back to the default tab
    applyFilter(saved || initial);
}

// ===== Add form: type drives the MG field + brand pool =====
// When the Type selector changes, show/hide the MG control and filter the
// brand dropdown to that type's pool (juice brands vs disposable brands).
function updateTypeDependentFields() {
    const type = document.getElementById('product-type').value;
    const isDisposable = type === 'disposable';

    const mgSelect = document.getElementById('mg');
    const mgFixed = document.getElementById('mg-fixed');
    mgSelect.classList.toggle('hidden', isDisposable);
    mgFixed.classList.toggle('hidden', !isDisposable);
    mgSelect.required = !isDisposable;

    // Filter brand options to the selected type (placeholder has no data-type)
    const brandSel = document.getElementById('brand');
    let currentValid = false;
    brandSel.querySelectorAll('option[data-type]').forEach(opt => {
        const show = opt.dataset.type === type;
        opt.hidden = !show;
        if (opt.value === brandSel.value && show) currentValid = true;
    });
    if (!currentValid && brandSel.value !== '') {
        brandSel.value = '';
    }

    // Submit button label (only in add mode; edit mode sets its own label)
    const id = document.getElementById('juice-id').value;
    if (!id) {
        document.getElementById('juice-submit-btn').textContent =
            isDisposable ? 'Add Disposable' : 'Add Juice';
    }
}

// ===== Form persistence for rapid adds =====
// After adding a product the page reloads (server redirect). We remember the
// type / brand / mg in sessionStorage so you can add many of the same brand
// back-to-back without re-selecting them. Flavor + barcode always clear.
function saveFormForNextAdd() {
    const id = document.getElementById('juice-id').value;
    if (id) return; // edit mode - don't persist
    const type = getCurrentFilter();
    const brandId = document.getElementById('brand').value;
    const mg = document.getElementById('mg').value;
    try {
        sessionStorage.setItem('adminForm', JSON.stringify({ type, brand_id: brandId, mg }));
    } catch (e) {}
}

function restoreForm() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('adminForm') || 'null'); } catch (e) {}
    if (!saved) return;

    // The type is driven by the active tab (set by initFilter); only restore
    // brand/mg when they match the current tab.
    const type = getCurrentFilter();
    const brandSel = document.getElementById('brand');
    if (saved.brand_id && saved.type === type) {
        const opt = brandSel.querySelector(`option[value="${saved.brand_id}"]`);
        if (opt && !opt.hidden) brandSel.value = saved.brand_id;
    }
    if (type === 'juice' && saved.mg) {
        const mgSel = document.getElementById('mg');
        if (mgSel.querySelector(`option[value="${saved.mg}"]`)) mgSel.value = saved.mg;
    }
}

// ===== Table sorting =====
// Columns: 0 Brand, 1 Flavor, 2 MG, 3 Stock, 4 Barcode, 5 Actions
function sortTable(columnIndex) {
    const table = document.getElementById('juice-table');
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);
    const header = table.tHead.rows[0].cells[columnIndex];

    // First click = descending, second click = ascending (toggle)
    const isDescending = header.dataset.sortDir !== 'desc';
    header.dataset.sortDir = isDescending ? 'desc' : 'asc';

    // Update all headers to remove active sort indicators
    // (Array.from: HTMLCollection has no forEach in Firefox)
    Array.from(table.tHead.rows[0].cells).forEach(cell => {
        cell.classList.remove('sort-asc', 'sort-desc');
    });

    // Add indicator to current header (arrow rendered via CSS ::after)
    header.classList.add(isDescending ? 'sort-desc' : 'sort-asc');

    // Sort logic
    const sortedRows = rows.sort((a, b) => {
        let aVal, bVal;

        // Numeric sorting for MG column (index 2) - text is like "50mg"
        if (columnIndex === 2) {
            aVal = parseInt(a.cells[2].textContent, 10) || 0;
            bVal = parseInt(b.cells[2].textContent, 10) || 0;
        }
        // Numeric sorting for Stock column (index 3) - value is in the input
        else if (columnIndex === 3) {
            aVal = parseInt(a.cells[3].querySelector('input').value, 10) || 0;
            bVal = parseInt(b.cells[3].querySelector('input').value, 10) || 0;
        }
        // Text sorting for Brand (0) and Flavor (1)
        else {
            aVal = a.cells[columnIndex].textContent.trim().toLowerCase();
            bVal = b.cells[columnIndex].textContent.trim().toLowerCase();
        }

        if (aVal < bVal) return isDescending ? 1 : -1;
        if (aVal > bVal) return isDescending ? -1 : 1;
        return 0;
    });

    // Re-append sorted rows to the table
    sortedRows.forEach(row => tbody.appendChild(row));
}

async function addNewBrand() {
    const name = prompt("Enter new brand name:");
    if (!name) return;

    const type = document.getElementById('product-type') ? document.getElementById('product-type').value : 'juice';
    const response = await fetch('/add-brand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type })
    });

    if (response.ok) {
        window.location.reload();
    } else {
        const data = await response.json();
        alert("Error: " + data.error);
    }
}

// ===== Edit juice (reuse the top add-form in "edit" mode) =====
function startEdit(id) {
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (!row) return;

    const form = document.getElementById('juice-form');
    form.action = `/update-juice/${id}`;
    document.getElementById('juice-id').value = id;

    // Switch to the product's type tab so the MG field + brand pool match
    applyFilter(row.dataset.type);

    document.getElementById('brand').value = row.dataset.brandId;
    document.getElementById('flavor').value = row.dataset.flavor;
    const mgField = document.getElementById('mg');
    if (mgField && !mgField.classList.contains('hidden')) mgField.value = row.dataset.mg;
    document.getElementById('barcode').value = row.dataset.barcode || '';

    const submitBtn = document.getElementById('juice-submit-btn');
    submitBtn.textContent = 'Update';
    document.getElementById('juice-cancel-btn').classList.remove('hidden');

    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('flavor').focus();
}

function cancelEdit() {
    const form = document.getElementById('juice-form');
    form.action = '/add-juice';
    form.reset();
    document.getElementById('juice-id').value = '';
    // Reset the form's type to the current tab
    const typeSel = document.getElementById('product-type');
    typeSel.value = getCurrentFilter();
    updateTypeDependentFields();
    document.getElementById('juice-submit-btn').textContent =
        getCurrentFilter() === 'disposable' ? 'Add Disposable' : 'Add Juice';
    document.getElementById('juice-cancel-btn').classList.add('hidden');
}

async function toggleJuice(id) {
    const response = await fetch(`/toggle-juice/${id}`, { method: 'POST' });
    if (!response.ok) {
        alert("Failed to update juice status");
    } else {
        window.location.reload();
    }
}

async function adjustStock(id, delta) {
    const response = await fetch(`/stock/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
    });

    if (response.ok) {
        const data = await response.json();
        const input = document.querySelector(`input.stock-input[data-id="${id}"]`);
        if (input) input.value = data.stock;
        if (data.deactivated) updateRowActiveState(id, false);
        if (data.reactivated) updateRowActiveState(id, true);
    } else {
        const data = await response.json().catch(() => ({}));
        alert("Failed to update stock" + (data.error ? ": " + data.error : ""));
    }
}

async function setStock(id, value) {
    const stock = parseInt(value, 10);
    if (isNaN(stock) || stock < 0) {
        alert("Stock must be a number 0 or greater");
        window.location.reload();
        return;
    }

    const response = await fetch(`/stock/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock })
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert("Failed to update stock" + (data.error ? ": " + data.error : ""));
        window.location.reload();
        return;
    }
    const data = await response.json();
    if (data.deactivated) updateRowActiveState(id, false);
    if (data.reactivated) updateRowActiveState(id, true);
}

// Update a row's active appearance without reloading (dimming + Enable/Disable button)
function updateRowActiveState(id, active) {
    const input = document.querySelector(`input.stock-input[data-id="${id}"]`);
    if (!input) return;
    const row = input.closest('tr');
    const btn = row.cells[5].querySelector('button');
    row.classList.toggle('row-inactive', !active);
    if (btn) {
        btn.textContent = active ? 'Disable' : 'Enable';
        btn.className = active ? 'btn-secondary' : 'btn-success';
    }
}

// ===== Barcode scanner handling =====
// USB scanners act as keyboards: they "type" the code very fast and hit Enter.
// We detect bursts of fast keystrokes ending in Enter and treat them as scans.
// The scan mode ('sell' | 'input') is owned by theme.js (persistent nav button);
// read it via getScanMode() so the two stay in sync.
let pendingAssignId = null; // juice id waiting for a barcode (row Scan button)
let scanBuffer = '';
let lastKeyTime = 0;
const SCAN_KEY_INTERVAL = 100; // ms between keystrokes still counted as a scanner
const MIN_SCAN_LENGTH = 4;

document.addEventListener('keydown', (e) => {
    const now = Date.now();
    const isFast = (now - lastKeyTime) < SCAN_KEY_INTERVAL;
    lastKeyTime = now;

    if (e.key === 'Enter') {
        if (scanBuffer.length >= MIN_SCAN_LENGTH && isFast) {
            e.preventDefault(); // stop form submits / button clicks
            const code = scanBuffer;
            scanBuffer = '';
            handleScan(code);
        }
        return;
    }

    if (e.key.length === 1) {
        if (isFast) {
            scanBuffer += e.key;
        } else {
            scanBuffer = e.key; // start a new potential burst
        }
    }
});

async function handleScan(code) {
    // If the scan got typed into a focused text field, strip it out
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
        && typeof active.value === 'string' && active.value.endsWith(code)) {
        active.value = active.value.slice(0, active.value.length - code.length);
    }

    if (getScanMode() === 'input') {
        if (pendingAssignId) {
            const id = pendingAssignId;
            pendingAssignId = null;
            const response = await fetch(`/juice/${id}/barcode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barcode: code })
            });
            if (response.ok) {
                showScanStatus(`Barcode ${code} assigned`, 'success');
                window.location.reload();
            } else {
                showScanStatus('Failed to assign barcode', 'error');
            }
            return;
        }

        // If this barcode is already in the system, add one to its stock
        const lookup = await fetch('/scan/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const info = await lookup.json().catch(() => ({}));

        if (info.found) {
            const response = await fetch(`/stock/${info.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delta: 1 })
            });
            if (response.ok) {
                const data = await response.json();
                const input = document.querySelector(`input.stock-input[data-id="${info.id}"]`);
                if (input) input.value = data.stock;
                if (data.reactivated) updateRowActiveState(info.id, true);
                const reEnabled = data.reactivated ? ' - re-enabled' : '';
                showScanStatus(`${info.label} already in system - added 1 to stock (${data.stock} total)${reEnabled}`, 'success');
            } else {
                showScanStatus('Failed to update stock', 'error');
            }
            return;
        }

        const field = document.getElementById('barcode');
        field.value = code;
        field.focus();
        showScanStatus(`Barcode ${code} captured - pick brand/flavor/mg and add the juice`, 'success');
        return;
    }

    // Sell mode: sell one unit
    const response = await fetch('/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        showScanStatus('Scan failed: ' + (data.error || 'unknown error'), 'error');
        return;
    }
    if (data.unknown) {
        showScanStatus(`Unknown barcode: ${data.code}`, 'error');
        return;
    }
    if (data.inactive) {
        showScanStatus(`${data.label} is disabled`, 'error');
        return;
    }

    const input = document.querySelector(`input.stock-input[data-id="${data.id}"]`);
    if (input) input.value = data.stock;
    if (data.deactivated) updateRowActiveState(data.id, false);

    // Add the sale to the right-side "Today's Sales" panel
    if (data.sale) prependSale(data.sale);

    if (data.outOfStock) {
        showScanStatus(`${data.label} sold - OUT OF STOCK (disabled)`, 'warn');
    } else {
        showScanStatus(`${data.label} sold - ${data.stock} left`, 'success');
    }
}

function startBarcodeAssign(id) {
    if (getScanMode() !== 'input') {
        toggleScanMode();
    }
    pendingAssignId = id;
    showScanStatus('Scan a barcode to assign it to this juice...', 'info');
}

let scanStatusTimer = null;
function showScanStatus(text, type) {
    const el = document.getElementById('scan-status');
    el.textContent = text;
    el.className = 'scan-status scan-' + type;
    if (scanStatusTimer) clearTimeout(scanStatusTimer);
    scanStatusTimer = setTimeout(() => {
        el.className = 'scan-status hidden';
    }, 4000);
}

// ===== Today's Sales panel (right side) =====
function formatSaleTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function salesItemHtml(sale) {
    const voided = sale.voided === 1;
    const btn = voided
        ? '<span class="sales-voided-tag">undone</span>'
        : `<button type="button" class="btn-danger sales-undo-btn" onclick="undoSale(${sale.id})">Undo</button>`;
    return `<div class="sales-item ${voided ? 'voided' : ''}" data-sale-id="${sale.id}">
        <div class="sales-item-info">
            <div class="sales-item-label">${sale.label}</div>
            <div class="sales-item-time">${formatSaleTime(sale.sold_at)}</div>
        </div>
        ${btn}
    </div>`;
}

function renderSalesPanel(data) {
    const list = document.getElementById('sales-list');
    const total = document.getElementById('sales-total');
    if (!list) return;
    total.textContent = data.total;
    if (!data.sales.length) {
        list.innerHTML = '<p class="sales-empty">No sales yet today.</p>';
        return;
    }
    list.innerHTML = data.sales.map(salesItemHtml).join('');
}

async function loadTodaySales() {
    try {
        const response = await fetch('/api/sales/today');
        if (!response.ok) return;
        const data = await response.json();
        renderSalesPanel(data);
    } catch (e) {
        // ignore network errors; panel stays as-is
    }
}

// Prepend a freshly-logged sale to the panel (called after a successful scan)
function prependSale(sale) {
    const list = document.getElementById('sales-list');
    const total = document.getElementById('sales-total');
    if (!list) return;
    const empty = list.querySelector('.sales-empty');
    if (empty) empty.remove();
    list.insertAdjacentHTML('afterbegin', salesItemHtml(sale));
    total.textContent = parseInt(total.textContent, 10) + 1;
}

async function undoSale(id) {
    const response = await fetch(`/sales/${id}/undo`, { method: 'POST' });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        showScanStatus('Undo failed' + (data.error ? ': ' + data.error : ''), 'error');
        return;
    }
    const data = await response.json();
    // Update the stock field in the main table
    const input = document.querySelector(`input.stock-input[data-id="${data.juice_id}"]`);
    if (input) input.value = data.stock;
    if (data.reactivated) updateRowActiveState(data.juice_id, true);
    // Mark the panel item as voided
    const item = document.querySelector(`.sales-item[data-sale-id="${id}"]`);
    if (item) {
        item.classList.add('voided');
        const btn = item.querySelector('.sales-undo-btn');
        if (btn) btn.outerHTML = '<span class="sales-voided-tag">undone</span>';
    }
    const total = document.getElementById('sales-total');
    total.textContent = Math.max(0, parseInt(total.textContent, 10) - 1);
    showScanStatus(`${data.label} undone - stock restored to ${data.stock}`, 'info');
}

// ===== Init =====
// Remember the form on submit (add mode) so rapid adds keep type/brand/mg.
document.getElementById('juice-form').addEventListener('submit', saveFormForNextAdd);
initFilter();
restoreForm();
loadTodaySales();
