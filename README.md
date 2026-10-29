# Devdeck

A local control panel for your dev projects on Windows. Point it at the folder where you keep your code and every
`package.json` becomes a one-click terminal; MySQL and phpMyAdmin from XAMPP show up as services.

- **Projects:** scripts as buttons, real terminals in the browser (PowerShell via ConPTY + xterm.js), tabs or side by side, Start all / Stop all.
- **Requirements:** per project checklist (Node version, installed dependencies, needed services, `.env` vs `.env.example`, database) with one-click fixes.
- **Usage:** CPU and memory charts for the whole PC and per project, uptime and a sparkline for every process.
- **Services:** MySQL / Apache (phpMyAdmin) / any command, with port health, uptime even when started elsewhere, log viewer, Docker containers.
- **Databases:** list, backup, restore (with an automatic safety copy), scheduled backups, backup before `git pull`.
- **Git:** changes with diffs, commit selected files, history, fetch / pull / push.
- **Access:** sign-in on every device, optional TOTP two-factor, open from another PC on your network.

## Run

Needs Node.js 24+ (TypeScript runs natively, no build step).

```sh
npm install
npm start          # http://localhost:4321
```

The first visit on the host PC creates your account. Settings has "Start with Windows" and a desktop shortcut.

| Script | What it does |
|---|---|
| `npm run dev` | restart on file changes (stops the terminals Devdeck runs) |
| `npm test` | self-tests of every server module |
| `npm run typecheck` | `tsc` for the server and the browser code |
| `npm run reset -- <user> <new password>` | locked out: new password, MFA off |

Everything Devdeck stores (config, accounts, backups) lives in `data/`, which is not part of the repository.

## Security notes

The server can run commands on your PC, so every request needs a session; it checks the Host and Origin headers,
rate-limits sign-in and keeps only hashes of passwords and session tokens. Traffic is plain HTTP: use network access only on a network you trust.
