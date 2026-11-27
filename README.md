# Audio & video guestbook

A browser-based guestbook for events. Guests record a **video & audio message**, an **audio-only message** or a **photo** on a kiosk, tablet or laptop — or on their own phone by scanning a QR code.

- **Guestbook:** `https://ruminoxq.github.io/guestbook/`
- **Remote guests (own phone):** `https://ruminoxq.github.io/guestbook/?remote=1` (the QR code on the start screen)
- **Host gallery:** `https://ruminoxq.github.io/guestbook/gallery.html`
- **Storage:** Cloudinary (`whgs8x00`, preset `guestbook_kiosk`). Every upload is **deleted automatically 24 hours after upload** by `.github/workflows/cloudinary-cleanup.yml`.

## Before the event

1. Edit **`config.js`** on GitHub: event name, names for the overlay, date, accent colour and prompt questions. These apply to every device, including guests’ phones.
2. On each guestbook device, open the guestbook, tap **Record video & audio** once and choose **Allow** for the camera and microphone. In Chrome/Edge also set Camera and Microphone to **Allow** in the site settings; on iPad, Settings → Apps → Safari → Camera / Microphone → Allow.
3. Open the **Staff panel**: press and hold the **top-left corner** of the screen for 3 seconds, then enter the PIN (default `2580` — change it straight away under Kiosk & security; each device keeps its own PIN).
4. In the Staff panel, run the **Device check** (camera, microphone, speaker, storage, internet, test upload).

## During the event

- Messages are saved on the device first and uploaded in the background. If the Wi-Fi drops, they wait and upload when it’s back. The Staff panel shows how many are waiting and lets you save any file directly.
- After saving, guests get a QR code to watch or download their own copy for 24 hours.

## After the event

Open the **host gallery**, enter the gallery code (the part after `guestbook-` in the `GUESTBOOK_TAG` repository variable) and use **Download all (.zip)** **within 24 hours**.

## Staff settings (per device)

Time limit, time-left reminder, video quality (Saver / Standard / High), countdown sounds, host messages, voice guide, prompt cards, branded overlay, kiosk mode, idle timeout, thank-you time and PIN. Settings are stored in that device’s browser.

## 24-hour clean-up

Repository secrets `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` and variable `GUESTBOOK_TAG` are set. The job runs hourly; files are deleted 24–25 hours after upload. To test: Actions → **Delete guestbook files after 24 hours** → Run workflow → tick **Only list what would be deleted**.

- GitHub pauses scheduled jobs in a repository with no activity for 60 days. Re-enable it from the Actions tab before your next event.
- Never put the API secret in any web page or commit it to this repository.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.js` | The guestbook (kiosk and remote) |
| `gallery.html`, `gallery.js` | Host gallery |
| `copy.html` | Page guests open from their QR code |
| `config.js` | Shared event settings |
| `styles.css` | Shared styles |
| `assets/audio/` | Opening and closing host messages |
| `vendor/` | QR code (qrcode-generator, MIT) and zip (JSZip, MIT) libraries |
| `scripts/cleanup.mjs` | The 24-hour clean-up job |
