# Audio & video guestbook

A browser-based guestbook for events. Guests record a video & audio message, an audio-only message or a photo on a kiosk, tablet or their own phone.

- **Hosting:** GitHub Pages (this repository).
- **Storage:** Cloudinary. Every upload is tagged `guestbook` and **deleted automatically 24 hours after upload** by the hourly job in `.github/workflows/cloudinary-cleanup.yml`.

> Status: the full guestbook is being built. `index.html` is currently a camera & microphone test page.

## 1. Turn on GitHub Pages

Settings → Pages → Build and deployment → Source: **Deploy from a branch** → Branch: **main** / **(root)** → Save.

The site appears at `https://<your-username>.github.io/<repository-name>/` after a minute or two.

## 2. Connect Cloudinary (for the 24-hour clean-up)

Settings → Secrets and variables → Actions → **New repository secret**, and add:

| Secret | Where to find it in Cloudinary |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Dashboard → Cloud name |
| `CLOUDINARY_API_KEY` | Settings → API Keys |
| `CLOUDINARY_API_SECRET` | Settings → API Keys (click to reveal) |

Never put the API secret in any web page or commit it to this repository.

Optional repository **variables** (same page, Variables tab): `GUESTBOOK_TAG` (default `guestbook`) and `MAX_AGE_HOURS` (default `24`).

## 3. Test the clean-up

Actions → **Delete guestbook files after 24 hours** → Run workflow → tick **Only list what would be deleted** → Run. The log lists any files older than 24 hours without deleting them. After that it runs by itself every hour.

## Notes

- Files are deleted between 24 and 25 hours after upload, because the job runs once an hour. GitHub may start scheduled runs a few minutes late at busy times.
- GitHub pauses scheduled jobs in a repository with no activity for 60 days. Re-enable it from the Actions tab before your next event.
- If Cloudinary backups are turned on in your account, backed-up copies are kept separately. Turn backups off (Settings → Upload → Backups) if nothing should remain after 24 hours.
