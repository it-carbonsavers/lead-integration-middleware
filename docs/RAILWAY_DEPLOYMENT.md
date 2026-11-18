# Deployment (Railway)

## Services

| Service | Purpose |
|---|---|
| Postgres | Database |
| Bucket | Storage for uploaded and encrypted recordings |
| sftpgo | SFTP server lead providers upload recordings to |
| api | Lead API and admin API |
| worker | Background jobs |
| admin | Admin dashboard |

## Steps

1. Create the project, Postgres and a bucket.
2. Add **sftpgo** from the `drakkan/sftpgo` Docker image, with a volume for its data and a TCP proxy for SFTP.
3. Add **api**, **worker** and **admin** from this repository. Set each service's environment variables (names in `.env.example`) in Railway; keep secrets only in Railway.
4. The api runs database migrations before each deploy (`node packages/db/dist/bin/migrate.js up`).
5. Generate public domains for **api** and **admin**.
6. Create the first dashboard user from a shell on the api service:

   ```bash
   node apps/api/dist/cli/index.js user:create --email you@example.com --name "Your Name"
   ```

## Test SFTP

1. In the dashboard, open a lead source → **Consent recordings**, set up its SFTP account and press **Test connection**.
2. Send a test lead with a recording reference, upload a matching file (samples in `docs/samples/recordings/`) with any SFTP client, then press **Check for new files**.
3. The lead's page should show the recording as matched.
