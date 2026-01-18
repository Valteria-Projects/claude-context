import * as chokidar from 'chokidar';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface FileChange {
    type: 'add' | 'change' | 'unlink';
    relativePath: string;
    absolutePath: string;
}

export interface AggregatedChanges {
    added: string[];
    modified: string[];
    removed: string[];
}

export interface WatcherConfig {
    /** Debounce time in milliseconds for normal changes (default: 1000ms) */
    debounceMs?: number;
    /** Debounce time in milliseconds for burst mode (default: 5000ms) */
    burstDebounceMs?: number;
    /** Number of changes in burstWindowMs to trigger burst mode (default: 50) */
    burstThreshold?: number;
    /** Time window to detect burst mode in milliseconds (default: 2000ms) */
    burstWindowMs?: number;
    /** File extensions to watch (default: uses Context's supported extensions) */
    supportedExtensions?: string[];
    /** Patterns to ignore (default: uses Context's ignore patterns) */
    ignorePatterns?: string[];
}

export interface WatcherStatus {
    isWatching: boolean;
    codebasePath: string;
    pendingChanges: number;
    isBurstMode: boolean;
    lastChangeTime?: Date;
    error?: string;
}

const DEFAULT_CONFIG: Required<Omit<WatcherConfig, 'supportedExtensions' | 'ignorePatterns'>> = {
    debounceMs: 1000,
    burstDebounceMs: 5000,
    burstThreshold: 50,
    burstWindowMs: 2000,
};

const DEFAULT_SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
    '.md', '.markdown', '.ipynb',
];

const DEFAULT_IGNORE_PATTERNS = [
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',
    '.git/**',
    '.svn/**',
    '.hg/**',
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',
    '.env',
    '.env.*',
    '*.local',
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map',
];

export class FileWatcher extends EventEmitter {
    private watcher: chokidar.FSWatcher | null = null;
    private codebasePath: string;
    private config: Required<Omit<WatcherConfig, 'supportedExtensions' | 'ignorePatterns'>> & {
        supportedExtensions: string[];
        ignorePatterns: string[];
    };

    // Debouncing and batching
    private pendingChanges: Map<string, FileChange> = new Map();
    private debounceTimer: NodeJS.Timeout | null = null;
    private recentChangeTimestamps: number[] = [];
    private isBurstMode: boolean = false;

    // Status tracking
    private isWatching: boolean = false;
    private lastChangeTime?: Date;
    private lastError?: string;

    constructor(codebasePath: string, config: WatcherConfig = {}) {
        super();
        this.codebasePath = path.resolve(codebasePath);
        this.config = {
            debounceMs: config.debounceMs ?? DEFAULT_CONFIG.debounceMs,
            burstDebounceMs: config.burstDebounceMs ?? DEFAULT_CONFIG.burstDebounceMs,
            burstThreshold: config.burstThreshold ?? DEFAULT_CONFIG.burstThreshold,
            burstWindowMs: config.burstWindowMs ?? DEFAULT_CONFIG.burstWindowMs,
            supportedExtensions: config.supportedExtensions ?? DEFAULT_SUPPORTED_EXTENSIONS,
            ignorePatterns: config.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
        };
    }

    /**
     * Start watching the codebase directory
     */
    async start(): Promise<void> {
        if (this.watcher) {
            console.log(`[FileWatcher] Already watching ${this.codebasePath}`);
            return;
        }

        console.log(`[FileWatcher] Starting to watch ${this.codebasePath}`);

        // Build glob patterns for supported extensions
        const extensionPatterns = this.config.supportedExtensions.map(ext =>
            `**/*${ext}`
        );

        this.watcher = chokidar.watch(extensionPatterns, {
            cwd: this.codebasePath,
            ignored: this.config.ignorePatterns,
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 300,
                pollInterval: 100,
            },
            followSymlinks: false,
            depth: 99,
        });

        this.watcher
            .on('add', (relativePath) => this.handleFileEvent('add', relativePath))
            .on('change', (relativePath) => this.handleFileEvent('change', relativePath))
            .on('unlink', (relativePath) => this.handleFileEvent('unlink', relativePath))
            .on('error', (error) => this.handleError(error))
            .on('ready', () => {
                this.isWatching = true;
                console.log(`[FileWatcher] Ready and watching ${this.codebasePath}`);
                this.emit('ready');
            });
    }

    /**
     * Stop watching the codebase directory
     */
    async stop(): Promise<void> {
        if (!this.watcher) {
            return;
        }

        console.log(`[FileWatcher] Stopping watcher for ${this.codebasePath}`);

        // Clear any pending debounce
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Flush pending changes before stopping
        if (this.pendingChanges.size > 0) {
            this.emitAggregatedChanges();
        }

        await this.watcher.close();
        this.watcher = null;
        this.isWatching = false;
        this.pendingChanges.clear();
        this.recentChangeTimestamps = [];
        this.isBurstMode = false;

        console.log(`[FileWatcher] Stopped watching ${this.codebasePath}`);
        this.emit('stopped');
    }

    /**
     * Pause watching (keeps watcher alive but stops emitting events)
     */
    pause(): void {
        if (this.watcher) {
            console.log(`[FileWatcher] Pausing watcher for ${this.codebasePath}`);
            this.isWatching = false;
            this.emit('paused');
        }
    }

    /**
     * Resume watching after pause
     */
    resume(): void {
        if (this.watcher) {
            console.log(`[FileWatcher] Resuming watcher for ${this.codebasePath}`);
            this.isWatching = true;
            this.emit('resumed');
        }
    }

    /**
     * Get current watcher status
     */
    getStatus(): WatcherStatus {
        return {
            isWatching: this.isWatching,
            codebasePath: this.codebasePath,
            pendingChanges: this.pendingChanges.size,
            isBurstMode: this.isBurstMode,
            lastChangeTime: this.lastChangeTime,
            error: this.lastError,
        };
    }

    /**
     * Get the codebase path being watched
     */
    getCodebasePath(): string {
        return this.codebasePath;
    }

    private handleFileEvent(type: 'add' | 'change' | 'unlink', relativePath: string): void {
        if (!this.isWatching) {
            return;
        }

        const absolutePath = path.join(this.codebasePath, relativePath);
        const ext = path.extname(relativePath);

        // Double-check extension (chokidar should already filter, but be safe)
        if (!this.config.supportedExtensions.includes(ext)) {
            return;
        }

        this.lastChangeTime = new Date();
        this.lastError = undefined;

        // Track for burst detection
        const now = Date.now();
        this.recentChangeTimestamps.push(now);

        // Remove timestamps outside the burst window
        const windowStart = now - this.config.burstWindowMs;
        this.recentChangeTimestamps = this.recentChangeTimestamps.filter(t => t >= windowStart);

        // Detect burst mode
        const wasBurstMode = this.isBurstMode;
        this.isBurstMode = this.recentChangeTimestamps.length >= this.config.burstThreshold;

        if (this.isBurstMode && !wasBurstMode) {
            console.log(`[FileWatcher] Burst mode detected (${this.recentChangeTimestamps.length} changes in ${this.config.burstWindowMs}ms)`);
            this.emit('burstModeStart');
        } else if (!this.isBurstMode && wasBurstMode) {
            console.log(`[FileWatcher] Burst mode ended`);
            this.emit('burstModeEnd');
        }

        // Add to pending changes (newer event for same file overwrites older)
        const change: FileChange = { type, relativePath, absolutePath };
        this.pendingChanges.set(relativePath, change);

        // Schedule debounced emission
        this.scheduleEmit();
    }

    private scheduleEmit(): void {
        // Clear existing timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Use longer debounce in burst mode
        const debounceTime = this.isBurstMode
            ? this.config.burstDebounceMs
            : this.config.debounceMs;

        this.debounceTimer = setTimeout(() => {
            this.emitAggregatedChanges();
        }, debounceTime);
    }

    private emitAggregatedChanges(): void {
        if (this.pendingChanges.size === 0) {
            return;
        }

        const changes: AggregatedChanges = {
            added: [],
            modified: [],
            removed: [],
        };

        for (const [, change] of this.pendingChanges) {
            switch (change.type) {
                case 'add':
                    changes.added.push(change.relativePath);
                    break;
                case 'change':
                    changes.modified.push(change.relativePath);
                    break;
                case 'unlink':
                    changes.removed.push(change.relativePath);
                    break;
            }
        }

        console.log(`[FileWatcher] Emitting changes for ${this.codebasePath}: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.removed.length} removed`);

        this.pendingChanges.clear();
        this.debounceTimer = null;

        this.emit('changes', changes);
    }

    private handleError(error: Error): void {
        this.lastError = error.message;
        console.error(`[FileWatcher] Error watching ${this.codebasePath}:`, error);
        this.emit('error', error);
    }
}
