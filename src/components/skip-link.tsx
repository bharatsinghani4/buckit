"use client";

export function SkipLink() {
  return (
    <a
      className="skip-link fixed [top:-80px] [left:20px] [background:var(--ink)] [color:var(--surface)] [z-index:100] [padding:12px_20px] [&:focus]:[top:10px]"
      href="#main"
      onClick={(event) => {
        const main = document.getElementById("main");
        if (!main) return;
        // Do not replace an invitation token carried in the URL fragment.
        event.preventDefault();
        main.tabIndex = -1;
        main.focus();
        main.scrollIntoView({ block: "start" });
      }}
    >
      Skip to content
    </a>
  );
}
