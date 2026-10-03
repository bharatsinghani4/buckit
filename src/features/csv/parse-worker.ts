import { parseCsv } from "./codec";

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const [text, bytes] = await Promise.all([file.text(), file.arrayBuffer()]);
    const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    self.postMessage({ parsed, hash });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Could not parse the CSV.",
    });
  }
};
