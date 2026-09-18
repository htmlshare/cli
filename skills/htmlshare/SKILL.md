---
name: htmlshare
description: Publish AI-generated HTML prototypes to HTMLShare and return a shareable preview URL. Use when the user asks to publish, upload, share, preview, or deploy an HTML page through HTMLShare. Also handles custom subdomain publishing (e.g. "publish to demo.lanvo.app", "发布到 demo.lanvo.app", "deploy to myapp.lanvo.app").
---

# HTMLShare

Use this skill to publish static HTML projects to HTMLShare.

## Workflow

1. If the user has not provided an HTML, ZIP, or project directory path, find or create the static artifact first.
2. If the user specifies a target domain — e.g. "publish to demo.lanvo.app", "发布到 demo.lanvo.app", "deploy to myapp.lanvo.app" — extract the hostname and pass it as `--domain`. Examples of user intent → flag mapping:
   - "发布到 demo.lanvo.app" → `--domain demo.lanvo.app`
   - "publish to myapp.lanvo.app" → `--domain myapp.lanvo.app`
   - "deploy to lanvo subdomain demo" → `--domain demo.lanvo.app`
3. Run the bundled publisher:

```bash
node scripts/publish-htmlshare.mjs path/to/index.html
```

You can also pass a project directory:

```bash
node scripts/publish-htmlshare.mjs path/to/project-dir
```

To update an existing preview link in place, pass the current preview URL, slug, or project ID:

```bash
node scripts/publish-htmlshare.mjs path/to/project-dir --replace https://preview.htmlshare.dev/abc123/index.html
```

To publish to a custom Lanvo subdomain (requires a paid plan or free trial):

```bash
node scripts/publish-htmlshare.mjs path/to/project-dir --domain myapp.lanvo.app
```

If the subdomain is already linked to a project you own, this automatically updates that project. If not, it publishes a new project and binds the subdomain. You can combine `--replace` and `--domain` to explicitly target a project and bind a subdomain in one command.

3. If no token is stored, or if the stored token is expired/revoked, the script prints a login URL and opens it in the browser. The same publisher process is also running a temporary localhost callback server on `127.0.0.1:38765`; keep that process running until the browser returns from login and the upload completes.
4. If you need the user to complete Google login, tell them to finish login in the browser, but do not stop, cancel, or restart the publisher task. Poll or wait for the existing task output after the user finishes. If your shell tool requires a timeout, use at least 10 minutes for the publisher command.
5. After the script prints the published URL, give that URL to the user.

## Notes

- Default app URL: `https://htmlshare.page`.
- Override with `HTMLSHARE_BASE_URL` for staging or local development.
- Passing `index.html` uploads allowed static files from the same directory, including CSS, JS, images, fonts, JSON, and text files.
- Passing another `.html` file uploads only that file.
- Passing `--replace` keeps the existing preview URL and swaps in a new deployment for that project.
- The CLI session is stored at `~/.htmlshare/config.json`.
- If authorization fails, the publisher clears the invalid token, opens the login page, and retries once after authorization.
- Free accounts can publish up to 10 projects total. Deleted projects still count toward this lifetime publish limit, so do not tell users to delete old projects to free a slot. If the publisher returns `project_limit_reached`, tell the user to upgrade at `https://www.htmlshare.page/pricing` or use another account.
- `ERR_CONNECTION_REFUSED` on `127.0.0.1:38765/auth/callback` means the publisher process was stopped before login returned. Run the same publish command again and keep it alive while logging in.
- When using `--domain`, some labels are reserved system subdomains (e.g. `test`, `dev`, `staging`, `api`) and will be rejected with `label_reserved`. Choose a unique label specific to your project.
- `--domain` errors and their meanings:
  - `label_reserved` (400): the label is a reserved system subdomain.
  - `label_unavailable` (409): the subdomain is taken by another user. Choose a different label.
  - `domain_plan_required` (403): subdomain binding requires upgrading at `https://www.htmlshare.page/pricing` or using the free trial.
  - `domain_limit_reached` (403): you have reached the subdomain limit for your plan.
- If a `--domain` bind fails after a successful publish, the published URL is printed before the error so the content is not lost.

## JSON state for prototypes

HTMLShare is still static hosting. Signed-in projects can persist one JSON object/array (max 64KB) so a demo can survive a phone switch. This is not a database. If the user wants remote demo state, put the `fetch` calls below in the published HTML; do not add a custom backend.

**Per-project blob** (Free/Pro/Max, not Guest):

```js
const state = await fetch("/__htmlshare/state").then((response) => response.json());
await fetch("/__htmlshare/state", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...state, step: 2 }),
});
```

Use a leading `/`. Empty state is `{}`. Last write wins. Re-publishing HTML keeps the blob; deleting or expiring the project deletes it. Custom Lanvo domains can use the same per-project blob. A page must not read or write another project's `/__htmlshare/state`.

**User blob** (Pro/Max only, only on `preview.htmlshare.dev`):

```js
const token = document.querySelector('meta[name="htmlshare-user-state"]')?.content;
if (!token) throw new Error("User state is not available on this preview.");
const shared = await fetch("/__htmlshare/user-state", {
  headers: { Authorization: `Bearer ${token}` },
}).then((response) => response.json());
await fetch("/__htmlshare/user-state", {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ ...shared, theme: "dark" }),
});
```

Anyone who opens any of the owner's preview links can read that meta token and therefore the user blob. Guest previews and Lanvo hosts do not have user-state. Do not use cookies. Do not treat this as auth or a backend.
