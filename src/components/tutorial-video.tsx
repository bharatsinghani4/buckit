export function TutorialVideo() {
  return (
    <video
      className="aspect-video w-full rounded-xl bg-black shadow-[var(--shadow)]"
      controls
      playsInline
      preload="metadata"
      aria-label="Buckit complete walkthrough video"
    >
      <source src="/buckit-demo.mp4" type="video/mp4" />
      Your browser does not support video playback.
    </video>
  );
}
