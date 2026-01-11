#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import logger from './logger.js';
/**
 * Simple HTTP wrapper for testing ChatGPT integration
 */
class SimpleHttpServer {
    constructor(port = 3000) {
        this.app = express();
        this.port = port;
        this.setupMiddleware();
        this.setupRoutes();
    }
    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
    }
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                server: 'AutoHotkey MCP Server',
                timestamp: new Date().toISOString(),
            });
        });
        // Simple ping endpoint
        this.app.get('/ping', (req, res) => {
            res.json({ message: 'pong' });
        });
        // Basic info endpoint
        this.app.get('/info', (req, res) => {
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
        this.app.post('/analyze', (req, res) => {
            try {
                const { code } = req.body;
                if (!code) {
                    return res.status(400).json({ error: 'Code parameter is required' });
                }
                // Simple analysis (you can enhance this later)
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
                logger.error('Error analyzing code:', error);
                res.status(500).json({ error: 'Failed to analyze code' });
            }
        });
        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                availableEndpoints: ['/health', '/ping', '/info', '/analyze'],
            });
        });
    }
    start() {
        this.app.listen(this.port, () => {
            logger.info(`Simple AutoHotkey HTTP Server started on port ${this.port}`);
            logger.info(`Server URL: http://localhost:${this.port}`);
            logger.info(`Test with: curl http://localhost:${this.port}/health`);
            logger.info(`Available endpoints:`);
            logger.info(`  GET  /health - Health check`);
            logger.info(`  GET  /ping - Simple ping test`);
            logger.info(`  GET  /info - Server information`);
            logger.info(`  POST /analyze - Analyze AutoHotkey code`);
        });
    }
}
// Start the server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    const server = new SimpleHttpServer(port);
    server.start();
}
export { SimpleHttpServer };
