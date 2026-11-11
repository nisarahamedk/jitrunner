# jitrunner

GitHub Actions runners that cost nothing while idle. Jobs run on **your own machines first**, like an old laptop or a
box under your desk. When none is free, jitrunner starts a **fresh Hetzner Cloud server for that one job** and
deletes it when the job ends.

The controller is a single Cloudflare Worker. It needs no server, no database and no state of its own, and runs on
Cloudflare's free plan.

```
job queued ─► GitHub webhook ─► Worker
                                 ├─ one of your machines is free? let it take the job
                                 └─ otherwise: JIT runner config ─► new Hetzner server ─► runs the one job ─► deleted
cron, every minute ─► Worker: catch jobs still waiting, delete servers that are done, idle, stuck or too old
```

## Why

- **Per-job servers are cheap.** A Hetzner `cx23` (2 vCPU, 4 GB) costs about $0.01 an hour, and GitHub charges
  nothing for self-hosted runner minutes. A hundred 10-minute jobs comes to about $1.
- **Every job gets a clean machine.** Each server runs one job with a
  [just-in-time runner](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository)
  and is then destroyed. Nothing leaks from one job to the next, so jobs that hold deploy credentials can run here.
- **Your own hardware is used first.** If a machine of yours with the right labels is online and idle, jitrunner
  waits `GRACE_SECONDS` for GitHub to give it the job before paying for a server.
- **Nothing to babysit.** All state lives in Hetzner server labels and GitHub's runner list, so a lost webhook, a
  restart or a crash costs at most a minute. Spend is capped by `MAX_SERVERS` and `MAX_AGE_SECONDS`.

## How a job opts in

```yaml
jobs:
  test:
    runs-on: [self-hosted, jit] # your machines with the `jit` label, else a fresh server
  deploy:
    runs-on: [self-hosted, jit, ephemeral] # fresh server only: don't give your machines the `ephemeral` label
```

A JIT server's runner registers with exactly the labels the job asked for, plus `self-hosted`, `Linux` and `X64`
(or `ARM64` on `cax` types).

## Setup

You need a Cloudflare account, a Hetzner Cloud project, and about 15 minutes.

1. **Hetzner.** Create a project just for CI, so jitrunner can never touch anything else, and an API token for it
   (Security → API tokens → Read & Write).
2. **Deploy the Worker.**
   ```sh
   pnpm install
   pnpm wrangler deploy
   ```
   Note its URL, for example `https://jitrunner.<you>.workers.dev`.
3. **Create a GitHub App** (Settings → Developer settings → GitHub Apps → New GitHub App):
   - Webhook URL: `https://jitrunner.<you>.workers.dev/webhook`. Set a webhook secret (`openssl rand -hex 32`).
   - Repository permissions: **Administration: Read and write** (to create and remove runners) and **Actions: Read**
     (to find queued jobs).
   - Subscribe to events: **Workflow job**.
   - "Only on this account". Create it, note the App ID, and generate a private key (.pem).
   - Install the app on the repositories that should use jitrunner.
4. **Give the Worker its secrets.**
   ```sh
   pnpm wrangler secret put GITHUB_APP_ID
   pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY < your-app.private-key.pem
   pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
   pnpm wrangler secret put HCLOUD_TOKEN
   ```
5. **Try it.** Push a workflow with `runs-on: [self-hosted, jit]`. A server named `jit-<job id>` appears in
   Hetzner, takes the job, and disappears after it. `pnpm wrangler tail` shows each decision.

### Faster boots with a snapshot

On stock `ubuntu-24.04`, each server installs the runner before its job, which takes about a minute. A snapshot skips
that and can include your own tools (browsers, Docker, language runtimes):

```sh
HCLOUD_TOKEN=... pnpm build-image --extra my-setup.sh
```

Put the snapshot id it prints in `IMAGE` and deploy again. Snapshots cost about $0.02 per GB a month. Rebuild now and
then: the runner updates itself on boot when the baked one is old, which works but is slower.

### Your own machines: the agent

The agent (`agent/agent.mjs`) lets a machine you own, such as an old laptop or a box under the desk, take jobs
before jitrunner pays for a server. Every few seconds it tells the Worker how many free slots it has. The Worker
hands it one-time runner configs for queued jobs it can run, and the agent runs each job in a **fresh Docker
container** (`runner/Dockerfile`) that is removed afterwards. Nothing listens on your machine, and no GitHub or
Hetzner token is ever on it.

While an agent is up, a queued job waits `AGENT_GRACE_SECONDS` (default 20) for it before getting a server. A busy
or switched-off agent stops asking for work, and jobs stop waiting for it within five minutes.

1. Bind a KV namespace where agents leave a sign of life:
   ```sh
   pnpm wrangler kv namespace create jitrunner-agents
   ```
   Add it to `wrangler.jsonc` as `"kv_namespaces": [{ "binding": "AGENTS", "id": "<its id>" }]` and deploy again.
2. On the machine (Ubuntu, Debian or Mint):
   ```sh
   curl -fsSLO https://raw.githubusercontent.com/nisarahamedk/jitrunner/main/agent/install.sh
   sudo JITRUNNER_URL=https://jitrunner.<you>.workers.dev bash install.sh
   ```
   It makes the machine's own agent token, keeps it there (root only), and prints the token's SHA-256.
3. Give the Worker that hash. With several machines, list one hash per machine, comma separated, so you can drop one
   without touching the others:
   ```sh
   echo <hash>[,<hash>...] | pnpm wrangler secret put AGENT_TOKEN_SHA256
   ```
   This installs Docker, builds the job image and starts the `jitrunner-agent` service. `JITRUNNER_SLOTS=2` runs two
   jobs at once.

The job container has passwordless `sudo`, so steps like `sudo apt-get install` and
`playwright install --with-deps` work. It also gets 2 GB of shared memory for browsers. Jobs that need Docker
themselves (service containers, `docker build`) are not supported in the container.

Agents never offer the `ephemeral` label. The machine is not wiped between jobs, and a container shares its kernel,
so jobs holding production credentials stay on `[self-hosted, jit, ephemeral]`, which always means a fresh server.

Any ordinary
[self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners)
with the label `jit` works too. jitrunner sees it in GitHub's runner list and lets it take jobs first for
`GRACE_SECONDS`. It just runs every job on the bare machine.

## Settings

Vars in `wrangler.jsonc`:

| Var                    | Default          | Meaning                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LABEL`                | `jit`            | Jobs whose `runs-on` includes this label are jitrunner's                                                                                                                                                                                                           |
| `NAME_PREFIX`          | `jit`            | Servers and runners are named `<prefix>-<job id>`; servers carry the label too                                                                                                                                                                                     |
| `SERVER_TYPE`          | `cx23`           | Any Hetzner Cloud type; `cax*` is Arm                                                                                                                                                                                                                              |
| `SERVER_TYPE_BY_LABEL` | (none)           | A type per job label, first match wins: `ephemeral=cx23` puts short jobs on a smaller server                                                                                                                                                                       |
| `LOCATION`             | `fsn1,nbg1,hel1` | Hetzner locations, tried in order when one has no room for `SERVER_TYPE`                                                                                                                                                                                           |
| `IMAGE`                | `ubuntu-24.04`   | An image name or a snapshot id                                                                                                                                                                                                                                     |
| `MAX_SERVERS`          | `3`              | Never more JIT servers than this at once; jobs past it wait                                                                                                                                                                                                        |
| `GRACE_SECONDS`        | `30`             | How long a job waits for one of your free machines before getting a server                                                                                                                                                                                         |
| `BOOT_GRACE_SECONDS`   | `600`            | How long a new server may take to register its runner                                                                                                                                                                                                              |
| `IDLE_SECONDS`         | `300`            | A runner with no job after this long gives up and its server is deleted                                                                                                                                                                                            |
| `REUSE_SECONDS`        | `0`              | Hetzner bills whole hours: a server whose job asked only for `self-hosted` + `LABEL` takes more such jobs until it has been up this long (2520 leaves 18 minutes for a last job), then powers off and is deleted. Needs `PUBLIC_URL` and the `AGENTS` KV namespace |
| `PUBLIC_URL`           | (none)           | This Worker's URL, which reused servers ask for their next job                                                                                                                                                                                                     |
| `SWAP_GB`              | `0`              | A swap file of this many GB on every server, so a memory peak (a type check, a build) slows a job instead of killing it                                                                                                                                            |
| `MAX_AGE_SECONDS`      | `21600`          | Every server is deleted at this age, busy or not (GitHub's own job limit is 6 h)                                                                                                                                                                                   |
| `AGENT_GRACE_SECONDS`  | `20`             | While an agent is up, how long a job waits for it (at most 25)                                                                                                                                                                                                     |
| `ALLOW_PUBLIC_REPOS`   | `false`          | Leave off unless you know what fork pull requests can do on self-hosted runners                                                                                                                                                                                    |

## Security notes

- A JIT config is a one-time credential for one runner name. It reaches the server only as Hetzner user data. No
  GitHub or Hetzner token is ever on a server.
- Servers are created with an SSH key whose private half is thrown away, so nobody can log in. This also stops Hetzner
  from emailing a root password for every server.
- On public repositories, anyone can open a pull request, and their workflow would run on your servers. That's why
  public repos are refused unless `ALLOW_PUBLIC_REPOS` is `true`.
- The Worker only ever deletes Hetzner servers labeled `jitrunner=<NAME_PREFIX>`.

## Costs, roughly

| Thing                 | Cost                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| Cloudflare Worker     | Free plan: a cron each minute plus your webhooks fit comfortably       |
| Hetzner `cx23` + IPv4 | About $0.011 per hour, billed per started hour while the server exists |
| Snapshot (optional)   | About $0.02 per GB a month                                             |
| GitHub                | Self-hosted runner minutes are free                                    |

Hetzner prices and billing rules change; check theirs.

## Development

```sh
pnpm check   # types, formatting, tests
```

The decisions (when to create, when to delete) are pure functions in `src/plan.ts`, tested in `test/plan.test.ts`.

## License

MIT
