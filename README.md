# DeepAI Bridge

An OpenAI-compatible server on `127.0.0.1` that lets **OpenCode** use DeepAI's
models — free and paid — with your own DeepAI account.

It speaks the DeepAI Code lane directly, so OpenCode sees a normal OpenAI
provider while the lane sees the same request shape it expects from its own
client. No desktop app has to stay open, and nothing is exposed to the network.

> **Windows 10/11 only.** Loopback only. Your key stays on your machine.

> ⚠️ **Read this first.** DeepAI's Terms of Service, section 4, prohibit other
> applications that interact with the service without written consent. This
> project is not affiliated with DeepAI, is shared for personal use, and may put
> your account at risk. Use an account you can afford to lose. No warranty.

---

## What you get

- **Every model in the DeepAI catalog** (28 at the time of writing) — 12 free,
  16 paid — with their context limits.
- **Prices in the model picker**, e.g. `GLM 5.3 · 3 Theos`, `GLM 5.3 Flash · free`.
- **Streaming, tools, system prompts, prompt caching** — request bodies pass
  through untouched apart from the model id.
- **A control panel** at `http://127.0.0.1:8788/`: live status, your Theos
  balance, the full model table with prices, recent turns, autostart.
- **A one-double-click installer** for Windows, with an uninstaller.
- **Zero dependencies.** Node built-ins only; no `npm install`, no build step.
- **Autostart** (optional) so the bridge is up when you sign in.

---

## Requirements

| You need | Notes |
| --- | --- |
| Windows 10 or 11 | The launchers and autostart are Windows-specific. |
| A DeepAI account | The bridge signs in as you and bills your own Theos. |
| Node.js 20.11+ | Optional: the installer fetches a private copy if missing. |
| OpenCode | Desktop app or CLI. Any recent version. |

---

## Install

1. Extract this folder (don't run from inside the zip).
2. Double-click **`Install.cmd`**.
3. Approve the DeepAI sign-in in your browser when it opens.

That's the whole install. The script:

1. Finds Node.js, or downloads a private `node.exe` into
   `%LOCALAPPDATA%\deepai-bridge\runtime` (about 90 MB, once; no admin rights and
   no `PATH` changes).
2. Copies the app to `%LOCALAPPDATA%\deepai-bridge\app`, so this folder can be
   deleted afterwards.
3. Runs the browser sign-in and saves the key locally.
4. Starts the bridge hidden and waits for `/health`.
5. Checks the lane (check-in, catalog, machine id).
6. Writes the DeepAI provider into your OpenCode config.
7. Creates **DeepAI Bridge** shortcuts on the desktop and start menu.
8. Asks whether to start automatically at sign-in (default yes).

When it finishes, the control panel is already open and the bridge is running.

### Where things live

| What | Where |
| --- | --- |
| App files | `%LOCALAPPDATA%\deepai-bridge\app` |
| Sign-in key | `%LOCALAPPDATA%\deepai-bridge\secrets.json` |
| Log | `%LOCALAPPDATA%\deepai-bridge\bridge.log` (rotated at 2 MB) |
| Logon entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\DeepAIBridge` |
| OpenCode config | `%USERPROFILE%\.config\opencode\opencode.json` |

### Manual install (no installer)

```bash
npm run auth          # browser sign-in, writes the key file
npm run doctor        # check-in, catalog, machine id
npm start             # serve on 127.0.0.1:8788
npm run config:global # write the provider block into OpenCode
```

`DeepAI Bridge.vbs` does the same start without a console window and opens the
panel.

---

## Use it from OpenCode

The installer adds the provider automatically. If you configured it by hand,
make sure `providers.deepai` is present, then:

```
/models          ->  DeepAI / GLM 5.3 Flash · free
```

One-shot turns:

```bash
opencode run --model deepai/glm-5.3-flash "say hello"
opencode run --model deepai/claude-opus-5-5 "say hello"   # 15 Theos
```

Model ids are the catalog ids, unchanged. The bridge strips an optional
`MODEL_SUFFIX` if you set one.

### Free vs paid

- Free models cost nothing and run concurrently.
- Paid models spend Theos. They take one slot at a time (FIFO), exactly like the
  shipped client's admission, and `409 session_busy` is retried rather than
  surfaced.
- The price next to a model is the catalog's per-request price. Your **balance**
  is a separate, finer number the lane reports; the panel always shows the
  lane's own figure rather than guessing.

---

## The control panel

`http://127.0.0.1:8788/` is served by the bridge itself, so if it loads, the
bridge is up.

- **Bridge** — endpoint, API base, uptime, build and where the build version came
  from, the signed-in account, the default model.
- **Theos** — live balance, daily grant, used since the grant, reset time, when it
  was last read. Refreshed in the background and after each metered turn;
  `Refresh` forces it.
- **Models** — every model with its cost (`free`, `2 Theos`, …), context window,
  and the exact id to copy. Filter by All / Free / Paid.
- **Activity** — turns, failures, what is running now, and a tail of recent turns
  with status, price and latency.
- **Startup** — autostart toggle, copy buttons, and the log path.

Inference routes refuse any request that carries an `Origin` header, and control
routes need a same-origin request plus `X-Bridge-Control: 1`, so a random web
page cannot drive your account or stop the bridge.

---

## How it works

```
OpenCode  ->  http://127.0.0.1:8788/v1  ->  DeepAI Code lane
```

- The bridge owns the key and performs its own liveness check-in, independent of
  the desktop app.
- Headers mirror the shipped client: check-in nonce and beacon on the liveness
  call; a lane version, a per-process instance id, the machine digest and the key
  on inference.
- The machine digest hashes the SMBIOS UUID on Windows (the same identifier the
  client prefers), so the lane binds the session to this PC as usual.
- Streaming responses are passed through as they arrive. Refusals come back
  verbatim, with status and headers.
- Metered turns are serialized; free turns run concurrently.
- The advertised build version is read from the installed app when present, so
  the beacon follows the current release without a code change.

There is no telemetry beyond what the lane itself receives, and no credential is
ever written to the log.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `src/lane.mjs` | Upstream client: check-in, catalog, inference, retries, timeouts. |
| `src/proxy.mjs` | OpenAI surface: model ids, streaming, errors, usage tickets. |
| `src/dashboard.mjs` | Control panel API and static assets. |
| `src/usage.mjs` | In-memory turn ledger for the panel. |
| `src/machine.mjs` | Machine digest for the lane header. |
| `src/version.mjs` | Build version for the beacon. |
| `src/autostart.mjs` | Windows logon entry. |
| `src/config.mjs`, `src/paths.mjs` | Constants and on-disk locations. |
| `ui/` | The control panel: `index.html`, `app.js`, `style.css`. |
| `scripts/gen-config.mjs` | Writes the provider block from the live catalog. |
| `install.ps1` | Installer and uninstaller. |
| `Install.cmd`, `Uninstall.cmd` | Double-click entry points. |
| `DeepAI Bridge.vbs`, `start-hidden.vbs` | Windowed and silent launchers. |
| `auth.mjs` | One-time browser sign-in (PKCE). |
| `doctor.mjs` | Preflight: check-in, catalog, machine id, optional test turn. |
| `smoke.mjs` | Three live turns against a running bridge. |
| `test/e2e.mjs` | Offline suite against a fake lane. |

---

## Development

No dependencies, no build step. Node 20.11+.

```bash
npm test        # offline: real proxy, fake lane, 20 checks, no key required
npm run smoke   # live: three free turns through the running bridge
npm run doctor  # lane preflight; --chat spends one tiny turn
npm run config  # regenerate ./opencode.json
```

`npm test` covers alias mapping, streaming pass-through, the header fingerprint,
beacon placement, slot admission, refusal pass-through, catalog prices, the
dashboard and its state, balance handling, control-plane authorization, and the
offline catalog fallback.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Install.cmd` closes instantly | PowerShell refused the script | open a terminal in this folder and run `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` |
| Setup stops while fetching Node | no internet, or a proxy blocks nodejs.org | install Node.js LTS from https://nodejs.org (tick "Add to PATH"), rerun `Install.cmd` |
| Setup stops at sign-in | the browser tab was not approved within five minutes | rerun `Install.cmd`; it opens a fresh approval page |
| DeepAI page says the app is not running | some accounts need the desktop app for the handshake | open DeepAI Code once, finish sign-in, close it, rerun `Install.cmd` |
| Every turn: `This request cannot be accepted.` | no system message, or a machine digest the lane does not expect | the bridge adds a neutral system turn when you send none; run `npm run doctor` and check the machine digest |
| `machine_required` / `machine_bound` | no machine id readable, or the account is bound elsewhere | set `DEEPAI_MACHINE_ID` to the SMBIOS UUID (lowercase) |
| `theos_exhausted` | out of daily credits | wait for the reset, or use a cheaper model |
| `409 session_busy` | another metered turn holds the slot | the bridge retries automatically; wait or use a free model |
| Panel says offline | the bridge process stopped | double-click the desktop shortcut; the log says why |
| Autostart toggle bounces back | registry write refused | check the error toast; entry is `HKCU\...\Run\DeepAIBridge` |
| Model unavailable in OpenCode | the model id is not in the catalog | copy the exact id from the panel's model table |
| Balance looks stale | it is re-read periodically and after metered turns | press `Refresh` in the panel |

---

## Uninstall

Double-click **`Uninstall.cmd`**. It stops the bridge, removes the shortcuts and
the logon entry, and asks whether to delete the saved sign-in and logs. The
OpenCode config is left alone; delete the `providers.deepai` entry by hand if you
want it gone.

---

## Notes and limits

- The port is loopback-only. Do not expose or forward it; it acts as your
  account.
- One client per account: close the DeepAI desktop app while the bridge is in
  use, or the lane may answer `This request cannot be accepted.`
- The bridge depends on an undocumented lane. If DeepAI changes it, expect
  breakage; the log and `doctor` are the places to look.
- This is a personal project with no support guarantee and no license grant.
  DeepAI, OpenCode and their marks belong to their owners.
