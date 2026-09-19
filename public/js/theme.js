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
})();
