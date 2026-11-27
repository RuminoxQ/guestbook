// Deletes guestbook uploads from Cloudinary 24 hours after upload.
// Runs hourly from .github/workflows/cloudinary-cleanup.yml.
// Needs repository secrets: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
// Optional repository variables: GUESTBOOK_TAG (default "guestbook"), MAX_AGE_HOURS (default 24), DRY_RUN ("true" to only list).

const cloud = process.env.CLOUDINARY_CLOUD_NAME;
const key = process.env.CLOUDINARY_API_KEY;
const secret = process.env.CLOUDINARY_API_SECRET;
const tag = process.env.GUESTBOOK_TAG || 'guestbook';
const maxAgeHours = Number(process.env.MAX_AGE_HOURS || 24);
const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

if (!cloud || !key || !secret) {
  console.log('Cloudinary secrets are not set yet, so there is nothing to clean up. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Settings > Secrets and variables > Actions.');
  process.exit(0);
}

const api = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}`;
const auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
const cutoff = Date.now() - maxAgeHours * 3600 * 1000;

async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

async function findExpired() {
  const found = [];
  let cursor;
  do {
    const out = await call('POST', '/resources/search', {
      expression: `tags=${tag}`,
      max_results: 500,
      sort_by: [{ created_at: 'asc' }],
      fields: ['public_id', 'resource_type', 'type', 'created_at'],
      ...(cursor ? { next_cursor: cursor } : {}),
    });
    for (const r of out.resources || []) {
      // Double-check the age here so nothing younger than the limit is ever deleted.
      if (Date.parse(r.created_at) <= cutoff) found.push(r);
    }
    cursor = out.next_cursor;
  } while (cursor);
  return found;
}

async function remove(resources) {
  const groups = {};
  for (const r of resources) {
    const k = `${r.resource_type}/${r.type || 'upload'}`;
    (groups[k] = groups[k] || []).push(r.public_id);
  }
  let deleted = 0;
  for (const [k, ids] of Object.entries(groups)) {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const qs = batch.map((id) => 'public_ids[]=' + encodeURIComponent(id)).join('&') + '&invalidate=true';
      const out = await call('DELETE', `/resources/${k}?${qs}`);
      for (const [id, result] of Object.entries(out.deleted || {})) {
        console.log(`${result === 'deleted' ? 'Deleted' : 'Skipped (' + result + ')'}: ${k}/${id}`);
        if (result === 'deleted') deleted++;
      }
    }
  }
  return deleted;
}

const expired = await findExpired();
console.log(`Found ${expired.length} guestbook file(s) older than ${maxAgeHours} hours.`);
if (expired.length === 0) process.exit(0);
if (dryRun) {
  for (const r of expired) console.log(`Would delete: ${r.resource_type}/${r.public_id} (uploaded ${r.created_at})`);
  process.exit(0);
}
const n = await remove(expired);
console.log(`Done. Deleted ${n} file(s).`);
