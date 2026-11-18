# Lead Integration Middleware

Receives leads from external lead providers through a one-way REST API, tracks them, and delivers them to a configurable destination (HubSpot: Contact + Lead, no Deal). Lead providers upload consent recordings to our SFTP server; recordings are matched to their leads and stored encrypted. An admin dashboard provides search, status, reports, an audit log and provider portal logins.

HubSpot delivery is built but switched off until approved; leads go to a mock destination.

## Documentation

| Document | Purpose |
|---|---|
| [Developer guide](docs/DEVELOPER_GUIDE.md) | Run and develop locally, project structure |
| [Deployment](docs/RAILWAY_DEPLOYMENT.md) | Deploy to Railway |
| [Operations](docs/OPERATIONS.md) | Everyday tasks and troubleshooting |
| [Provider integration guide](docs/PROVIDER_INTEGRATION_GUIDE.md) · [OpenAPI](docs/openapi.json) | For lead providers |

## Quick start

Requires Node 22+ and Docker.

```bash
npm install && npm run setup:local && npm run db:up && npm run db:migrate && npm run seed
```

Then `npm run start:local` and open <http://localhost:3001>.
