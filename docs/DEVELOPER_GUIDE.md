# Developer Guide

## Run locally

Requires Node 22+ and Docker.

```bash
npm install
npm run setup:local   # creates .env with local values
npm run db:up         # PostgreSQL in Docker
npm run db:migrate
npm run seed          # sample data and test accounts
npm run start:local   # API, worker and dashboard
```

- Dashboard: <http://localhost:3001> (test accounts are written to `.local/`)
- API: <http://localhost:3000>
- Send sample leads: `npm run simulate`

There is no local SFTP server; consent recording uploads are tested on Railway.

## Project structure

| Folder | Contents |
|---|---|
| `apps/api` | REST API for lead providers and the admin API (Fastify) |
| `apps/worker` | Background jobs: lead delivery, recording pick-up, retention |
| `apps/admin` | Admin dashboard (Next.js) |
| `packages/*` | Shared code: configuration, database, jobs, destinations, recordings |
| `infra/railway` | Railway service settings (reference) |

## How it works

1. A provider sends a lead to `POST /v1/leads` with its API key. The lead is validated, checked for duplicates and stored (personal data encrypted).
2. The worker delivers it to the destination (mock or HubSpot), with retries.
3. The provider uploads the consent recording to our SFTP server (SFTPGo). The worker picks it up, matches it to the lead and stores it encrypted.
4. Staff and providers follow everything in the dashboard.

## Commands

| Command | What it does |
|---|---|
| `npm test` | All tests (needs Docker for the test database) |
| `npm run lint` / `npm run typecheck` / `npm run format` | Code checks |
| `npm run admin -- <command>` | Operator CLI (sources, keys, users); see `apps/api/src/cli/index.ts` |

## Configuration

Settings are read from environment variables; `.env.example` lists them. Local values are created by `npm run setup:local`. Never commit `.env`.
