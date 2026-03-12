---
name: relight
description: Deploy and manage Docker containers across clouds with the Relight CLI. Use when the user wants to deploy apps, manage cloud providers, configure databases, set environment variables, manage domains, or work with multi-cloud infrastructure using Relight.
argument-hint: [command or question]
---

# Relight CLI

Relight deploys Docker containers across Cloudflare, GCP, AWS, and Azure with scale-to-zero. It provides a unified interface for multi-cloud deployment, databases, domains, and configuration.

## Installation

```
npm install -g relight-cli
```

## Quick Start

```bash
relight clouds add          # Add a cloud provider (interactive)
relight deploy myapp .      # Deploy from Dockerfile
relight open myapp          # Open in browser
```

## Architecture

Relight has two kinds of backends:

- **Clouds** (built-in): `cf` (Cloudflare Workers + Containers), `gcp` (Cloud Run), `aws` (App Runner), `azure` (Container Apps)
- **Services** (external): `slicervm` (self-hosted compute), `neon` (managed Postgres), `turso` (managed SQLite)

Projects can mix clouds and services. A `.relight.yaml` file in the project directory links it to a specific app/cloud.

## Command Reference

### Clouds

```bash
relight clouds              # List configured clouds
relight clouds add [name]   # Add cloud provider (cf, gcp, aws, azure)
relight clouds remove <name>
```

### Services

```bash
relight services            # List registered services
relight services add [name] # Register a service (slicervm, neon, turso)
relight services remove <name>
```

### Deploy

```bash
relight deploy [name] [path]        # Deploy from Dockerfile
  -c, --cloud <cloud>               # Target cloud (cf, gcp, aws, azure)
  --compute <name>                   # Target service name
  -e, --env KEY=VALUE ...            # Set env vars
  --regions <hints>                  # Comma-separated regions
  -i, --instances <n>                # Instances per region
  --port <port>                      # Container port (default: 8080)
  --sleep <duration>                 # Sleep after idle (default: 30s)
  --vcpu <n>                         # vCPU allocation
  --memory <mb>                      # Memory in MiB
  --dns <cloud>                      # Cross-cloud DNS provider
  -y, --yes                          # Skip confirmation
  --json                             # JSON output
```

If `name` is omitted, uses the linked app or auto-generates a name. If `path` looks like a directory, it's treated as the Dockerfile path.

### Apps

```bash
relight apps                        # List deployed apps
relight apps info [name]            # Show app details
relight apps destroy [name]         # Destroy app (requires confirmation)
relight destroy [name]              # Alias for apps destroy
```

### Config (Environment Variables)

```bash
relight config show [name]          # Show env vars
relight config set [name] KEY=VAL   # Set env vars (applies live)
relight config set [name] KEY=VAL -s  # Set as encrypted secret
relight config get [name] KEY       # Get a single var
relight config unset [name] KEY     # Remove env vars (applies live)
relight config import [name] -f .env  # Import from .env file
```

Config changes apply immediately to the running app -- no redeploy needed.

### Scale

```bash
relight scale [name]                # Show current scaling
relight scale [name] -r enam,weur -i 3  # Set regions and instances
relight scale [name] --vcpu 1 --memory 512
```

### Domains

```bash
relight domains [name]              # List domains
relight domains add [name] [domain] # Add custom domain (interactive)
relight domains remove [name] <domain>
```

Cross-cloud DNS: use `--dns <cloud>` to manage DNS records on a different cloud than the app runs on (e.g., app on GCP, DNS on Cloudflare).

### Database

```bash
relight db                          # List all databases
relight db create <name>            # Create database
relight db destroy <name>           # Destroy database
relight db info <name>              # Show connection details
relight db attach <name> [app]      # Attach to app (injects DATABASE_URL)
relight db detach [app]             # Detach from app
relight db shell <name>             # Interactive SQL REPL
relight db query <name> "SELECT 1"  # Run SQL query
relight db import <name> <path>     # Import .sql file
relight db export <name>            # Export as SQL dump
relight db token <name> --rotate    # Rotate credentials
relight db reset <name>             # Drop all tables
```

Use `--provider <id>` to target a specific backend (cf, gcp, aws, azure, neon, turso).

- Cloudflare uses D1 (SQLite)
- GCP, AWS, Azure use shared PostgreSQL instances
- Neon and Turso are external managed database services

### Monitoring

```bash
relight ps [name]                   # Show container status
relight logs [name]                 # Stream live logs
relight cost [name]                 # Show estimated costs
relight cost --since 7d             # Costs for last 7 days
relight regions                     # List available regions
relight doctor                      # Check system setup + connectivity
```

### Open

```bash
relight open [name]                 # Open app URL in browser
```

## Cloud-Specific Defaults

| Cloud | Compute | Database | Registry | Default Region |
|-------|---------|----------|----------|----------------|
| cf | Workers + Containers | D1 (SQLite) | Cloudflare Registry | enam |
| gcp | Cloud Run | Cloud SQL (Postgres) | Artifact Registry | us-central1 |
| aws | App Runner | RDS (Postgres) | ECR | us-east-1 |
| azure | Container Apps | Flexible Server (Postgres) | ACR | eastus |

## Common Workflows

### Deploy a new app
```bash
relight clouds add                  # One-time: add cloud credentials
relight deploy myapp .              # Deploy from current directory
relight open myapp                  # Visit in browser
```

### Add a database
```bash
relight db create mydb
relight db attach mydb myapp        # Injects DATABASE_URL into app
```

### Add a custom domain
```bash
relight domains add myapp example.com
```

### Set secrets
```bash
relight config set myapp API_KEY=sk-... -s
```

### Multi-cloud
```bash
relight deploy myapp . --cloud cf           # Deploy to Cloudflare
relight deploy myapp-gcp . --cloud gcp      # Deploy to GCP
relight domains add myapp api.example.com --dns cf  # DNS on CF, app on any cloud
```

## Tips

- Most commands accept `--json` for machine-readable output
- If you're in a linked directory (has `.relight.yaml`), app name is optional
- `relight doctor` is the first thing to run when debugging issues
- Config changes (env vars, secrets) apply live without redeployment
- Database `attach` injects `DATABASE_URL` (and `TURSO_URL`/`TURSO_TOKEN` for Turso)
- All destructive operations require `--confirm <name>` or interactive confirmation
