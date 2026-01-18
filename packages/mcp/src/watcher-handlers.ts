import * as fs from "fs";
import { Context } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath } from "./utils.js";
import { CodebaseInfoIndexed, WatcherConfigSnapshot } from "./config.js";

export class WatcherHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    /**
     * Start watching a codebase for file changes
     */
    public async handleStartWatching(args: any) {
        const { path: codebasePath, debounceMs, burstDebounceMs } = args;

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if codebase is indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            if (!isIndexed) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool before starting a watcher.`
                    }],
                    isError: true
                };
            }

            // Check if already watching
            if (this.context.isWatching(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already being watched.`
                    }]
                };
            }

            // Build watcher config
            const watcherConfig: any = {};
            if (debounceMs !== undefined) {
                watcherConfig.debounceMs = debounceMs;
            }
            if (burstDebounceMs !== undefined) {
                watcherConfig.burstDebounceMs = burstDebounceMs;
            }

            console.log(`[WATCHER] Starting file watcher for: ${absolutePath}`);

            // Start watching with reindex callback
            await this.context.startWatching(
                absolutePath,
                (result) => {
                    console.log(`[WATCHER] Reindex complete for ${absolutePath}: ${result.added} added, ${result.removed} removed, ${result.modified} modified`);
                },
                watcherConfig
            );

            // Update snapshot to indicate watcher is enabled
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);
            if (info && info.status === 'indexed') {
                const indexedInfo = info as CodebaseInfoIndexed;
                const watcherConfigSnapshot: WatcherConfigSnapshot = {};
                if (debounceMs !== undefined) {
                    watcherConfigSnapshot.debounceMs = debounceMs;
                }
                if (burstDebounceMs !== undefined) {
                    watcherConfigSnapshot.burstDebounceMs = burstDebounceMs;
                }

                // Update the indexed info with watcher state
                this.snapshotManager.setCodebaseIndexed(absolutePath, {
                    indexedFiles: indexedInfo.indexedFiles,
                    totalChunks: indexedInfo.totalChunks,
                    status: indexedInfo.indexStatus
                });

                // Manually update watcher fields
                const updatedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as CodebaseInfoIndexed;
                if (updatedInfo) {
                    updatedInfo.watcherEnabled = true;
                    updatedInfo.watcherConfig = Object.keys(watcherConfigSnapshot).length > 0 ? watcherConfigSnapshot : undefined;
                }

                this.snapshotManager.saveCodebaseSnapshot();
            }

            const watcherManager = this.context.getWatcherManager();
            const watcherCount = watcherManager.getWatcherCount();
            const maxWatchers = watcherManager.getMaxWatchers();

            return {
                content: [{
                    type: "text",
                    text: `Started watching codebase '${absolutePath}' for file changes.\n\nThe index will automatically update when files are added, modified, or removed.\n\nActive watchers: ${watcherCount}/${maxWatchers}`
                }]
            };

        } catch (error: any) {
            console.error('Error in handleStartWatching:', error);
            return {
                content: [{
                    type: "text",
                    text: `Error starting file watcher: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * Stop watching a codebase for file changes
     */
    public async handleStopWatching(args: any) {
        const { path: codebasePath } = args;

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Check if watching
            if (!this.context.isWatching(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is not being watched.`
                    }]
                };
            }

            console.log(`[WATCHER] Stopping file watcher for: ${absolutePath}`);

            await this.context.stopWatching(absolutePath);

            // Update snapshot to indicate watcher is disabled
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);
            if (info && info.status === 'indexed') {
                const indexedInfo = info as CodebaseInfoIndexed;
                indexedInfo.watcherEnabled = false;
                indexedInfo.watcherConfig = undefined;
                this.snapshotManager.saveCodebaseSnapshot();
            }

            const watcherManager = this.context.getWatcherManager();
            const watcherCount = watcherManager.getWatcherCount();
            const maxWatchers = watcherManager.getMaxWatchers();

            return {
                content: [{
                    type: "text",
                    text: `Stopped watching codebase '${absolutePath}'.\n\nActive watchers: ${watcherCount}/${maxWatchers}`
                }]
            };

        } catch (error: any) {
            console.error('Error in handleStopWatching:', error);
            return {
                content: [{
                    type: "text",
                    text: `Error stopping file watcher: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * Get status of all file watchers
     */
    public async handleGetWatcherStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            const watcherManager = this.context.getWatcherManager();

            // If a specific path is provided, show status for that codebase
            if (codebasePath) {
                const absolutePath = ensureAbsolutePath(codebasePath);
                const status = this.context.getWatcherStatus(absolutePath);

                if (!status) {
                    // Check if the codebase exists and is indexed
                    const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
                    if (!isIndexed) {
                        return {
                            content: [{
                                type: "text",
                                text: `Codebase '${absolutePath}' is not indexed. Index it first before checking watcher status.`
                            }]
                        };
                    }

                    return {
                        content: [{
                            type: "text",
                            text: `No active watcher for codebase '${absolutePath}'.\n\nUse the start_watching tool to enable automatic index updates when files change.`
                        }]
                    };
                }

                const statusLines = [
                    `Watcher Status for '${absolutePath}':`,
                    `  Status: ${status.isWatching ? 'Active' : 'Paused'}`,
                    `  Pending changes: ${status.pendingChanges}`,
                    `  Burst mode: ${status.isBurstMode ? 'Yes (high activity detected)' : 'No'}`,
                ];

                if (status.lastChangeTime) {
                    statusLines.push(`  Last change: ${status.lastChangeTime.toLocaleString()}`);
                }

                if (status.error) {
                    statusLines.push(`  Error: ${status.error}`);
                }

                return {
                    content: [{
                        type: "text",
                        text: statusLines.join('\n')
                    }]
                };
            }

            // Show status for all watchers
            const allStatuses = watcherManager.getAllWatcherStatuses();
            const watcherCount = watcherManager.getWatcherCount();
            const maxWatchers = watcherManager.getMaxWatchers();

            if (watcherCount === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No active file watchers.\n\nCapacity: 0/${maxWatchers}\n\nUse the start_watching tool to enable automatic index updates when files change in an indexed codebase.`
                    }]
                };
            }

            const statusLines = [
                `Active File Watchers (${watcherCount}/${maxWatchers}):`,
                ''
            ];

            for (const [path, status] of allStatuses) {
                statusLines.push(`📁 ${path}`);
                statusLines.push(`   Status: ${status.isWatching ? 'Active' : 'Paused'}`);
                statusLines.push(`   Pending changes: ${status.pendingChanges}`);
                if (status.isBurstMode) {
                    statusLines.push(`   Burst mode: Active (high activity detected)`);
                }
                if (status.lastChangeTime) {
                    statusLines.push(`   Last change: ${status.lastChangeTime.toLocaleString()}`);
                }
                if (status.error) {
                    statusLines.push(`   Error: ${status.error}`);
                }
                statusLines.push('');
            }

            return {
                content: [{
                    type: "text",
                    text: statusLines.join('\n')
                }]
            };

        } catch (error: any) {
            console.error('Error in handleGetWatcherStatus:', error);
            return {
                content: [{
                    type: "text",
                    text: `Error getting watcher status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    /**
     * Auto-start watchers for codebases that had watchers enabled
     * Called during server startup
     */
    public async autoStartWatchers(): Promise<void> {
        console.log('[WATCHER] Checking for codebases with watchers to auto-start...');

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();
        let startedCount = 0;

        for (const codebasePath of indexedCodebases) {
            const info = this.snapshotManager.getCodebaseInfo(codebasePath);
            if (info && info.status === 'indexed') {
                const indexedInfo = info as CodebaseInfoIndexed;
                if (indexedInfo.watcherEnabled) {
                    try {
                        console.log(`[WATCHER] Auto-starting watcher for: ${codebasePath}`);

                        const watcherConfig: any = {};
                        if (indexedInfo.watcherConfig?.debounceMs) {
                            watcherConfig.debounceMs = indexedInfo.watcherConfig.debounceMs;
                        }
                        if (indexedInfo.watcherConfig?.burstDebounceMs) {
                            watcherConfig.burstDebounceMs = indexedInfo.watcherConfig.burstDebounceMs;
                        }

                        await this.context.startWatching(
                            codebasePath,
                            (result) => {
                                console.log(`[WATCHER] Reindex complete for ${codebasePath}: ${result.added} added, ${result.removed} removed, ${result.modified} modified`);
                            },
                            watcherConfig
                        );

                        startedCount++;
                        console.log(`[WATCHER] Auto-started watcher for: ${codebasePath}`);
                    } catch (error) {
                        console.error(`[WATCHER] Failed to auto-start watcher for ${codebasePath}:`, error);
                    }
                }
            }
        }

        if (startedCount > 0) {
            console.log(`[WATCHER] Auto-started ${startedCount} watcher(s)`);
        } else {
            console.log('[WATCHER] No watchers to auto-start');
        }
    }
}
