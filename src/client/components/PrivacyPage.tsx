import { useEffect } from "react";

/** Static privacy policy page, served at /privacy. */
export function PrivacyPage() {
  useEffect(() => {
    document.title = "Privacy | Quotefinder";
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute(
        "content",
        "Quotefinder privacy policy: what quote search and the creator archive store, and your choices.",
      );
    }
  }, []);

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <div className="mx-auto w-full max-w-[42rem] px-4 pb-10 pt-10 sm:px-6">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Quotefinder Privacy Policy
        </h1>
        <p className="mt-2 text-muted">Last updated: November 3, 2026</p>

        <h2 className="mt-8 font-display text-xl font-bold">
          What Quotefinder does
        </h2>
        <p className="mt-2">
          Quotefinder helps people find a video from a line they remember. It
          has two parts: quote search, which needs no account, and the creator
          archive, where a creator signs in with Google and searches captions
          from their own YouTube videos.
        </p>

        <h2 className="mt-8 font-display text-xl font-bold">Quote search</h2>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>
            You don&apos;t need an account, and we don&apos;t store your
            searches in a database.
          </li>
          <li>
            The text you type or dictate is sent to Meta&apos;s AI models to
            process it, and to the YouTube Data API to find videos. Voice
            audio is sent to Meta&apos;s transcription model.
          </li>
          <li>
            Error reports may include technical details about a failed
            request. We remove request content, headers, cookies, query
            strings, and keys before any report leaves our server.
          </li>
        </ul>

        <h2 className="mt-8 font-display text-xl font-bold">
          Creator archive
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>
            You sign in with Google and connect your YouTube channel. We ask
            Google for the youtube.force-ssl permission. We use it only to
            download captions for the videos you choose to index.
          </li>
          <li>
            We store your channel ID, your channel name, and your Google
            refresh token. The token is encrypted with AES-256-GCM.
          </li>
          <li>
            We store the caption text of the videos you index. It is deleted
            30 days after it was stored, by a daily cleanup and each time the
            archive is used.
          </li>
          <li>
            Archive search results are shown only to you, the signed-in
            creator.
          </li>
        </ul>

        <h2 className="mt-8 font-display text-xl font-bold">Cookies</h2>
        <p className="mt-2">
          We use a sign-in cookie to keep you signed in, and a short-lived
          cookie during Google sign-in. We don&apos;t use advertising cookies.
        </p>

        <h2 className="mt-8 font-display text-xl font-bold">
          Who processes your data
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>Google and YouTube: sign-in and access to your channel&apos;s captions.</li>
          <li>Meta: AI models for matching and voice transcription.</li>
          <li>Amazon Web Services: hosting.</li>
          <li>Sentry: error reports, when error reporting is turned on.</li>
        </ul>

        <h2 className="mt-8 font-display text-xl font-bold">
          Google user data
        </h2>
        <p className="mt-2">
          Quotefinder&apos;s use and transfer of information received from
          Google APIs follows the Google API Services User Data Policy,
          including the Limited Use requirements. We use Google user data only
          to provide the creator archive. We don&apos;t use it for
          advertising, we don&apos;t sell it, we don&apos;t use it to train AI
          models, and we don&apos;t transfer it except as needed to provide the
          feature or as the law requires.
        </p>

        <h2 className="mt-8 font-display text-xl font-bold">Your choices</h2>
        <ul className="mt-2 list-disc space-y-1 pl-6">
          <li>
            Disconnect at any time from the creator page. This deletes your
            stored token and caption text.
          </li>
          <li>
            You can also remove Quotefinder&apos;s access in your Google
            account settings:{" "}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-accent underline"
            >
              https://myaccount.google.com/permissions
            </a>
          </li>
          <li>
            Use of YouTube data is subject to the YouTube Terms of Service and
            Google&apos;s Privacy Policy.
          </li>
        </ul>

        <h2 className="mt-8 font-display text-xl font-bold">Contact</h2>
        <p className="mt-2">Questions about this policy: onwukaemmanuelchidi@gmail.com</p>
        <p className="mt-2">Developer: Emmanuel Onwuka</p>
      </div>
    </div>
  );
}
