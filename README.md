# Remote SSH & SCP Deploy Action

A custom GitHub Action to securely copy files via SCP and run commands via SSH. It supports direct connections and connections through a jump/proxy/bastion host, using either raw private key content from secrets or pre-existing key files on the runner.

Implemented using Node.js and the native `ssh`/`scp` client on the runner, avoiding slow Docker container startups and providing robust execution.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `host` | Target SSH host address | **Yes** | |
| `username` | Target SSH username | **Yes** | |
| `port` | Target SSH port | No | `22` |
| `key` | Target SSH private key content (e.g., `${{ secrets.SSH_KEY }}`) | No | |
| `key_path` | Pre-existing target SSH private key path on the runner | No | |
| `source` | Local source files/folders to copy via SCP (supports globs like `dist/*`) | No | |
| `target` | Target directory on the remote host for SCP copy | No | |
| `script` | Multi-line shell script to run on the target host after copying | No | |
| `proxy_host` | Proxy/jump host address | No | |
| `proxy_username` | Proxy/jump host SSH username | No | |
| `proxy_port` | Proxy/jump host SSH port | No | `22` |
| `proxy_key` | Proxy/jump host SSH private key content | No | |
| `proxy_key_path` | Target SSH private key path on the proxy/jump host | No | |

> [!IMPORTANT]
> - Either `key` or `key_path` must be provided for direct target connections.
> - If `proxy_host` is specified without `proxy_key_path`, `proxy_username` and `proxy_key` must also be provided.
> - If `proxy_key_path` is specified, that file is expected to exist on the proxy host. The runner connects to the proxy using `proxy_key`, or falls back to `key`/`key_path` when `proxy_key` is not provided.
> - If either `source` or `target` is provided, both must be specified.

## Examples

### 1. Direct Target Copy and Script Execution

```yaml
- name: Deploy to Staging
  uses: your-org/remote-deploy-action@v1
  with:
    host: ${{ secrets.TARGET_HOST }}
    username: ${{ secrets.TARGET_USER }}
    key: ${{ secrets.TARGET_SSH_KEY }}
    source: "dist/*"
    target: "/var/www/my-app"
    script: |
      cd /var/www/my-app
      npm install --production
      pm2 restart my-app
```

### 2. Deploy Through a Bastion/Jump Host

```yaml
- name: Deploy via Bastion Host
  uses: your-org/remote-deploy-action@v1
  with:
    host: ${{ secrets.INTERNAL_TARGET_HOST }}
    username: ${{ secrets.TARGET_USER }}
    key: ${{ secrets.TARGET_SSH_KEY }}
    proxy_host: ${{ secrets.BASTION_HOST }}
    proxy_username: ${{ secrets.BASTION_USER }}
    proxy_key: ${{ secrets.BASTION_SSH_KEY }}
    source: "build/"
    target: "/home/ubuntu/app"
```

### 3. Deploy Through a Bastion Using a Target Key on the Bastion

```yaml
- name: Deploy via Bastion Host Key
  uses: your-org/remote-deploy-action@v1
  with:
    host: "10.0.0.5"
    username: "ubuntu"
    key: ${{ secrets.BASTION_SSH_KEY }}
    proxy_host: ${{ secrets.BASTION_HOST }}
    proxy_username: "ubuntu"
    proxy_key_path: "/home/ubuntu/nexus.pem"
    source: "docker-compose.yml"
    target: "/home/ubuntu"
    script: |
      cd /home/ubuntu
      docker compose up -d
```

### 4. Using Existing Key Paths on the Runner

```yaml
- name: Deploy using runner ssh key files
  uses: your-org/remote-deploy-action@v1
  with:
    host: "10.0.0.5"
    username: "deployer"
    key_path: "/home/runner/.ssh/id_rsa"
    source: "package.json"
    target: "/tmp"
```
