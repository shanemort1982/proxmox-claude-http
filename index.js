#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import https from 'https';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '.env');

try {
  const envFile = readFileSync(envPath, 'utf8');
  const envVars = envFile.split('\n').filter(line => line.includes('='));
  for (const line of envVars) {
    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      process.env[key.trim()] = values.join('=').trim();
    }
  }
} catch (error) {
  console.error('Warning: Could not load .env file:', error.message);
}

class ProxmoxClaudeServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    
    // Proxmox configuration
    this.proxmoxHost = process.env.PROXMOX_HOST;
    this.proxmoxPort = process.env.PROXMOX_PORT || '8006';
    this.proxmoxUser = process.env.PROXMOX_USER || 'root@pam';
    this.proxmoxTokenName = process.env.PROXMOX_TOKEN_NAME;
    this.proxmoxTokenValue = process.env.PROXMOX_TOKEN_VALUE;
    this.allowElevated = process.env.PROXMOX_ALLOW_ELEVATED === 'true';

    // Create HTTPS agent that ignores self-signed certificates
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`REQUEST: ${req.method} ${req.url} from ${req.ip}`);
      console.log(`Headers:`, req.headers);
      next();
    });

    // CORS for Claude Desktop
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    this.app.use(express.json());
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        server: 'proxmox-claude-http',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      });
    });

    // Get all Proxmox nodes
    this.app.get('/api/nodes', async (req, res) => {
      try {
        const result = await this.getNodes();
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get specific node status
    this.app.get('/api/nodes/:node', async (req, res) => {
      try {
        const result = await this.getNodeStatus(req.params.node);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get all VMs
    this.app.get('/api/vms', async (req, res) => {
      try {
        const { node, type = 'all' } = req.query;
        const result = await this.getVMs(node, type);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get specific VM status
    this.app.get('/api/vms/:node/:vmid', async (req, res) => {
      try {
        const { node, vmid } = req.params;
        const { type = 'qemu' } = req.query;
        const result = await this.getVMStatus(node, vmid, type);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Execute VM command
    this.app.post('/api/vms/:node/:vmid/exec', async (req, res) => {
      try {
        const { node, vmid } = req.params;
        const { command, type = 'qemu' } = req.body;
        const result = await this.executeVMCommand(node, vmid, command, type);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get storage
    this.app.get('/api/storage', async (req, res) => {
      try {
        const { node } = req.query;
        const result = await this.getStorage(node);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get cluster status
    this.app.get('/api/cluster', async (req, res) => {
      try {
        const result = await this.getClusterStatus();
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Claude Desktop friendly endpoints with formatted responses
    this.app.get('/claude/nodes', async (req, res) => {
      try {
        const result = await this.getNodes();
        res.json({
          response: result.content[0].text,
          data: result
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/claude/vms', async (req, res) => {
      try {
        const { node, type = 'all' } = req.query;
        const result = await this.getVMs(node, type);
        res.json({
          response: result.content[0].text,
          data: result
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/claude/cluster', async (req, res) => {
      try {
        const result = await this.getClusterStatus();
        res.json({
          response: result.content[0].text,
          data: result
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  async proxmoxRequest(endpoint, method = 'GET', data = null) {
    const url = `https://${this.proxmoxHost}:${this.proxmoxPort}/api2/json${endpoint}`;
    const headers = {
      'Authorization': `PVEAPIToken=${this.proxmoxUser}!${this.proxmoxTokenName}=${this.proxmoxTokenValue}`,
      'Content-Type': 'application/json',
    };

    const options = {
      method,
      headers,
      agent: this.httpsAgent,
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      throw new Error(`Proxmox API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.data;
  }

  async getNodes() {
    const nodes = await this.proxmoxRequest('/nodes');
    
    let output = '🖥️  **Proxmox Cluster Nodes**\n\n';
    
    for (const node of nodes) {
      const status = node.status === 'online' ? '🟢' : '🔴';
      output += `${status} **${node.node}**\n`;
      output += `   • Status: ${node.status}\n`;
      output += `   • Uptime: ${node.uptime ? this.formatUptime(node.uptime) : 'N/A'}\n`;
      output += `   • CPU: ${node.cpu ? `${(node.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
      output += `   • Memory: ${node.mem && node.maxmem ? 
        `${this.formatBytes(node.mem)} / ${this.formatBytes(node.maxmem)} (${((node.mem / node.maxmem) * 100).toFixed(1)}%)` : 'N/A'}\n`;
      output += `   • Load: ${node.loadavg ? node.loadavg.join(', ') : 'N/A'}\n\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }],
      nodes: nodes
    };
  }

  async getNodeStatus(nodeName) {
    const nodeStatus = await this.proxmoxRequest(`/nodes/${nodeName}/status`);
    
    let output = `🖥️  **Node: ${nodeName}**\n\n`;
    output += `• **Status**: ${nodeStatus.uptime ? 'Online' : 'Offline'}\n`;
    output += `• **Uptime**: ${nodeStatus.uptime ? this.formatUptime(nodeStatus.uptime) : 'N/A'}\n`;
    output += `• **CPU Usage**: ${nodeStatus.cpu ? `${(nodeStatus.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
    output += `• **Memory**: ${nodeStatus.memory ? 
      `${this.formatBytes(nodeStatus.memory.used)} / ${this.formatBytes(nodeStatus.memory.total)} (${((nodeStatus.memory.used / nodeStatus.memory.total) * 100).toFixed(1)}%)` : 'N/A'}\n`;
    output += `• **Load Average**: ${nodeStatus.loadavg ? nodeStatus.loadavg.join(', ') : 'N/A'}\n`;
    output += `• **Root FS**: ${nodeStatus.rootfs ? 
      `${this.formatBytes(nodeStatus.rootfs.used)} / ${this.formatBytes(nodeStatus.rootfs.total)} (${((nodeStatus.rootfs.used / nodeStatus.rootfs.total) * 100).toFixed(1)}%)` : 'N/A'}\n`;
    
    return {
      content: [{ type: 'text', text: output }],
      nodeStatus: nodeStatus
    };
  }

  async getVMs(nodeName = null, type = 'all') {
    let vms = [];
    
    if (nodeName) {
      // Get VMs from specific node
      if (type === 'all' || type === 'qemu') {
        const qemuVMs = await this.proxmoxRequest(`/nodes/${nodeName}/qemu`);
        vms.push(...qemuVMs.map(vm => ({ ...vm, type: 'qemu', node: nodeName })));
      }
      if (type === 'all' || type === 'lxc') {
        const lxcVMs = await this.proxmoxRequest(`/nodes/${nodeName}/lxc`);
        vms.push(...lxcVMs.map(vm => ({ ...vm, type: 'lxc', node: nodeName })));
      }
    } else {
      // Get VMs from all nodes
      const nodes = await this.proxmoxRequest('/nodes');
      for (const node of nodes) {
        if (type === 'all' || type === 'qemu') {
          try {
            const qemuVMs = await this.proxmoxRequest(`/nodes/${node.node}/qemu`);
            vms.push(...qemuVMs.map(vm => ({ ...vm, type: 'qemu', node: node.node })));
          } catch (error) {
            // Node might be offline, continue
          }
        }
        if (type === 'all' || type === 'lxc') {
          try {
            const lxcVMs = await this.proxmoxRequest(`/nodes/${node.node}/lxc`);
            vms.push(...lxcVMs.map(vm => ({ ...vm, type: 'lxc', node: node.node })));
          } catch (error) {
            // Node might be offline, continue
          }
        }
      }
    }
    
    let output = '💻 **Virtual Machines**\n\n';
    
    // Sort VMs by ID
    vms.sort((a, b) => a.vmid - b.vmid);
    
    for (const vm of vms) {
      const status = vm.status === 'running' ? '🟢' : vm.status === 'stopped' ? '🔴' : '🟡';
      const typeIcon = vm.type === 'qemu' ? '🖥️' : '📦';
      
      output += `${status} ${typeIcon} **${vm.name || `VM-${vm.vmid}`}** (ID: ${vm.vmid})\n`;
      output += `   • Node: ${vm.node}\n`;
      output += `   • Status: ${vm.status}\n`;
      output += `   • Type: ${vm.type.toUpperCase()}\n`;
      
      if (vm.status === 'running') {
        output += `   • Uptime: ${vm.uptime ? this.formatUptime(vm.uptime) : 'N/A'}\n`;
        output += `   • CPU: ${vm.cpu ? `${(vm.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
        output += `   • Memory: ${vm.mem && vm.maxmem ? 
          `${this.formatBytes(vm.mem)} / ${this.formatBytes(vm.maxmem)}` : 'N/A'}\n`;
      }
      
      output += '\n';
    }
    
    return {
      content: [{ type: 'text', text: output }],
      vms: vms
    };
  }

  async getVMStatus(node, vmid, type = 'qemu') {
    const vmStatus = await this.proxmoxRequest(`/nodes/${node}/${type}/${vmid}/status/current`);
    
    const status = vmStatus.status === 'running' ? '🟢' : vmStatus.status === 'stopped' ? '🔴' : '🟡';
    const typeIcon = type === 'qemu' ? '🖥️' : '📦';
    
    let output = `${status} ${typeIcon} **${vmStatus.name || `VM-${vmid}`}** (ID: ${vmid})\n\n`;
    output += `• **Node**: ${node}\n`;
    output += `• **Status**: ${vmStatus.status}\n`;
    output += `• **Type**: ${type.toUpperCase()}\n`;
    
    if (vmStatus.status === 'running') {
      output += `• **Uptime**: ${vmStatus.uptime ? this.formatUptime(vmStatus.uptime) : 'N/A'}\n`;
      output += `• **CPU Usage**: ${vmStatus.cpu ? `${(vmStatus.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
      output += `• **Memory**: ${vmStatus.mem && vmStatus.maxmem ? 
        `${this.formatBytes(vmStatus.mem)} / ${this.formatBytes(vmStatus.maxmem)} (${((vmStatus.mem / vmStatus.maxmem) * 100).toFixed(1)}%)` : 'N/A'}\n`;
      output += `• **Disk Read**: ${vmStatus.diskread ? this.formatBytes(vmStatus.diskread) : 'N/A'}\n`;
      output += `• **Disk Write**: ${vmStatus.diskwrite ? this.formatBytes(vmStatus.diskwrite) : 'N/A'}\n`;
      output += `• **Network In**: ${vmStatus.netin ? this.formatBytes(vmStatus.netin) : 'N/A'}\n`;
      output += `• **Network Out**: ${vmStatus.netout ? this.formatBytes(vmStatus.netout) : 'N/A'}\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }],
      vmStatus: vmStatus
    };
  }

  async executeVMCommand(node, vmid, command, type = 'qemu') {
    if (!this.allowElevated) {
      return {
        content: [{ 
          type: 'text', 
          text: `⚠️  **VM Command Execution Requires Elevated Permissions**\n\nTo execute commands on VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and ensure your API token has appropriate VM permissions.\n\n**Current permissions**: Basic (VM listing only)\n**Requested command**: \`${command}\``
        }]
      };
    }
    
    try {
      // For QEMU VMs, we need to use the guest agent
      if (type === 'qemu') {
        const result = await this.proxmoxRequest(`/nodes/${node}/qemu/${vmid}/agent/exec`, 'POST', {
          command: command
        });
        
        let output = `💻 **Command executed on VM ${vmid}**\n\n`;
        output += `**Command**: \`${command}\`\n`;
        output += `**Result**: Command submitted to guest agent\n`;
        output += `**PID**: ${result.pid || 'N/A'}\n\n`;
        output += `*Note: Use guest agent status to check command completion*`;
        
        return {
          content: [{ type: 'text', text: output }],
          result: result
        };
      } else {
        // For LXC containers, we can execute directly
        const result = await this.proxmoxRequest(`/nodes/${node}/lxc/${vmid}/exec`, 'POST', {
          command: command
        });
        
        let output = `📦 **Command executed on container ${vmid}**\n\n`;
        output += `**Command**: \`${command}\`\n`;
        output += `**Output**: ${result.output || 'Command executed successfully'}\n`;
        
        return {
          content: [{ type: 'text', text: output }],
          result: result
        };
      }
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `❌ **Command execution failed**\n\n**Error**: ${error.message}\n\n*Note: Ensure the VM has guest agent installed and running (for QEMU VMs)*`
        }]
      };
    }
  }

  async getStorage(nodeName = null) {
    let storages = [];
    
    if (nodeName) {
      storages = await this.proxmoxRequest(`/nodes/${nodeName}/storage`);
      storages = storages.map(storage => ({ ...storage, node: nodeName }));
    } else {
      const nodes = await this.proxmoxRequest('/nodes');
      for (const node of nodes) {
        try {
          const nodeStorages = await this.proxmoxRequest(`/nodes/${node.node}/storage`);
          storages.push(...nodeStorages.map(storage => ({ ...storage, node: node.node })));
        } catch (error) {
          // Node might be offline, continue
        }
      }
    }
    
    let output = '💾 **Storage Pools**\n\n';
    
    for (const storage of storages) {
      const usagePercent = storage.total ? ((storage.used / storage.total) * 100).toFixed(1) : 'N/A';
      
      output += `📁 **${storage.storage}** (${storage.node})\n`;
      output += `   • Type: ${storage.type}\n`;
      output += `   • Status: ${storage.active ? '🟢 Active' : '🔴 Inactive'}\n`;
      output += `   • Used: ${storage.used ? this.formatBytes(storage.used) : 'N/A'}\n`;
      output += `   • Total: ${storage.total ? this.formatBytes(storage.total) : 'N/A'}\n`;
      output += `   • Usage: ${usagePercent}%\n\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }],
      storages: storages
    };
  }

  async getClusterStatus() {
    const nodes = await this.proxmoxRequest('/nodes');
    const cluster = await this.proxmoxRequest('/cluster/status');
    
    let output = '🏗️  **Proxmox Cluster Status**\n\n';
    
    // Cluster overview
    const onlineNodes = nodes.filter(node => node.status === 'online').length;
    const totalNodes = nodes.length;
    
    output += `**Cluster Health**: ${onlineNodes === totalNodes ? '🟢 Healthy' : '⚠️  Degraded'}\n`;
    output += `**Nodes**: ${onlineNodes}/${totalNodes} online\n\n`;
    
    // Resource summary
    let totalCPU = 0, usedCPU = 0, totalMem = 0, usedMem = 0;
    
    for (const node of nodes) {
      if (node.status === 'online') {
        totalCPU += node.maxcpu || 0;
        usedCPU += (node.cpu || 0) * (node.maxcpu || 0);
        totalMem += node.maxmem || 0;
        usedMem += node.mem || 0;
      }
    }
    
    output += `**Resource Usage**:\n`;
    output += `• CPU: ${usedCPU.toFixed(1)}/${totalCPU} cores (${((usedCPU / totalCPU) * 100).toFixed(1)}%)\n`;
    output += `• Memory: ${this.formatBytes(usedMem)} / ${this.formatBytes(totalMem)} (${((usedMem / totalMem) * 100).toFixed(1)}%)\n\n`;
    
    // Node details
    output += `**Node Details**:\n`;
    for (const node of nodes) {
      const status = node.status === 'online' ? '🟢' : '🔴';
      output += `${status} ${node.node}: ${node.status}\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }],
      nodes: nodes,
      cluster: cluster
    };
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async start() {
    // Validate required environment variables
    if (!this.proxmoxHost) {
      console.error('Error: PROXMOX_HOST environment variable is required');
      process.exit(1);
    }
    if (!this.proxmoxTokenName) {
      console.error('Error: PROXMOX_TOKEN_NAME environment variable is required');
      process.exit(1);
    }
    if (!this.proxmoxTokenValue) {
      console.error('Error: PROXMOX_TOKEN_VALUE environment variable is required');
      process.exit(1);
    }

    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`🚀 Proxmox Claude HTTP Server running on port ${this.port}`);
      console.log(`📡 Health check: http://localhost:${this.port}/health`);
      console.log(`🔧 API endpoints: http://localhost:${this.port}/api/*`);
      console.log(`🤖 Claude endpoints: http://localhost:${this.port}/claude/*`);
      console.log(`🏗️  Proxmox host: ${this.proxmoxHost}:${this.proxmoxPort}`);
      console.log(`🔒 Elevated mode: ${this.allowElevated ? 'enabled' : 'disabled'}`);
    });
  }
}

const server = new ProxmoxClaudeServer();
server.start().catch(console.error);