# Deploying The Gilded Quill to Coolify

```
push to main ──► GitHub Actions ──► builds backend + frontend ──► pushes to ghcr.io (private)
                                                              └─► asks Coolify to redeploy
                                              your server (Coolify) ◄── pulls the images itself, with its own token
```

The images live in **private** packages, the pipeline only *pushes*, and the **only** thing that pulls them is your server,
signed in to `ghcr.io` with a read-only token that exists only there.

## 1. GitHub

In **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `COOLIFY_TOKEN` | A Coolify API token (Coolify → *Keys & Tokens* → *API tokens*, with the *read* and *deploy* permissions (read lets the workflow follow the deployment until it finishes); enable the API in *Settings* first) |
| Secret | `COOLIFY_URL` | Your Coolify address, e.g. `https://coolify.example.com` |
| Secret | `COOLIFY_APP_UUID` | The deployed resource's UUID (in its Coolify URL: `…/application/<uuid>`) |
| Variable | `APP_URL` | The public address of the site, for the final health check (optional) |
| Variable | `IMAGE_PLATFORMS` | `linux/amd64` (default), or `linux/amd64,linux/arm64` if the server is ARM (optional) |

The Coolify address and the resource id are secrets (not variables) because this repository is public and variables appear in
its workflow logs.

Optionally, in **Settings → Environments → production**, add required reviewers: every deployment then waits for a click.

### Keep the images private (the repository is public)

A container package starts out private, but it can be made public, and a package linked to a public repository is easy to
expose by accident. After the **first** push, open the package on GitHub (your profile → *Packages* → `…/backend` and
`…/frontend` → *Package settings*) and check:

1. **Danger Zone → Change visibility** is **Private**.
2. **Manage Actions access** lists this repository with *Write* (so the pipeline can push), and *Inherit access from source
   repository* is **off** (otherwise the public repository's visibility can leak into the package).

The pipeline checks the visibility after every push and fails with a clear error if a package is public.

The workflows:

- `ci.yml`: on every pull request and push to `development`: backend tests (with a real PostgreSQL), frontend tests and
  production build, MCP server tests, and a build of both images (not pushed).
- `deploy.yml`: on push to `main` (or a `v*` tag, or by hand): builds and pushes both images, checks the package is private,
  asks Coolify to redeploy, waits for the deployment to finish, and checks `/healthz`.

Images are tagged `latest` (main), `sha-<commit>` (every build) and, for tags, the version.

## 2. The server pulls the images

Make a **classic personal access token** with only the `read:packages` scope (GitHub → Settings → Developer settings), and on
the Coolify server sign Docker in to the registry once, as the user Coolify runs Docker as (usually root):

```sh
echo "<the token>" | docker login ghcr.io -u <your GitHub user> --password-stdin
```

That token never leaves the server. It cannot push, and it is not in GitHub or in the pipeline.

## 3. Coolify

1. **New resource → Docker Compose**, from this repository, with the compose file `deploy/docker-compose.yml`
   (or paste its contents into the *Docker Compose Empty* type).
2. Set the environment variables from `deploy/.env.example` (at least `IMAGE_REPO`, `POSTGRES_PASSWORD`, `QUILL_ALLOWED_ORIGIN`).
3. Give the **`frontend`** service your domain (port `8080`). Coolify's proxy handles HTTPS, and the app sets secure cookies.
4. Deploy once from Coolify, then copy the resource UUID into the `COOLIFY_APP_UUID` variable on GitHub.

From then on, merging to `main` deploys.

## Rolling back

Set `IMAGE_TAG` in Coolify to an earlier `sha-<commit>` and redeploy. Switch back to `latest` to follow `main` again.

## Good to know

- **Data** lives in three volumes: `db-data` (PostgreSQL), `quill-data` (pictures, PDFs, documents), `tectonic-cache`.
  Back up `db-data` and `quill-data` (Coolify can schedule database backups).
- The **first compile** after a fresh server downloads the TeX files it needs (the backend warms this up at start).
- The site is served by **nginx** in the `frontend` image, which also passes `/api` and `/ws` on to the backend, so only one
  domain is needed.
- Mail (invitations, password resets, magic links) needs `QUILL_SMTP_URL`; without it the mails are only logged by the server.
