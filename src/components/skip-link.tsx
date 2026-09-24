"use client";

export function SkipLink() {
  return <a className="skip-link" href="#main" onClick={(event) => {
    const main = document.getElementById("main");
    if (!main) return;
    // Do not replace an invitation token carried in the URL fragment.
    event.preventDefault();
    main.tabIndex = -1;
    main.focus();
    main.scrollIntoView({ block: "start" });
  }}>Skip to content</a>;
}
