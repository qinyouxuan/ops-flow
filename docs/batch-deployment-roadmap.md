# Batch deployment and lightweight cluster orchestration

This document captures the project direction for batch deployment, lightweight cluster deployment, system inspection, and audit-style checks.

## Product positioning

Ops Flow Plus combines single-machine operations with repeatable operations across multiple machines:

- Batch deployment
- Workflow orchestration
- Package deployment
- System inspection
- Pre-flight and post-deployment checks
- AI-assisted failure analysis and report summaries

Avoid positioning the first version as a full compliance audit platform. Compliance rules vary by customer, region, industry, and internal policy. Use "system inspection", "security baseline check", or "deployment pre-flight check" first, then allow customer-specific audit templates later.

## Phase 1: Batch workflow run

Goal: run the same workflow against one or more selected servers while keeping every server's progress visible.

Scope:

- Run workflow dialog
- Select one or more saved servers
- Automatically test/connect disconnected servers before node execution
- Configure concurrency
- Configure failure strategy
- Configure execution mode
- Create separate transfer history items per target server
- Track the connection step in Transfers before workflow nodes run
- Keep per-step logs for workflow nodes
- Support retry later from failed server context

Run configuration:

- Target servers: current server, connected servers, server groups later
- Disconnected servers: selected normally; the run creates a "Connecting" step first
- Concurrency: 1, 2, 3, 5
- Failure strategy:
  - Stop on first failure
  - Continue and summarize
- Execution mode:
  - Parallel batch
  - Rolling one-by-one
- Variables later:
  - Package path
  - Deploy directory
  - Service name
  - Health check URL

Execution model:

```text
Workflow: Deploy package
Targets: app-01, app-02, app-03

app-01
  upload -> stop service -> backup -> unpack -> start -> verify

app-02
  upload -> stop service -> backup -> unpack -> start -> verify

app-03
  upload -> stop service -> backup -> unpack -> start -> verify
```

Each server run should be independent. A failure on one server should not hide logs from another server.

Progress model:

```text
Connect server
Workflow node 1
Workflow node 2
...
Workflow node N
```

If the connection step fails, that server's transfer task is marked failed and the rest of the workflow nodes are skipped for that server.

## Phase 2: Role-based deployment

Goal: allow a workflow node to run only on matching server roles.

Server roles:

- web
- app
- db
- redis
- lb
- custom tags

Examples:

- Database node runs only on `db`
- App deploy node runs only on `app`
- Nginx reload node runs only on `lb`
- Redis cleanup runs only on `redis`

This should be optional. Simple workflows should still run against every selected server.

## Phase 3: Topology and dependency order

Goal: support lightweight cluster plans without becoming a full Kubernetes or Ansible replacement.

Capabilities:

- Ordered stages
- Rolling deployment
- Canary batches: 20%, 50%, 100%
- Health check gates
- Manual approval gates
- Rollback plan
- Dependency checks

Example:

```text
1. Pre-flight check all nodes
2. Backup database
3. Deploy app nodes one by one
4. Reload load balancer
5. Verify service endpoint
6. Generate deployment report
```

## System inspection and audit direction

Start with practical inspection instead of strict compliance:

- OS, kernel, uptime
- Runtime versions
- Services and startup status
- Open ports
- SSH configuration
- Firewall state
- Sudo users
- Failed login summary
- Cron entries
- Package inventory
- Sensitive file permissions

Report output:

- HTML
- Excel
- Markdown
- Risk levels: high, medium, low

Future audit templates:

- Generic Linux baseline
- Internal company baseline
- Customer-specific checklist
- Industry-specific templates

Do not claim compliance by default. The report should say "inspection result" or "baseline check result" unless a customer-provided standard is explicitly selected.

## Why this comes before full cluster deployment

Full cluster deployment is complex because it involves topology, roles, ordering, failure isolation, rollback, and health gates. Batch workflow run is the smallest valuable step:

- It reuses current servers
- It reuses Workflow
- It reuses Transfers
- It is easy to explain
- It immediately saves operational time

The project can grow from batch execution into role-based deployment and finally topology-aware deployment.
