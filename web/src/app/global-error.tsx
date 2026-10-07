"use client";

import { SNAPSHOT_MANIFEST, SNAPSHOT_MODE, SNAPSHOT_SOURCE_URL, snapshotBannerText } from "@/lib/snapshot";

/**
 * Last-resort boundary for errors in the root layout itself (providers, shell). It replaces
 * the whole document, so it carries its own minimal styles; route errors use app/error.tsx.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <style>{`
          body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0d10; color: #e7e9ec; }
          main { max-width: 40rem; margin: 0 auto; padding: 3rem 1rem; }
          p.detail { color: #f87171; overflow-wrap: anywhere; }
          code { font-family: ui-monospace, monospace; font-size: 0.8rem; color: #a7adb6; }
          button { margin-top: 1rem; height: 2.25rem; padding: 0 0.9rem; border-radius: 0.375rem; border: 1px solid #39404a; background: #181c22; color: inherit; font: inherit; cursor: pointer; }
          button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
          @media (prefers-color-scheme: light) {
            body { background: #f4f5f7; color: #0f1720; }
            p.detail { color: #b91c1c; }
            code { color: #474f5c; }
            button { background: #ffffff; border-color: #c3cad3; }
            button:focus-visible { outline-color: #1d4ed8; }
          }
        `}</style>
        <main>
          {SNAPSHOT_MODE ? (
            <p>
              <strong>{snapshotBannerText(SNAPSHOT_MANIFEST)}</strong>{" "}
              {SNAPSHOT_SOURCE_URL ? <a href={SNAPSHOT_SOURCE_URL}>How to run it yourself</a> : null}
            </p>
          ) : null}
          <h1>CounterProof could not start this page</h1>
          <p>
            {SNAPSHOT_MODE
              ? "The application shell failed to render. This is a read-only recorded snapshot; nothing is sent anywhere."
              : "The application shell failed to render. Nothing was sent to the backend or to a wallet because of this error."}
          </p>
          <p className="detail">{error.message || "Unknown error"}</p>
          {error.digest ? <code>Error digest: {error.digest}</code> : null}
          <div>
            <button type="button" onClick={() => retry()}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
