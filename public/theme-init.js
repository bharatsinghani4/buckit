try {
  const saved = localStorage.getItem("buckit-theme");
  let automatic = null;
  if (saved === "auto") {
    const schedule = JSON.parse(localStorage.getItem("buckit-solar-theme") || "null");
    const now = Date.now();
    if (
      schedule &&
      schedule.calculatedAt <= now &&
      now < schedule.expiresAt &&
      Array.isArray(schedule.transitions)
    ) {
      automatic = schedule.baseTheme;
      for (const transition of schedule.transitions) {
        if (transition.at > now) break;
        automatic = transition.theme;
      }
    }
  }
  document.documentElement.setAttribute(
    "data-theme",
    saved === "light" || saved === "dark"
      ? saved
      : automatic === "light" || automatic === "dark"
        ? automatic
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
  );
} catch {
  /* Browser storage may be disabled; the CSS default remains usable. */
}
