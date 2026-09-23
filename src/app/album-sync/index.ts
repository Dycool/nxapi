import { app as electronApp, clipboard, dialog, Notification, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import type { App } from '../main/index.js';
import type { AlbumSyncSettings, AlbumSyncStatus } from '../common/types.js';
import { defaultAlbumFolder, fetchLatestCapture, syncAlbum } from '../../common/album-sync.js';
import createDebug from '../../util/debug.js';

const debug = createDebug('app:album-sync');
const SETTINGS_KEY = 'AlbumSyncSettings';
const JITTER_DIVISOR = 50; // +/- 2% polling jitter
const DEFAULT_INTERVAL_MINUTES = 60;

function parseLegacyLastSync(value: unknown) {
    if (typeof value !== 'string' || !value || value === 'Never') return null;

    const match = value.match(/^(\d{2}):(\d{2}) \((\d{4})-(\d{2})-(\d{2})\)$/);
    if (!match) return null;

    const date = new Date(
        Number(match[3]),
        Number(match[4]) - 1,
        Number(match[5]),
        Number(match[1]),
        Number(match[2]),
    );

    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function jitteredInterval(milliseconds: number) {
    const nominal = Math.max(1, milliseconds);
    const jitter = Math.max(1, Math.floor(nominal / JITTER_DIVISOR));
    return Math.max(1, nominal + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter);
}

function windowsDropFilesBuffer(filename: string) {
    const files = Buffer.from(filename + '\0\0', 'utf16le');
    const header = Buffer.alloc(20);

    // DROPFILES: DWORD pFiles, POINT pt, BOOL fNC, BOOL fWide
    header.writeUInt32LE(20, 0);
    header.writeInt32LE(0, 4);
    header.writeInt32LE(0, 8);
    header.writeInt32LE(0, 12);
    header.writeInt32LE(1, 16);

    return Buffer.concat([header, files]);
}

function macFilenamesPboardBuffer(filename: string) {
    const escaped = filename
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    return Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><array><string>' + escaped + '</string></array></plist>\n',
        'utf8',
    );
}

async function copyFileToClipboard(filename: string) {
    const absolute = path.resolve(filename);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) return false;

    if (process.platform === 'win32') {
        clipboard.writeBuffer('CF_HDROP', windowsDropFilesBuffer(absolute));
        return clipboard.availableFormats().includes('CF_HDROP');
    }

    if (process.platform === 'darwin') {
        const files = macFilenamesPboardBuffer(absolute);
        clipboard.writeBuffer('NSFilenamesPboardType', files);
        return clipboard.readBuffer('NSFilenamesPboardType').equals(files);
    }

    const uri = pathToFileURL(absolute).href + '\r\n';
    clipboard.writeBuffer('text/uri-list', Buffer.from(uri, 'utf8'));
    return clipboard.availableFormats().some(format => format.toLowerCase() === 'text/uri-list');
}

export default class AlbumSyncManager {
    private settings: AlbumSyncSettings | null = null;
    private timer: NodeJS.Timeout | null = null;
    private syncPromise: Promise<unknown> | null = null;
    private latestCapturePromise: Promise<string | null> | null = null;
    private abortController: AbortController | null = null;
    private captureAbortController: AbortController | null = null;
    private accountToken: string | undefined;
    private stopped = false;
    private scheduleGeneration = 0;
    private settingsWrite: Promise<unknown> = Promise.resolve();

    readonly status: AlbumSyncStatus = {
        busy: false,
        copying: false,
        state: 'ready',
        media_type: null,
        error_message: null,
        last_sync_at: null,
    };

    constructor(readonly app: App) {}

    private onAccountsUpdated = () => {
        void this.restartAutoSyncAfterAccountChange();
    };

    async init() {
        await this.app.i18n.loadNamespaces('notifications');
        const settings = await this.getSettings();
        this.accountToken = await this.selectedAccountToken();
        this.status.last_sync_at = settings.last_sync_at;
        this.emitState();

        this.app.store.on('update-nintendo-accounts', this.onAccountsUpdated);

        if (settings.feature_enabled && settings.enabled) {
            void this.runAutomaticSync(true);
        }
    }

    async getSettings(): Promise<AlbumSyncSettings> {
        if (this.settings) return {...this.settings};

        const saved = await this.app.store.storage.getItem(SETTINGS_KEY) as
            (Partial<AlbumSyncSettings> & {last_sync?: string}) | undefined;
        const destination = saved?.destination || await defaultAlbumFolder(
            process.platform === 'win32' ? {
                picturesDirectory: electronApp.getPath('pictures'),
                videosDirectory: electronApp.getPath('videos'),
            } : {},
        );

        let defaultUserId: string | null = null;
        if (!saved?.user_id) {
            const ids = await this.app.store.storage.getItem('NintendoAccountIds') as string[] | undefined;
            for (const id of ids ?? []) {
                if (await this.app.store.storage.getItem('NintendoAccountToken.' + id)) {
                    defaultUserId = id;
                    break;
                }
            }
        }

        this.settings = {
            feature_enabled: saved?.feature_enabled ?? false,
            enabled: saved?.enabled ?? false,
            notifications: saved?.notifications ?? false,
            interval_minutes: Math.max(1, saved?.interval_minutes ?? DEFAULT_INTERVAL_MINUTES),
            user_id: saved?.user_id ?? defaultUserId,
            destination,
            last_sync_at: typeof saved?.last_sync_at === 'number' ?
                saved.last_sync_at : parseLegacyLastSync(saved?.last_sync),
        };

        await this.saveSettings();
        return {...this.settings};
    }

    async setSettings(update: Partial<AlbumSyncSettings>) {
        const previous = await this.getSettings();

        this.settings = {
            ...previous,
            ...update,
            interval_minutes: Math.max(1, update.interval_minutes ?? previous.interval_minutes),
        };

        const accountChanged = previous.user_id !== this.settings.user_id;
        if (accountChanged || !this.settings.feature_enabled) this.cancelActiveWork();
        await this.saveSettings();
        this.status.last_sync_at = this.settings.last_sync_at;
        this.emitState();

        const featureChanged = previous.feature_enabled !== this.settings.feature_enabled;
        const enabledChanged = previous.enabled !== this.settings.enabled;
        const scheduleChanged = previous.interval_minutes !== this.settings.interval_minutes ||
            previous.user_id !== this.settings.user_id;

        if (!this.settings.feature_enabled || !this.settings.enabled) {
            this.clearTimer();
            if (!this.settings.feature_enabled) {
                this.abortController?.abort(new Error('Album Sync disabled'));
            }
        } else if (featureChanged || enabledChanged || accountChanged) {
            this.clearTimer();
            void this.restartAutoSyncAfterAccountChange(true, false);

            if (this.settings.notifications) {
                const t = this.app.i18n.getFixedT(null, 'notifications');
                this.notify(this.settings.interval_minutes === 60 ?
                    t('album_sync.auto_sync_enabled_hourly')! :
                    t('album_sync.auto_sync_enabled_minutes', {count: this.settings.interval_minutes})!);
            }
        } else if (scheduleChanged) {
            await this.scheduleNext();
        }

        if (enabledChanged && !this.settings.enabled && this.settings.notifications) {
            const t = this.app.i18n.getFixedT(null, 'notifications');
            this.notify(t('album_sync.auto_sync_disabled')!);
        }

        return {...this.settings};
    }

    async toggleEnabled() {
        const settings = await this.getSettings();
        return this.setSettings({enabled: !settings.enabled});
    }

    async toggleNotifications() {
        const settings = await this.getSettings();
        return this.setSettings({notifications: !settings.notifications});
    }

    private async saveSettings() {
        if (!this.settings) return;
        const settings = {...this.settings};
        this.settingsWrite = this.settingsWrite.catch(() => {}).then(() =>
            this.app.store.storage.setItem(SETTINGS_KEY, settings));
        await this.settingsWrite;
    }

    private clearTimer() {
        this.scheduleGeneration++;
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = null;
    }

    private async hasSignedInAccount() {
        const settings = await this.getSettings();
        if (!settings.user_id) return false;

        return !!await this.app.store.storage.getItem('NintendoAccountToken.' + settings.user_id);
    }

    private async runAutomaticSync(background: boolean) {
        const settings = await this.getSettings();
        if (this.stopped || !settings.feature_enabled || !settings.enabled || !(await this.hasSignedInAccount())) {
            this.clearTimer();
            return;
        }

        await this.scheduleNext();
        if (this.syncPromise) return;

        try {
            await this.syncNow(background);
        } catch (err) {
            debug('Automatic album sync failed', err);
        }
    }

    private async selectedAccountToken() {
        const settings = await this.getSettings();
        return settings.user_id ? await this.app.store.storage.getItem(
            'NintendoAccountToken.' + settings.user_id) as string | undefined : undefined;
    }

    private cancelActiveWork() {
        this.abortController?.abort(new Error('Sync cancelled'));
        this.captureAbortController?.abort(new Error('Sync cancelled'));
    }

    private async restartAutoSyncAfterAccountChange(force = false, background = true) {
        const token = await this.selectedAccountToken();
        const accountChanged = token !== this.accountToken;
        if (!force && !accountChanged) return;
        this.accountToken = token;
        this.clearTimer();
        if (accountChanged) {
            this.cancelActiveWork();
            await Promise.allSettled([this.syncPromise, this.latestCapturePromise]);
        }
        if (!this.stopped) await this.runAutomaticSync(background);
    }

    private async scheduleNext() {
        this.clearTimer();

        const generation = this.scheduleGeneration;
        const settings = await this.getSettings();
        if (this.stopped || !settings.feature_enabled || !settings.enabled ||
            !(await this.hasSignedInAccount()) || generation !== this.scheduleGeneration) return;

        const delay = jitteredInterval(settings.interval_minutes * 60 * 1000);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.runAutomaticSync(true);
        }, delay);
        this.timer.unref?.();
    }

    private async resolveAccount() {
        const settings = await this.getSettings();
        const storage = this.app.store.storage;
        const userId = settings.user_id;

        if (!userId) throw new Error('Choose a Nintendo Account for Album Sync in Preferences');

        const token = await storage.getItem('NintendoAccountToken.' + userId) as string | undefined;
        if (!token) throw new Error('Nintendo Account is not signed in');

        const user = await this.app.store.users.get(token);
        return {userId, token, user};
    }

    async syncNow(background = false) {
        const settings = await this.getSettings();
        if (!settings.feature_enabled) throw new Error('Album Sync is disabled');
        if (this.syncPromise) return null;

        const run = async () => {
            this.status.busy = true;
            this.status.state = 'syncing';
            this.status.media_type = null;
            this.status.error_message = null;
            this.emitState();

            const controller = this.abortController = new AbortController();

            try {
                const {user} = await this.resolveAccount();
                const settings = await this.getSettings();

                const result = await syncAlbum(user.nso, {
                    destination: settings.destination,
                    signal: controller.signal,
                });

                controller.signal.throwIfAborted();
                const syncTime = Date.now();
                this.status.last_sync_at = syncTime;
                this.status.state = 'ready';
                this.status.media_type = null;
                this.status.error_message = null;

                this.settings = {
                    ...this.settings!,
                    last_sync_at: syncTime,
                };
                await this.saveSettings();

                if (this.settings.notifications) {
                    if (result.newDownloads > 0) {
                        const t = this.app.i18n.getFixedT(null, 'notifications');
                        this.notify(t('album_sync.synced', {count: result.newDownloads})!);
                    } else if (!background) {
                        const t = this.app.i18n.getFixedT(null, 'notifications');
                        this.notify(t('album_sync.up_to_date')!);
                    }
                }

                return result;
            } catch (err) {
                if (controller.signal.aborted) {
                    this.status.state = 'ready';
                    this.status.media_type = null;
                    this.status.error_message = null;
                    return null;
                }
                const message = err instanceof Error ? err.message : String(err);
                this.status.state = 'error';
                this.status.media_type = null;
                this.status.error_message = message;
                debug('Album sync failed', err);

                const settings = await this.getSettings();
                if (settings.notifications) this.notify(message);
                throw err;
            } finally {
                this.abortController = null;
                this.status.busy = false;
                this.emitState();
            }
        };

        this.syncPromise = run().finally(() => this.syncPromise = null);
        return this.syncPromise;
    }

    async copyLatestCapture() {
        const settings = await this.getSettings();
        if (!settings.feature_enabled) throw new Error('Album Sync is disabled');
        if (this.latestCapturePromise) return this.latestCapturePromise;

        const run = async () => {
            const controller = this.captureAbortController = new AbortController();
            this.status.copying = true;
            let mediaType: 'image' | 'video' | null = null;
            this.status.state = 'fetching_latest';
            this.status.media_type = null;
            this.status.error_message = null;
            this.emitState();

            try {
                const {user} = await this.resolveAccount();
                const settings = await this.getSettings();
                const cacheDirectory = path.join(
                    electronApp.getPath('userData'),
                    'album-sync',
                    'clipboard-cache',
                );

                const filename = await fetchLatestCapture(user.nso, {
                    cacheDirectory,
                    signal: controller.signal,
                    onDownloadStarted: type => {
                        mediaType = type;
                        this.status.state = 'downloading';
                        this.status.media_type = type;
                        this.status.error_message = null;
                        this.emitState();
                        if (settings.notifications && type === 'video') {
                            const t = this.app.i18n.getFixedT(null, 'notifications');
                            this.notify(t('album_sync.downloading_video')!);
                        }
                    },
                });

                controller.signal.throwIfAborted();
                if (!(await copyFileToClipboard(filename))) {
                    throw new Error('Could not place the ' + mediaType + ' on the clipboard');
                }

                this.status.state = 'copied';
                this.status.media_type = mediaType;
                this.status.error_message = null;
                if (settings.notifications) {
                    const t = this.app.i18n.getFixedT(null, 'notifications');
                    this.notify(t(mediaType === 'video' ?
                        'album_sync.video_copied' : 'album_sync.image_copied')!);
                }

                return filename;
            } catch (err) {
                if (controller.signal.aborted) {
                    this.status.state = 'ready';
                    this.status.media_type = null;
                    this.status.error_message = null;
                    return null;
                }
                const message = err instanceof Error ? err.message : String(err);
                this.status.state = 'error';
                this.status.media_type = mediaType;
                this.status.error_message = message;
                debug('Copy latest capture failed', err);

                const settings = await this.getSettings();
                if (settings.notifications) this.notify(message);
                throw err;
            } finally {
                this.captureAbortController = null;
                this.status.copying = false;
                this.emitState();
            }
        };

        this.latestCapturePromise = run().finally(() => this.latestCapturePromise = null);
        return this.latestCapturePromise;
    }

    async chooseDestination() {
        const settings = await this.getSettings();
        const result = await dialog.showOpenDialog({
            title: 'Choose Album Folder',
            defaultPath: settings.destination,
            properties: ['openDirectory', 'createDirectory'],
        });

        if (result.canceled || !result.filePaths[0]) return settings.destination;

        await this.setSettings({destination: result.filePaths[0]});
        return result.filePaths[0];
    }

    async openDestination() {
        const settings = await this.getSettings();
        await fs.mkdir(settings.destination, {recursive: true});

        const error = await shell.openPath(settings.destination);
        if (error) throw new Error(error);
    }

    stop() {
        this.stopped = true;
        this.cancelActiveWork();
        this.clearTimer();
        this.app.store.off('update-nintendo-accounts', this.onAccountsUpdated);
        this.abortController?.abort(new Error('Sync cancelled'));
    }

    private notify(body: string) {
        if (!Notification.isSupported()) return;
        const t = this.app.i18n.getFixedT(null, 'notifications');
        new Notification({title: t('album_sync.title')!, body}).show();
    }

    private emitState() {
        const state = {...this.status};
        this.app.store.emit('update-album-sync', state);
    }
}
