#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import https from 'https';
import { config } from 'dotenv';

// Load environment variables
config();

// Ignore self-signed certificates for Proxmox
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

class ProxmoxMCPServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.proxmoxConfig = {
      host: process.env.PROXMOX_HOST,
      port: process.env.PROXMOX_PORT || 8006,
      user: process.env.PROXMOX_USER || 'root@pam',
      tokenName: process.env.PROXMOX_TOKEN_NAME,
      tokenValue: process.env.PROXMOX_TOKEN_VALUE,
      allowElevated: process.env.PROXMOX_ALLOW_ELEVATED === 'true'
    };

    this.setupMiddleware();
    this.setupMCPEndpoint();
  }

  setupMiddleware() {
    // CORS for Claude Desktop
    this.app.use(cors({
      origin: '*',
      methods: ['POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    this.app.use(express.json());

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.url}`);
      console.log(`📋 Headers:`, req.headers);
      if (req.body) {
        console.log(`📦 Body:`, JSON.stringify(req.body, null, 2));
      }
      next();
    });
  }

  setupMCPEndpoint() {
    // Main MCP endpoint - Claude Desktop will POST here
    this.app.post('/', async (req, res) => {
      try {
        const response = await this.handleMCPRequest(req.body);
        res.json(response);
      } catch (error) {
        console.error('❌ MCP Error:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          },
          id: req.body?.id || null
        });
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        server: 'Proxmox MCP over HTTP',
        proxmox: `${this.proxmoxConfig.host}:${this.proxmoxConfig.port}`
      });
    });
  }

  async handleMCPRequest(request) {
    console.log(`🔧 Handling MCP request: ${request.method}`);

    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      
      case 'tools/list':
        return this.handleToolsList(request);
      
      case 'tools/call':
        return this.handleToolCall(request);
      
      default:
        return {
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: 'Method not found',
            data: `Unknown method: ${request.method}`
          },
          id: request.id
        };
    }
  }

  handleInitialize(request) {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'proxmox-mcp-server',
          version: '1.0.0'
        }
      },
      id: request.id
    };
  }

  handleToolsList(request) {
    const tools = [
      {
        name: 'proxmox_get_nodes',
        description: 'List all Proxmox cluster nodes with their status and resource usage',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'proxmox_get_vms',
        description: 'List all virtual machines across the cluster',
        inputSchema: {
          type: 'object',
          properties: {
            node: {
              type: 'string',
              description: 'Filter by specific node (optional)'
            },
            type: {
              type: 'string',
              enum: ['qemu', 'lxc', 'all'],
              description: 'Filter by VM type (optional)'
            }
          },
          required: []
        }
      },
      {
        name: 'proxmox_get_cluster_status',
        description: 'Get overall cluster status including nodes and resource usage',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ];

    return {
      jsonrpc: '2.0',
      result: {
        tools: tools
      },
      id: request.id
    };
  }

  async handleToolCall(request) {
    const { name, arguments: args } = request.params;
    
    try {
      let result;
      
      switch (name) {
        case 'proxmox_get_nodes':
          result = await this.getNodes();
          break;
        case 'proxmox_get_vms':
          result = await this.getVMs(args?.node, args?.type);
          break;
        case 'proxmox_get_cluster_status':
          result = await this.getClusterStatus();
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        jsonrpc: '2.0',
        result: {
          content: [
            {
              type: 'text',
              text: result
            }
          ]
        },
        id: request.id
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Tool execution failed',
          data: error.message
        },
        id: request.id
      };
    }
  }

  async proxmoxRequest(endpoint) {
    const url = `https://${this.proxmoxConfig.host}:${this.proxmoxConfig.port}/api2/json${endpoint}`;
    const headers = {
      'Authorization': `PVEAPIToken=${this.proxmoxConfig.user}!${this.proxmoxConfig.tokenName}=${this.proxmoxConfig.tokenValue}`
    };

    const response = await fetch(url, { 
      headers,
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    if (!response.ok) {
      throw new Error(`Proxmox API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.data;
  }

  async getNodes() {
    const nodes = await this.proxmoxRequest('/nodes');
    
    let result = '🖥️  **Proxmox Cluster Nodes**\n\n';
    
    for (const node of nodes) {
      const status = node.status === 'online' ? '🟢' : '🔴';
      const uptime = this.formatUptime(node.uptime);
      const cpuPercent = (node.cpu * 100).toFixed(1);
      const memoryUsed = this.formatBytes(node.mem);
      const memoryTotal = this.formatBytes(node.maxmem);
      const memoryPercent = ((node.mem / node.maxmem) * 100).toFixed(1);
      
      result += `${status} **${node.node}**\n`;
      result += `   • Status: ${node.status}\n`;
      result += `   • Uptime: ${uptime}\n`;
      result += `   • CPU: ${cpuPercent}%\n`;
      result += `   • Memory: ${memoryUsed} / ${memoryTotal} (${memoryPercent}%)\n`;
      result += `   • Load: ${node.loadavg ? node.loadavg[0] : 'N/A'}\n\n`;
    }
    
    return result;
  }

  async getVMs(nodeFilter = null, typeFilter = 'all') {
    const nodes = await this.proxmoxRequest('/nodes');
    let allVMs = [];

    for (const node of nodes) {
      if (nodeFilter && node.node !== nodeFilter) continue;

      try {
        if (typeFilter === 'all' || typeFilter === 'qemu') {
          const qemuVMs = await this.proxmoxRequest(`/nodes/${node.node}/qemu`);
          allVMs.push(...qemuVMs.map(vm => ({ ...vm, type: 'qemu', node: node.node })));
        }
        
        if (typeFilter === 'all' || typeFilter === 'lxc') {
          const lxcVMs = await this.proxmoxRequest(`/nodes/${node.node}/lxc`);
          allVMs.push(...lxcVMs.map(vm => ({ ...vm, type: 'lxc', node: node.node })));
        }
      } catch (error) {
        console.warn(`Failed to get VMs from node ${node.node}:`, error.message);
      }
    }

    allVMs.sort((a, b) => a.vmid - b.vmid);

    let result = '💻 **Virtual Machines**\n\n';
    
    for (const vm of allVMs) {
      const status = vm.status === 'running' ? '🟢' : '🔴';
      const icon = vm.type === 'qemu' ? '🖥️' : '📦';
      
      result += `${status} ${icon} **${vm.name}** (ID: ${vm.vmid})\n`;
      result += `   • Node: ${vm.node}\n`;
      result += `   • Status: ${vm.status}\n`;
      result += `   • Type: ${vm.type.toUpperCase()}\n`;
      
      if (vm.status === 'running') {
        if (vm.uptime) {
          result += `   • Uptime: ${this.formatUptime(vm.uptime)}\n`;
        }
        if (vm.cpu !== undefined) {
          result += `   • CPU: ${vm.cpu ? (vm.cpu * 100).toFixed(1) + '%' : 'N/A'}\n`;
        }
        if (vm.mem && vm.maxmem) {
          result += `   • Memory: ${this.formatBytes(vm.mem)} / ${this.formatBytes(vm.maxmem)}\n`;
        }
      }
      
      result += '\n';
    }
    
    return result;
  }

  async getClusterStatus() {
    const nodes = await this.proxmoxRequest('/nodes');
    const cluster = await this.proxmoxRequest('/cluster/status');
    
    const onlineNodes = nodes.filter(n => n.status === 'online').length;
    const totalNodes = nodes.length;
    
    let totalCPU = 0, usedCPU = 0, totalMem = 0, usedMem = 0;
    
    for (const node of nodes) {
      if (node.status === 'online') {
        totalCPU += node.maxcpu || 0;
        usedCPU += (node.cpu || 0) * (node.maxcpu || 0);
        totalMem += node.maxmem || 0;
        usedMem += node.mem || 0;
      }
    }
    
    const cpuPercent = totalCPU > 0 ? ((usedCPU / totalCPU) * 100).toFixed(1) : '0';
    const memPercent = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : '0';
    
    let result = '🏗️  **Proxmox Cluster Status**\n\n';
    result += `**Cluster Health**: ${onlineNodes === totalNodes ? '🟢 Healthy' : '🟡 Degraded'}\n`;
    result += `**Nodes**: ${onlineNodes}/${totalNodes} online\n\n`;
    result += `**Resource Usage**:\n`;
    result += `• CPU: ${(usedCPU).toFixed(1)}/${totalCPU} cores (${cpuPercent}%)\n`;
    result += `• Memory: ${this.formatBytes(usedMem)} / ${this.formatBytes(totalMem)} (${memPercent}%)\n\n`;
    result += `**Node Details**:\n`;
    
    for (const node of nodes) {
      const status = node.status === 'online' ? '🟢' : '🔴';
      result += `${status} ${node.node}: ${node.status}\n`;
    }
    
    return result;
  }

  formatUptime(seconds) {
    if (!seconds) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  start() {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`🚀 Proxmox MCP-over-HTTP Server running on port ${this.port}`);
      console.log(`📡 Health check: http://localhost:${this.port}/health`);
      console.log(`🔧 MCP endpoint: http://localhost:${this.port}/`);
      console.log(`🏗️  Proxmox host: ${this.proxmoxConfig.host}:${this.proxmoxConfig.port}`);
      console.log(`🔒 Elevated mode: ${this.proxmoxConfig.allowElevated ? 'enabled' : 'disabled'}`);
    });
  }
}

// Start the server
const server = new ProxmoxMCPServer();
server.start();