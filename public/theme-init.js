try {
  const saved = localStorage.getItem("buckit-theme");
  document.documentElement.setAttribute("data-theme", saved === "light" || saved === "dark" ? saved : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
} catch { /* Browser storage may be disabled; the CSS default remains usable. */ }
