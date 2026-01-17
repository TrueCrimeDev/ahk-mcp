#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
/**
 * Basic HTTP server for ChatGPT integration
 */
const app = express();
const port = process.env.PORT || 8080;
// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Health check
app.get('/health', (req, res) => {
    console.log('Health check requested');
    res.json({
        status: 'ok',
        server: 'AutoHotkey MCP Server',
        timestamp: new Date().toISOString(),
    });
});
// Simple ping endpoint
app.get('/ping', (req, res) => {
    console.log('Ping requested');
    res.json({ message: 'pong' });
});
// Basic info endpoint
app.get('/info', (req, res) => {
    console.log('Info requested');
    res.json({
        name: 'AutoHotkey v2 MCP Server',
        version: '2.1.0',
        description: 'AutoHotkey v2 development tools and analysis',
        endpoints: [
            'GET /health - Health check',
            'GET /ping - Simple ping test',
            'GET /info - Server information',
            'POST /analyze - Analyze AutoHotkey code',
        ],
    });
});
// Basic code analysis endpoint
app.post('/analyze', (req, res) => {
    console.log('Analysis requested');
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Code parameter is required' });
        }
        // Simple analysis
        const lines = code.split('\n');
        const analysis = {
            lineCount: lines.length,
            hasHotkeys: /::/.test(code),
            hasGUI: /Gui\(/.test(code),
            hasLoops: /(Loop|For|While)/i.test(code),
            functions: (code.match(/^\s*(\w+)\s*\(/gm) || []).length,
            timestamp: new Date().toISOString(),
        };
        res.json({
            code: code.substring(0, 100) + (code.length > 100 ? '...' : ''),
            analysis,
            suggestions: [
                'Consider using AutoHotkey v2 syntax',
                'Add error handling for robust scripts',
                'Use descriptive variable names',
            ],
        });
    }
    catch (error) {
        console.error('Error analyzing code:', error);
        res.status(500).json({ error: 'Failed to analyze code' });
    }
});
// 404 handler
app.use((req, res) => {
    console.log('404 - Endpoint not found:', req.path);
    res.status(404).json({
        error: 'Endpoint not found',
        availableEndpoints: ['/health', '/ping', '/info', '/analyze'],
    });
});
// Start server
app.listen(port, () => {
    console.log(`AutoHotkey HTTP Server started on port ${port}`);
    console.log(`Server URL: http://localhost:${port}`);
    console.log(`Test with: curl http://localhost:${port}/health`);
    console.log('Available endpoints:');
    console.log('  GET  /health - Health check');
    console.log('  GET  /ping - Simple ping test');
    console.log('  GET  /info - Server information');
    console.log('  POST /analyze - Analyze AutoHotkey code');
});
// Handle process termination
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    process.exit(0);
});
