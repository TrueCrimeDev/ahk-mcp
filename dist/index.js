#!/usr/bin/env node
import { AutoHotkeyMcpServer } from './server.js';
import logger from './logger.js';
/**
 * Main entry point for the AutoHotkey MCP Server
 */
async function main() {
    try {
        logger.info('Starting AutoHotkey v2 MCP Server...');
        const server = new AutoHotkeyMcpServer();
        await server.start();
    }
    catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}
// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
// Handle uncaught exceptions
process.on('uncaughtException', error => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});
// Start the server
main();
