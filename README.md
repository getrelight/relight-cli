# Relight

Deploy Docker containers to your cloud with scale-to-zero. Apps sleep when idle and wake on the next request.

```
$ relight deploy myapp .
  Building image...
  Pushing to us-docker.pkg.dev/my-project/relight/myapp:v1...
  Deploying to Cloud Run (us-central1)...

--> Live at https://myapp-abc123.run.app
    Sleeps after 30s idle. $0 when sleeping.
```

## What this is

Relight is a CLI that deploys and manages Docker containers across multiple cloud providers. It talks directly to each cloud's API using your own credentials. No vendor infrastructure gets installed in your account.

Supported providers:

| Provider | Backend | Scale to zero | Database | DNS |
|---|---|---|---|---|
| GCP | Cloud Run | Yes | Cloud SQL (PostgreSQL) | Cloud DNS |
| AWS | App Runner | Yes | RDS (PostgreSQL) | Route 53 |
| Azure | Container Apps | Yes | Flexible Server (PostgreSQL) | Azure DNS |
| Cloudflare | Containers (Workers + Durable Objects) | Yes | D1 (SQLite) | Cloudflare DNS |
| SlicerVM | Self-hosted | Yes | - | - |
| Neon | - | - | Neon Postgres | - |
| Turso | - | - | Turso (libSQL) | - |

## Install

```sh
npm install -g relight-cli
```

Requires Node.js 20+ and Docker.

## Quick start

```sh
# Add a provider
relight providers add gcp

# Deploy from a Dockerfile
relight deploy myapp .

# Check your apps
relight apps

# Stream logs
relight logs myapp

# Open in browser
relight open myapp

# Create a database
relight db create myapp
```

The first deploy links the current directory to the app name. After that, `relight deploy` is enough.

## Commands

```
relight providers list               List configured providers
relight providers add [type]         Add a provider (cf, gcp, aws, azure, slicervm, neon, turso)
relight providers remove <name>      Remove a provider
relight providers default <layer> <name>  Set default provider for a layer
relight deploy [name] [path]         Deploy an app from a Dockerfile
relight apps                         List all deployed apps
relight apps info [name]             Show detailed app info
relight apps destroy [name]          Destroy an app and its cloud resources
relight ps [name]                    Show running containers and resource usage
relight logs [name]                  Stream live logs
relight open [name]                  Open app URL in browser
relight config show [name]           Show environment variables
relight config set [name] KEY=VALUE  Set env vars (applied live, no redeploy)
relight config set [name] K=V -s    Set env vars as encrypted secrets
relight config get [name] KEY        Get a single env var
relight config unset [name] KEY      Remove an env var
relight config import [name] -f .env Import from .env file
relight scale [name]                 Show or adjust instance count and resources
relight domains [name]               List custom domains
relight domains add [name] [domain]  Add a custom domain with DNS setup
relight domains remove [name] <domain>  Remove a custom domain
relight db create <name>             Create a managed database
relight db destroy <name>            Destroy a database
relight db info <name>               Show database details
relight db shell <name>              Interactive SQL shell
relight db query [name] <sql>        Run a SQL query
relight db import <name> <file>      Import a SQL file
relight db export <name>             Export database as SQL
relight db token <name>              Show or rotate DB token
relight db reset <name>              Drop all tables
relight db attach <name> [app]       Attach a database to an app
relight db detach [app]              Detach database from an app
relight regions                      List available regions
relight cost [name]                  Show estimated costs
relight cost [name] --since 7d       Cost for a specific period
relight destroy [name]               Destroy an app (alias for apps destroy)
relight doctor                       Check system setup and provider connectivity
```

Most commands accept `--compute <name>` to pick a specific provider for compute, `--db <name>` for databases, and `--dns <name>` for DNS. If you only have one provider for a layer, it's auto-selected.

Config changes (`config set`, `config unset`, `scale`, `domains`) are applied live without redeploying the container image.

## How it works

1. `relight providers add` stores credentials locally at `~/.relight/config.json`. You can register multiple provider instances - even multiple accounts of the same type (e.g. two GCP projects, separate staging/prod SlicerVM hosts).

2. `relight deploy` builds a Docker image locally, pushes it to the provider's container registry (Artifact Registry, ECR, Azure Container Registry, or Cloudflare Registry), and deploys it using the provider's native container service. Self-hosted providers like SlicerVM skip the registry and upload the image directly.

3. The deployed app sleeps after a configurable idle period (default 30s). The next incoming request wakes it. Cold starts are typically 1-5 seconds depending on the provider and image size.

4. All app state (config, scaling, domains, database bindings) lives in the cloud provider's API. The only local files are your auth credentials and a `.relight.yaml` link file in your project directory. You can manage your apps from any machine.

## App management

```
$ relight apps

NAME              LAST MODIFIED
────────────────  ────────────────────────
myapi             2026-03-02T09:41:45.223Z
frontend          2026-02-28T14:22:10.001Z

$ relight apps info myapi    # detailed view with regions, instances, domains
$ relight cost               # cost breakdown
```

## Databases

Relight manages databases alongside your apps. Each provider uses its native database service:

```sh
# Create a database
relight db create myapp

# Interactive SQL shell
relight db shell myapp

# Run a query
relight db query myapp "SELECT * FROM users"

# Attach to an app (injects DATABASE_URL/DB_TOKEN)
relight db attach myapp myapi
```

GCP and AWS use PostgreSQL (Cloud SQL and RDS). Azure uses Flexible Server (PostgreSQL). Cloudflare uses D1 (SQLite). Neon and Turso are standalone database providers. Connection credentials are automatically injected into your app's environment - `DATABASE_URL` for PostgreSQL providers, `DB_URL` for SQLite/libSQL providers, plus `DB_TOKEN` when applicable.

Cross-provider databases are supported - you can attach a Neon database to a GCP Cloud Run app by specifying `--db neon`.

## BYOC model

Relight deploys to cloud accounts you own. You pay the cloud provider directly at their published rates. Relight itself is free for individual use.

What this means in practice:

- **Your credentials stay local.** Credentials are stored on your machine. Relight has no backend service that holds your cloud credentials.
- **Nothing is installed in your account.** No Kubernetes clusters, no CloudFormation stacks, no VPCs, no agent processes. Relight uses the cloud's existing container services.
- **You can stop using Relight anytime.** Your apps are standard Cloud Run services / App Runner services / Azure Container Apps / CF Workers. They continue running without Relight. There's nothing to uninstall.

## Scaling

```sh
# Set instance count
relight scale myapp -i 4

# Set resources
relight scale myapp --vcpu 1 --memory 512

# Set idle timeout
relight deploy myapp . --sleep 60s

# Multi-region
relight deploy myapp . --regions us-east1,europe-west1
```

Relight does not autoscale. You set the maximum instance count and the cloud provider handles scaling between 0 and that limit based on traffic.

## Custom domains

```sh
relight domains add myapp.example.com

# Relight creates the DNS record if your domain's DNS is on a supported provider
# (Cloud DNS, Route 53, Azure DNS, or Cloudflare DNS)
# Otherwise it prints the record for you to create manually
```

## What Relight doesn't do

- **No autoscaling.** You set max instances. The cloud scales between 0 and your max based on traffic. There's no custom autoscaling logic.
- **No CI/CD.** Relight is a deployment tool, not a build pipeline. Integrate it into your CI by running `relight deploy` in your workflow.
- **Cold starts.** Sleeping apps take 1-5 seconds to respond to the first request. This is inherent to scale-to-zero and varies by provider and image size.

## Provider-specific notes

### GCP (Cloud Run)

- Requires a GCP project with Cloud Run, Artifact Registry, Cloud SQL Admin, Cloud DNS, Logging, and Monitoring APIs enabled.
- Credentials: service account key JSON file.
- Regions: any Cloud Run region. Run `relight regions --compute gcp` to list.
- Scale-to-zero is native. Minimum instances can be set to 0.
- Database: Cloud SQL PostgreSQL 15 (`db-f1-micro` by default).

### AWS (App Runner)

- Requires an AWS account with IAM user credentials.
- Required IAM policies: `AWSAppRunnerFullAccess`, `AmazonEC2ContainerRegistryFullAccess`, `AmazonRDSFullAccess`, `AmazonRoute53FullAccess`, `AmazonEC2ReadOnlyAccess`, `CloudWatchLogsReadOnlyAccess`, `IAMFullAccess`.
- Credentials: IAM access key ID and secret access key.
- Regions: 9 App Runner regions. Run `relight regions --compute aws` to list.
- Scale-to-zero: App Runner pauses services when idle. Minimum 1 provisioned instance ($0.007/vCPU-hr when idle).
- Database: RDS PostgreSQL 15 (`db.t4g.micro` by default). Provisioning takes 5-15 minutes.
- Registry: ECR. Repositories and IAM access roles are created automatically.

### Azure (Container Apps)

- Requires an Azure subscription with a service principal.
- Credentials: tenant ID, client ID, client secret, subscription ID.
- Scale-to-zero is native to Container Apps.
- Database: Azure Database for PostgreSQL Flexible Server.
- Registry: Azure Container Registry.

### Cloudflare (Containers)

- Requires a Cloudflare account with Containers access (paid Workers plan).
- Credentials: Cloudflare API token with Workers and Containers permissions.
- Each app is a Worker backed by Durable Objects running your container. The CLI bundles and uploads the Worker template automatically.
- Regions use Durable Object `locationHints` - placement is best-effort, not guaranteed.
- Database: D1 (SQLite).

### Neon (Database only)

- Standalone managed Postgres provider.
- Credentials: Neon API key.
- Databases are created as branches within a shared Neon project.

### Turso (Database only)

- Standalone managed libSQL provider.
- Credentials: Turso API token.
- Databases are created within a shared Turso group.

### SlicerVM (Self-hosted)

- Requires a running SlicerVM host.
- Credentials: API URL + token, or a Unix socket for local development.
- Images are uploaded directly to the host (no external registry needed).
- You can register multiple SlicerVM instances (e.g. EU and US hosts, or staging/prod).

## Configuration

Provider config is stored at `~/.relight/config.json`:

```json
{
  "providers": {
    "gcp": { "type": "gcp", "clientEmail": "...", "privateKey": "...", "project": "my-project" },
    "aws": { "type": "aws", "accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1" },
    "cf": { "type": "cf", "token": "...", "accountId": "..." },
    "neon": { "type": "neon", "apiKey": "..." }
  },
  "defaults": {
    "app": "gcp",
    "db": "neon",
    "dns": "gcp",
    "registry": "gcp"
  }
}
```

Per-project app linking is stored in a `.relight.yaml` file in your project directory:

```yaml
app: myapp
compute: gcp
dns: cf
db: myapp-db
dbProvider: neon
```

## License

MIT
