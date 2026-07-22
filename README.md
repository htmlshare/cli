# HTMLShare CLI

site: [www.htmlshare.page](https://www.htmlshare.page)

Log in once from your terminal:

```bash
npx @htmlshare/cli login
```

Publish a local HTML file or static project directory:

```bash
npx @htmlshare/cli publish ./dist
```

Update an existing preview link in place:

```bash
npx @htmlshare/cli update ./dist --replace https://preview.htmlshare.page/abc123/index.html
```

Install the HTMLShare Skill from the npm package contents:

```bash
npx @htmlshare/cli install
```

By default this installs to Codex:

```text
~/.codex/skills/htmlshare
```

You can choose an agent explicitly:

```bash
npx @htmlshare/cli install --agent codex
npx @htmlshare/cli install --agent claude
npx @htmlshare/cli install --agent cursor
npx @htmlshare/cli install --agent all
```

The package ships the Skill source files directly. It does not download the Skill zip during installation.
Login sessions are stored at `~/.htmlshare/config.json`.
