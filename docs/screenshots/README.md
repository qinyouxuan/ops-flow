# Screenshot privacy checklist

Only screenshots from a disposable demonstration environment may be committed.
Do not capture a production or customer system and rely on blur alone.

## Recommended screenshots

1. Overview and server list
2. SSH terminal and remote file manager
3. Database browser and SQL editor
4. Redis browser
5. Workflow canvas and execution status
6. Deployer, backup/recovery, or encrypted configuration migration

Four to six screenshots are enough for the main README. Additional screenshots
should explain a specific workflow rather than repeat the same screen.

## Safe demonstration values

- Server: `demo-app-01`
- SSH user: `demo`
- Database: `demo_db`
- Service: `demo-api.service`
- Remote path: `/opt/demo-app`
- Redis key: `demo:cache:user`
- Documentation addresses: `192.0.2.10`, `198.51.100.20`,
  `203.0.113.30`

The documentation address ranges are not routable. Use a disposable local
environment for the actual connection, then make sure no real address remains
visible in the final image.

## Never include

- Real IP addresses, hostnames, ports combined with a reachable address, or SSH
  users
- Login banners, source addresses, kernel details, customer names, or uptime
  information from a real host
- Real directories, application names, services, database/schema/table names,
  query results, Redis keys or values
- Passwords, private keys, tokens, connection strings, exported configuration,
  backup file names, or command history
- Tool logs, terminal output, Windows account names, local paths, or temporary
  file locations that identify a real environment

Before committing an image, inspect it at full resolution and run the
repository sensitive-data scan from the release checklist.
