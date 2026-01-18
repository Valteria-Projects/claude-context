import { EventEmitter } from 'events';
import { FileWatcher, WatcherConfig, WatcherStatus, AggregatedChanges } from './watcher';

export interface WatcherManagerConfig {
    /** Maximum number of concurrent watchers (default: 10) */
    maxWatchers?: number;
    /** Default configuration for new watchers */
    defaultWatcherConfig?: WatcherConfig;
}

export interface ManagedWatcherInfo {
    watcher: FileWatcher;
    config: WatcherConfig;
    startedAt: Date;
    onChanges?: (changes: AggregatedChanges) => Promise<void>;
}

const DEFAULT_MAX_WATCHERS = 10;

export class FileWatcherManager extends EventEmitter {
    private watchers: Map<string, ManagedWatcherInfo> = new Map();
    private maxWatchers: number;
    private defaultConfig: WatcherConfig;

    constructor(config: WatcherManagerConfig = {}) {
        super();
        this.maxWatchers = config.maxWatchers ?? DEFAULT_MAX_WATCHERS;
        this.defaultConfig = config.defaultWatcherConfig ?? {};
    }

    /**
     * Start watching a codebase directory
     * @param codebasePath Path to the codebase
     * @param onChanges Callback when changes are detected
     * @param config Optional watcher configuration
     */
    async startWatching(
        codebasePath: string,
        onChanges?: (changes: AggregatedChanges) => Promise<void>,
        config?: WatcherConfig
    ): Promise<void> {
        // Check if already watching
        if (this.watchers.has(codebasePath)) {
            console.log(`[FileWatcherManager] Already watching ${codebasePath}`);
            return;
        }

        // Check max watchers limit
        if (this.watchers.size >= this.maxWatchers) {
            throw new Error(
                `Maximum number of watchers (${this.maxWatchers}) reached. ` +
                `Stop watching another codebase first.`
            );
        }

        const mergedConfig: WatcherConfig = {
            ...this.defaultConfig,
            ...config,
        };

        const watcher = new FileWatcher(codebasePath, mergedConfig);

        // Set up event handlers
        watcher.on('changes', async (changes: AggregatedChanges) => {
            console.log(`[FileWatcherManager] Changes detected in ${codebasePath}`);
            this.emit('changes', { codebasePath, changes });

            if (onChanges) {
                try {
                    await onChanges(changes);
                } catch (error) {
                    console.error(`[FileWatcherManager] Error in change handler for ${codebasePath}:`, error);
                    this.emit('handlerError', { codebasePath, error });
                }
            }
        });

        watcher.on('error', (error: Error) => {
            console.error(`[FileWatcherManager] Watcher error for ${codebasePath}:`, error);
            this.emit('watcherError', { codebasePath, error });

            // Attempt recovery
            this.attemptRecovery(codebasePath);
        });

        watcher.on('ready', () => {
            this.emit('watcherReady', { codebasePath });
        });

        watcher.on('stopped', () => {
            this.emit('watcherStopped', { codebasePath });
        });

        watcher.on('burstModeStart', () => {
            this.emit('burstModeStart', { codebasePath });
        });

        watcher.on('burstModeEnd', () => {
            this.emit('burstModeEnd', { codebasePath });
        });

        // Start the watcher
        await watcher.start();

        // Store watcher info
        this.watchers.set(codebasePath, {
            watcher,
            config: mergedConfig,
            startedAt: new Date(),
            onChanges,
        });

        console.log(`[FileWatcherManager] Started watching ${codebasePath} (${this.watchers.size}/${this.maxWatchers} watchers)`);
    }

    /**
     * Stop watching a codebase directory
     */
    async stopWatching(codebasePath: string): Promise<void> {
        const info = this.watchers.get(codebasePath);
        if (!info) {
            console.log(`[FileWatcherManager] Not watching ${codebasePath}`);
            return;
        }

        await info.watcher.stop();
        this.watchers.delete(codebasePath);

        console.log(`[FileWatcherManager] Stopped watching ${codebasePath} (${this.watchers.size}/${this.maxWatchers} watchers)`);
    }

    /**
     * Stop all watchers
     */
    async stopAll(): Promise<void> {
        console.log(`[FileWatcherManager] Stopping all watchers (${this.watchers.size} active)`);

        const stopPromises: Promise<void>[] = [];
        for (const [codebasePath] of this.watchers) {
            stopPromises.push(this.stopWatching(codebasePath));
        }

        await Promise.all(stopPromises);
        console.log(`[FileWatcherManager] All watchers stopped`);
    }

    /**
     * Pause a watcher
     */
    pause(codebasePath: string): void {
        const info = this.watchers.get(codebasePath);
        if (info) {
            info.watcher.pause();
        }
    }

    /**
     * Resume a paused watcher
     */
    resume(codebasePath: string): void {
        const info = this.watchers.get(codebasePath);
        if (info) {
            info.watcher.resume();
        }
    }

    /**
     * Pause all watchers
     */
    pauseAll(): void {
        for (const [, info] of this.watchers) {
            info.watcher.pause();
        }
    }

    /**
     * Resume all watchers
     */
    resumeAll(): void {
        for (const [, info] of this.watchers) {
            info.watcher.resume();
        }
    }

    /**
     * Check if a codebase is being watched
     */
    isWatching(codebasePath: string): boolean {
        return this.watchers.has(codebasePath);
    }

    /**
     * Get status of a specific watcher
     */
    getWatcherStatus(codebasePath: string): WatcherStatus | undefined {
        const info = this.watchers.get(codebasePath);
        if (!info) {
            return undefined;
        }
        return info.watcher.getStatus();
    }

    /**
     * Get status of all watchers
     */
    getAllWatcherStatuses(): Map<string, WatcherStatus> {
        const statuses = new Map<string, WatcherStatus>();
        for (const [codebasePath, info] of this.watchers) {
            statuses.set(codebasePath, info.watcher.getStatus());
        }
        return statuses;
    }

    /**
     * Get list of all watched codebase paths
     */
    getWatchedPaths(): string[] {
        return Array.from(this.watchers.keys());
    }

    /**
     * Get current watcher count
     */
    getWatcherCount(): number {
        return this.watchers.size;
    }

    /**
     * Get maximum allowed watchers
     */
    getMaxWatchers(): number {
        return this.maxWatchers;
    }

    /**
     * Attempt to recover from watcher errors
     */
    private async attemptRecovery(codebasePath: string): Promise<void> {
        const info = this.watchers.get(codebasePath);
        if (!info) {
            return;
        }

        console.log(`[FileWatcherManager] Attempting recovery for ${codebasePath}`);

        try {
            // Stop the failed watcher
            await info.watcher.stop();
            this.watchers.delete(codebasePath);

            // Wait a bit before restarting
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Restart the watcher
            await this.startWatching(codebasePath, info.onChanges, info.config);

            console.log(`[FileWatcherManager] Recovery successful for ${codebasePath}`);
            this.emit('recoverySuccess', { codebasePath });
        } catch (error) {
            console.error(`[FileWatcherManager] Recovery failed for ${codebasePath}:`, error);
            this.emit('recoveryFailed', { codebasePath, error });
        }
    }
}
