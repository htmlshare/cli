---
name: htmlshare
description: Publish AI-generated HTML prototypes to HTMLShare and return a shareable preview URL. Use when the user asks to publish, upload, share, preview, or deploy an HTML page through HTMLShare.
---

# HTMLShare

Use this skill to publish static HTML projects to HTMLShare.

## Workflow

1. If the user has not provided an HTML, ZIP, or project directory path, find or create the static artifact first.
2. Run the bundled publisher:

```bash
node scripts/publish-htmlshare.mjs path/to/index.html
```

You can also pass a project directory:

```bash
node scripts/publish-htmlshare.mjs path/to/project-dir
```

3. If no token is stored, or if the stored token is expired/revoked, the script prints a login URL and opens it in the browser. The same publisher process is also running a temporary localhost callback server on `127.0.0.1:38765`; keep that process running until the browser returns from login and the upload completes.
4. If you need the user to complete Google login, tell them to finish login in the browser, but do not stop, cancel, or restart the publisher task. Poll or wait for the existing task output after the user finishes. If your shell tool requires a timeout, use at least 10 minutes for the publisher command.
5. After the script prints the published URL, give that URL to the user.

## Notes

- Default app URL: `https://htmlshare.page`.
- Override with `HTMLSHARE_BASE_URL` for staging or local development.
- Passing `index.html` uploads allowed static files from the same directory, including CSS, JS, images, fonts, JSON, and text files.
- Passing another `.html` file uploads only that file.
- The CLI session is stored at `~/.htmlshare/config.json`.
- If authorization fails, the publisher clears the invalid token, opens the login page, and retries once after authorization.
- Free accounts can publish up to 10 projects total. Deleted projects still count toward this lifetime publish limit, so do not tell users to delete old projects to free a slot. If the publisher returns `project_limit_reached`, tell the user to upgrade at `https://www.htmlshare.page/pricing` or use another account.
- `ERR_CONNECTION_REFUSED` on `127.0.0.1:38765/auth/callback` means the publisher process was stopped before login returned. Run the same publish command again and keep it alive while logging in.
