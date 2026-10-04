// ============================================================
// theme.js — dark-mode toggle (persisted in a cookie) + mobile nav
// The actual theme class is applied by an inline <head> script so
// there is no flash of the wrong theme; this file wires up the
// toggle button and the mobile hamburger menu.
// ============================================================
(function () {
    var COOKIE = "theme";
    var YEAR = 31536000; // 1 year in seconds

    function currentTheme() {
        return document.documentElement.classList.contains("dark")
            ? "dark"
            : "light";
    }

    function updateButton() {
        var btn = document.getElementById("theme-toggle");
        if (!btn) return;
        var dark = currentTheme() === "dark";
        btn.textContent = dark ? "☀️" : "🌙";
        var label = dark ? "Switch to light mode" : "Switch to dark mode";
        btn.setAttribute("aria-label", label);
        btn.title = label;
    }

    function setTheme(t) {
        if (t === "dark") {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
        document.cookie =
            COOKIE + "=" + t + "; path=/; max-age=" + YEAR + "; SameSite=Lax";
        updateButton();
    }

    // Toggle dark/light and remember the choice in a cookie
    window.toggleTheme = function () {
        setTheme(currentTheme() === "dark" ? "light" : "dark");
    };

    // Mobile hamburger: show/hide the collapsed nav links
    window.toggleNavMenu = function () {
        var links = document.getElementById("nav-links");
        var btn = document.getElementById("nav-toggle");
        if (!links) return;
        var open = links.classList.toggle("open");
        if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    // Match the button icon to the theme already applied by the head script
    updateButton();

    // ============================================================
    // Scan mode (Sell / Input) — persistent button in the top nav.
    // The mode is persisted in sessionStorage and shared with admin.js
    // (which handles the actual barcode scanning) via getScanMode().
    // ============================================================
    var scanMode = sessionStorage.getItem("scanMode") || "sell"; // 'sell' (default) or 'input'

    function syncScanModeButton() {
        var btn = document.getElementById("scan-mode-btn");
        if (!btn) return;
        if (scanMode === "input") {
            btn.textContent = "Input Mode";
            btn.className = "topnav-scan btn-primary";
        } else {
            btn.textContent = "Sell Mode";
            btn.className = "topnav-scan btn-success";
        }
    }

    // Expose the current mode so admin.js can branch on it
    window.getScanMode = function () {
        return scanMode;
    };

    window.toggleScanMode = function () {
        scanMode = scanMode === "sell" ? "input" : "sell";
        sessionStorage.setItem("scanMode", scanMode);
        syncScanModeButton();
        // In Sell Mode the admin page hides the input menu (see admin.css)
        document.documentElement.classList.toggle("sell-mode", scanMode === "sell");
        if (typeof window.showScanStatus === "function") {
            if (scanMode === "input") {
                window.showScanStatus(
                    "Input mode: scan to fill the Barcode field, or click Add on a row to assign to that juice",
                    "info",
                );
            } else {
                window.showScanStatus(
                    "Sell mode: scanning a barcode sells one unit",
                    "info",
                );
            }
        }
    };

    // Restore the mode button on page load (mode persists in sessionStorage)
    syncScanModeButton();
})();
