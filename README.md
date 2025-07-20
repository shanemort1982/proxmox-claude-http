# Proxmox Claude HTTP Server

HTTP server for Proxmox virtualization management with Claude Desktop integration.

## Features

- 🖥️ **Node Management**: List and monitor Proxmox cluster nodes
- 💻 **VM Management**: View and manage virtual machines (QEMU & LXC)
- 💾 **Storage Monitoring**: Track storage pool usage across the cluster
- 🏗️ **Cluster Status**: Get overall cluster health and resource usage
- 🤖 **Claude Desktop Ready**: HTTP endpoints designed for Claude Desktop integration
- 🔒 **Secure**: Uses Proxmox API tokens for authentication

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/shanemort1982/proxmox-claude-http.git
cd proxmox-claude-http
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
PROXMOX_HOST=192.168.1.161
PROXMOX_PORT=8006
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=claude-token
PROXMOX_TOKEN_VALUE=your-token-value-here
PROXMOX_ALLOW_ELEVATED=false
PORT=3000
```

### 3. Start Server

```bash
npm start
```

Server will be available at `http://localhost:3000`

## API Endpoints

### Health Check
- `GET /health` - Server health status

### Proxmox Data
- `GET /api/nodes` - List all cluster nodes
- `GET /api/nodes/:node` - Get specific node status
- `GET /api/vms` - List all VMs
- `GET /api/vms/:node/:vmid` - Get specific VM status
- `GET /api/storage` - List storage pools
- `GET /api/cluster` - Get cluster status

### Claude Desktop Endpoints
- `GET /claude/nodes` - Formatted node information
- `GET /claude/vms` - Formatted VM listing
- `GET /claude/cluster` - Formatted cluster status

## Claude Desktop Integration

Add this connector to Claude Desktop:

**Name:** `Proxmox Server`  
**URL:** `http://your-server-ip:3000`

Then ask Claude:
- "Show me my Proxmox servers"
- "List all my VMs"
- "What's my cluster status?"

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROXMOX_HOST` | Proxmox server IP/hostname | Required |
| `PROXMOX_PORT` | Proxmox web interface port | `8006` |
| `PROXMOX_USER` | Proxmox user | `root@pam` |
| `PROXMOX_TOKEN_NAME` | API token name | Required |
| `PROXMOX_TOKEN_VALUE` | API token value | Required |
| `PROXMOX_ALLOW_ELEVATED` | Enable VM command execution | `false` |
| `PORT` | HTTP server port | `3000` |

## Security

- Uses HTTPS for Proxmox API communication
- Supports API token authentication
- CORS enabled for Claude Desktop
- Elevated operations require explicit permission

## License

MIT License - see LICENSE file for details.