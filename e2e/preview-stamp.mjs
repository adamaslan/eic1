// Prints the served build stamp of PREVIEW_URL ("bf48db4"-style, 7 chars) and exits
// 0 only when it equals the wanted head sha prefix. The stamp is client-rendered from
// the COMMIT_REF Vite define, so a curl of the HTML cannot see it; the CI job already
// installs chromium before this runs, so one page load per poll is cheap proof that
// the preview actually serves THIS commit - a bare HTTP 200 can be a stale build
// (the PR #58/#71 wrong-commit smoke class).
import { chromium } from "playwright";

const want = process.argv[2];
const url = process.env.PREVIEW_URL;
if (!want || !url) {
  console.error("usage: PREVIEW_URL=... node e2e/preview-stamp.mjs <sha7>");
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const text = await page
    .getByText(/build [0-9a-f]{7}/)
    .first()
    .textContent({ timeout: 15000 })
    .catch(() => "");
  const stamp = text.match(/build ([0-9a-f]{7})/)?.[1] ?? "";
  console.log(stamp);
  process.exit(stamp === want ? 0 : 1);
} finally {
  await browser.close();
}
