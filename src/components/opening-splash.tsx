"use client";

import { Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { playOpeningCue } from "@/lib/brand-sounds";

function OpeningMark() {
  return (
    <svg
      className="opening-mark size-36 sm:size-40 lg:size-44"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="opening-top"
          x1="24"
          y1="18"
          x2="76"
          y2="48"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4EBA8D" />
          <stop offset="1" stopColor="#2D8565" />
        </linearGradient>
        <linearGradient
          id="opening-left"
          x1="24"
          y1="33"
          x2="50"
          y2="83"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#226950" />
          <stop offset="1" stopColor="#172F28" />
        </linearGradient>
      </defs>
      <rect className="opening-tile" width="100" height="100" rx="24" fill="#F8FAF7" />
      <rect
        className="opening-tile"
        x="1.5"
        y="1.5"
        width="97"
        height="97"
        rx="22.5"
        stroke="#E0E6DE"
        strokeWidth="1.5"
      />
      <path className="opening-left-face" d="M24 33L50 48V83L24 68V33Z" fill="url(#opening-left)" />
      <path className="opening-right-face" d="M76 33L50 48V83L76 68V33Z" fill="#172F28" />
      <g className="opening-lid">
        <path d="M50 18L76 33L50 48L24 33L50 18Z" fill="url(#opening-top)" />
        <path d="M50 24L65.6 33L50 42L34.4 33L50 24Z" fill="#11241E" />
        <ellipse cx="50" cy="33" rx="5.5" ry="3.17" fill="#8DE1BD" />
      </g>
    </svg>
  );
}

export function OpeningSplash() {
  const [visible, setVisible] = useState(true);
  const [showReplay, setShowReplay] = useState(false);
  const [take, setTake] = useState(0);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) playOpeningCue();
    const duration = reducedMotion ? 250 : 2850;
    const timer = window.setTimeout(() => {
      setVisible(false);
      setShowReplay(true);
    }, duration);
    const replayTimer = window.setTimeout(() => setShowReplay(false), duration + 10_000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(replayTimer);
    };
  }, [take]);

  const replayButton = (
    <button
      type="button"
      className="fixed right-5 bottom-[max(20px,env(safe-area-inset-bottom))] z-[1001] inline-flex h-9 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--ink)] shadow-sm hover:bg-[var(--soft)]"
      onClick={() => {
        setShowReplay(false);
        setVisible(true);
        setTake((current) => current + 1);
      }}
      aria-label="Replay opening with sound"
      title="Replay opening with sound"
    >
      <Volume2 size={16} aria-hidden="true" />
      <span>Replay with sound</span>
    </button>
  );

  if (!visible) return showReplay ? replayButton : null;

  return (
    <div
      key={take}
      className="opening-splash fixed inset-0 z-[1000] grid place-items-center overflow-hidden bg-[var(--canvas)]"
      role="status"
      aria-label="Opening Buckit"
    >
      <div className="opening-scene absolute inset-0 grid place-items-center">
        <div className="opening-wash opening-wash-mint absolute -inset-[25%] bg-[var(--splash-rush)]" />
        <div className="opening-wash opening-wash-return absolute -inset-[25%] bg-[var(--canvas)]" />
        <div className="opening-lockup relative z-10 flex flex-col items-center gap-4 px-6 min-[768px]:flex-row min-[768px]:gap-7">
          <OpeningMark />
          <span className="opening-word whitespace-nowrap font-extrabold leading-none tracking-[-.065em] [font-size:clamp(48px,7vw,78px)] max-[767px]:text-[52px]">
            buck
            <em className="opening-it font-['Fraunces_Variable',Georgia,serif] font-bold italic">
              it
            </em>
          </span>
        </div>
      </div>
      {replayButton}
    </div>
  );
}
