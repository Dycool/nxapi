import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { request, type Dispatcher } from 'undici';
import type { CoralApiInterface } from '../api/coral.js';
import { MediaType, type Media } from '../api/coral-types.js';

const MAX_MEDIA_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const HTTPS_PREFIX = 'https://';

export interface AlbumSyncResult {
    totalFound: number;
    newDownloads: number;
}

export interface AlbumFolderLocations {
    picturesDirectory?: string;
    videosDirectory?: string;
    moviesDirectory?: string;
}

export interface AlbumSyncOptions {
    destination?: string;
    signal?: AbortSignal;
    locations?: AlbumFolderLocations;
    onDownload?: (media: Media, destination: string) => void | Promise<void>;
}

export interface LatestCaptureOptions {
    cacheDirectory?: string;
    destinationDirectory?: string;
    signal?: AbortSignal;
    onDownloadStarted?: (type: 'image' | 'video') => void | Promise<void>;
}

interface ExistingAlbumIndex {
    filenamesAndPrefixes: Set<string>;
    folderByTimestampPrefix: Map<string, string | null>;
    folderByFilename: Map<string, string>;
    legacyFiles: Map<string, string[]>;
}

function lower(value: string) {
    return value.toLowerCase();
}

export function normalizeAlbumTitleV1(value: string) {
    return value
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function sanitizeAlbumFolderV1(value: string) {
    const result = value
        .normalize('NFKC')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/[\p{Pd}\u2212]/gu, '-')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/[ .]+$/u, '');

    return result || 'Other';
}

function mediaTimestamp(item: Media) {
    return item.capturedAt || item.uploadedAt;
}

export function captureTimestampPrefix(timestamp: number) {
    if (timestamp <= 0) timestamp = Math.floor(Date.now() / 1000);

    const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
    const date = new Date(milliseconds);
    const pad = (value: number) => String(value).padStart(2, '0');

    return String(date.getFullYear()) +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        '00';
}

function mediaFilename(item: Media) {
    const prefix = captureTimestampPrefix(mediaTimestamp(item));
    const extension = item.type === MediaType.VIDEO ? 'mp4' : 'jpg';
    // Include media identity: timestamps alone can collide, even across types.
    const identity = createHash('sha256').update(JSON.stringify([
        item.applicationId, item.id, item.type, item.acdIndex,
    ])).digest('hex');
    return prefix + '_' + identity + '_c.' + extension;
}

function prefixFromExistingFilename(filename: string) {
    let prefix = path.parse(filename).name;
    const identified = prefix.match(/^(\d{16})_[a-f0-9]{64}_c$/i);
    if (identified) return identified[1];
    if (prefix.length > 2 && prefix.endsWith('_c')) {
        prefix = prefix.slice(0, -2);
    } else if (prefix.length > 3 && prefix.endsWith('-00')) {
        prefix = prefix.slice(0, -3);
    }
    return prefix;
}

async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
    signal?.throwIfAborted();

    let directory;
    try {
        directory = await fs.opendir(root);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return;
        throw err;
    }

    for await (const entry of directory) {
        signal?.throwIfAborted();
        const filename = path.join(root, entry.name);

        if (entry.isDirectory()) {
            yield* walkFiles(filename, signal);
        } else if (entry.isFile() || (entry.isSymbolicLink() &&
            await fs.stat(filename).then(stat => stat.isFile(), () => false))) {
            yield filename;
        }
    }
}

async function indexExistingAlbum(root: string, signal?: AbortSignal): Promise<ExistingAlbumIndex> {
    const index: ExistingAlbumIndex = {
        filenamesAndPrefixes: new Set(),
        folderByTimestampPrefix: new Map(),
        folderByFilename: new Map(),
        legacyFiles: new Map(),
    };

    for await (const filename of walkFiles(root, signal)) {
        const basename = path.basename(filename);
        const basenameLower = lower(basename);
        if (basenameLower.endsWith('.part') || basenameLower.endsWith('.tmp')) continue;

        let stat;
        try {
            stat = await fs.stat(filename);
        } catch {
            continue;
        }
        if (!stat.size) continue;

        const prefix = prefixFromExistingFilename(filename);
        if (!/^\d{16}_[a-f0-9]{64}_c$/i.test(path.parse(filename).name)) {
            const key = lower(prefix + path.extname(filename));
            const files = index.legacyFiles.get(key) ?? [];
            files.push(filename);
            index.legacyFiles.set(key, files);
        }
        index.filenamesAndPrefixes.add(basenameLower);
        index.filenamesAndPrefixes.add(lower(prefix));

        const folder = path.basename(path.dirname(filename));
        index.folderByFilename.set(basenameLower, folder);
        if (!index.folderByTimestampPrefix.has(lower(prefix))) {
            index.folderByTimestampPrefix.set(lower(prefix), folder);
        } else if (index.folderByTimestampPrefix.get(lower(prefix)) !== folder) {
            index.folderByTimestampPrefix.set(lower(prefix), null);
        }
    }

    return index;
}

function learnTitleFolders(media: readonly Media[], existing: ExistingAlbumIndex) {
    const folders = new Map<string, string>();
    const applicationsByPrefix = new Map<string, Set<string>>();
    for (const item of media) {
        const prefix = captureTimestampPrefix(mediaTimestamp(item));
        const applications = applicationsByPrefix.get(prefix) ?? new Set<string>();
        applications.add(item.applicationId);
        applicationsByPrefix.set(prefix, applications);
    }

    for (const item of media) {
        if (!item.applicationId) continue;

        const prefix = captureTimestampPrefix(mediaTimestamp(item));
        const existingFolder = existing.folderByFilename.get(lower(mediaFilename(item))) ??
            (applicationsByPrefix.get(prefix)?.size === 1 ?
                existing.folderByTimestampPrefix.get(lower(prefix)) : null);
        const titleId = lower(item.applicationId);
        if (existingFolder) folders.set(titleId, existingFolder);
    }

    return folders;
}

async function pathExists(filename: string) {
    try {
        await fs.access(filename);
        return true;
    } catch {
        return false;
    }
}

export async function resolveAlbumGameFolder(albumDirectory: string, appName: string) {
    const defaultClean = sanitizeAlbumFolderV1(appName);
    if (!appName.trim() || !(await pathExists(albumDirectory))) return defaultClean;

    try {
        const directories: {original: string; normalized: string}[] = [];

        for (const entry of await fs.readdir(albumDirectory, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue;
            directories.push({
                original: entry.name,
                normalized: normalizeAlbumTitleV1(entry.name),
            });
        }

        const normalizedAppName = normalizeAlbumTitleV1(appName);

        const exact = directories.find(directory => lower(directory.original) === lower(defaultClean));
        if (exact) return exact.original;

        const normalized = directories.find(directory => directory.normalized === normalizedAppName);
        if (normalized) return normalized.original;

        if (normalizedAppName) {
            const fuzzy = directories.find(directory =>
                Buffer.byteLength(directory.normalized, 'utf8') >= 6 &&
                Buffer.byteLength(normalizedAppName, 'utf8') >= 6 &&
                (directory.normalized.includes(normalizedAppName) ||
                    normalizedAppName.includes(directory.normalized)));
            if (fuzzy) return fuzzy.original;
        }
    } catch {
        // Folder enumeration failures are non-fatal.
    }

    return defaultClean;
}

function safeMediaUrl(value: string) {
    if (!value.startsWith(HTTPS_PREFIX)) return false;

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }

    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;

    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    while (host.endsWith('.')) host = host.slice(0, -1);

    if (!host || !host.includes('.') || isIP(host)) return false;
    if (!/^[a-z0-9.-]+$/.test(host)) return false;

    return host !== 'localhost' &&
        !host.endsWith('.localhost') &&
        !host.endsWith('.local') &&
        !host.endsWith('.localdomain') &&
        !host.endsWith('.internal') &&
        !host.endsWith('.lan') &&
        !host.endsWith('.home');
}

function validateMediaItemForDownload(item: Media) {
    if (!safeMediaUrl(item.contentUri)) {
        throw new Error('Nintendo media download URL was rejected because it is not a safe public HTTPS URL');
    }

    if (!Number.isSafeInteger(item.contentLength) ||
        item.contentLength <= 0 || item.contentLength > MAX_MEDIA_DOWNLOAD_BYTES) {
        throw new Error('Nintendo media download size is missing or exceeds the 256 MiB safety limit');
    }
}

async function requestMedia(item: Media, signal?: AbortSignal): Promise<Dispatcher.ResponseData> {
    validateMediaItemForDownload(item);

    let currentUrl = item.contentUri;

    for (let redirects = 0; redirects <= 5; redirects++) {
        signal?.throwIfAborted();

        const response = await request(currentUrl, {
            maxRedirections: 0,
            headersTimeout: 60_000,
            bodyTimeout: 60_000,
            signal,
        });

        // The original OpenSSL transport on macOS/Linux returns redirects as errors.
        if (process.platform === 'win32' && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            response.body.on('error', () => {}).destroy();
            if (typeof location !== 'string') throw new Error('Media download redirect did not include a location');

            currentUrl = new URL(location, currentUrl).toString();
            if (!safeMediaUrl(currentUrl)) {
                throw new Error('Nintendo media redirect URL was rejected because it is not a safe public HTTPS URL');
            }
            continue;
        }

        return response;
    }

    throw new Error('Media download exceeded the redirect limit');
}

async function downloadMedia(item: Media, signal?: AbortSignal) {
    const response = await requestMedia(item, signal);
    try {

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error('Media download failed (HTTP ' + response.statusCode + ')');
        }

        const contentLength = Number(response.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_DOWNLOAD_BYTES) {
            throw new Error('Media download exceeded the 256 MiB safety limit');
        }

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
            signal?.throwIfAborted();
            size += chunk.length;
            if (size > MAX_MEDIA_DOWNLOAD_BYTES || size > item.contentLength) {
                throw new Error('Media download exceeded its expected size or the 256 MiB safety limit');
            }
            chunks.push(Buffer.from(chunk));
        }
        signal?.throwIfAborted();
        const body = Buffer.concat(chunks, size);

        if (body.length !== item.contentLength) {
            throw new Error("Media download size did not match Nintendo's content length");
        }
        if (body.length > MAX_MEDIA_DOWNLOAD_BYTES) {
            throw new Error('Media download exceeded the 256 MiB safety limit');
        }

        return body;
    } finally {
        response.body.on('error', () => {}).destroy();
    }
}

async function preserveCaptureTimestamp(filename: string, timestamp: number) {
    if (timestamp <= 0) return;

    try {
        const seconds = timestamp > 10_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
        const date = new Date(seconds * 1000);

        if (process.platform === 'win32') {
            const script = [
                '$file = $env:NXAPI_ALBUM_SYNC_FILE',
                '$seconds = [Int64]$env:NXAPI_ALBUM_SYNC_TIMESTAMP',
                '$time = [DateTimeOffset]::FromUnixTimeSeconds($seconds).UtcDateTime',
                '[System.IO.File]::SetCreationTimeUtc($file, $time)',
                '[System.IO.File]::SetLastWriteTimeUtc($file, $time)',
            ].join('; ');

            await new Promise<void>((resolve, reject) => {
                execFile('powershell.exe', [
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    script,
                ], {
                    windowsHide: true,
                    env: {
                        ...process.env,
                        NXAPI_ALBUM_SYNC_FILE: filename,
                        NXAPI_ALBUM_SYNC_TIMESTAMP: String(seconds),
                    },
                }, error => error ? reject(error) : resolve());
            });
            return;
        }

        const stat = await fs.stat(filename);
        await fs.utimes(filename, stat.atime, date);
    } catch {
        // Timestamp preservation is best-effort.
    }
}

async function writeMediaAtomically(destination: string, body: Uint8Array, signal?: AbortSignal) {
    const temporary = destination + '.part';
    await fs.rm(temporary, {force: true});

    try {
        await fs.writeFile(temporary, body);
        signal?.throwIfAborted();
        await fs.rename(temporary, destination);
    } catch (err) {
        await fs.rm(temporary, {force: true}).catch(() => {});
        throw err;
    }
}

export async function defaultAlbumFolder(locations: AlbumFolderLocations = {}) {
    const home = os.homedir() || '.';
    const pictures = locations.picturesDirectory ?? path.join(home, 'Pictures');
    const videos = locations.videosDirectory ??
        (process.platform === 'darwin' ? path.join(home, 'Movies') : path.join(home, 'Videos'));
    const movies = locations.moviesDirectory ??
        (process.platform === 'darwin' ? path.join(home, 'Movies') : videos);

    const videoBase = process.platform === 'darwin' ? movies : videos;
    const candidates = [
        path.join(videoBase, 'Nintendo Switch 2', 'Album'),
        path.join(videoBase, 'Nintendo Switch', 'Album'),
        path.join(videoBase, 'Nintendo Switch 2'),
        path.join(videoBase, 'Nintendo Switch'),
        path.join(pictures, 'Nintendo Switch 2', 'Album'),
        path.join(pictures, 'Nintendo Switch', 'Album'),
        path.join(pictures, 'Nintendo Switch 2'),
        path.join(pictures, 'Nintendo Switch'),
    ];

    for (const candidate of candidates) {
        if (await pathExists(candidate)) return candidate;
    }

    return path.join(pictures, 'Nintendo Switch');
}

export async function syncAlbum(
    nso: CoralApiInterface,
    options: AlbumSyncOptions = {},
): Promise<AlbumSyncResult> {
    options.signal?.throwIfAborted();

    const {media} = await nso.getMedia();
    options.signal?.throwIfAborted();

    const root = options.destination ?? await defaultAlbumFolder(options.locations);
    await fs.mkdir(root, {recursive: true});

    const existing = await indexExistingAlbum(root, options.signal);
    const titleFolders = learnTitleFolders(media, existing);

    let downloaded = 0;

    for (const item of media) {
        options.signal?.throwIfAborted();

        const timestamp = mediaTimestamp(item);
        const prefix = captureTimestampPrefix(timestamp);
        const extension = item.type === MediaType.VIDEO ? 'mp4' : 'jpg';
        const filename = mediaFilename(item);

        if (existing.filenamesAndPrefixes.has(lower(filename))) {
            continue;
        }

        validateMediaItemForDownload(item);

        const applicationId = lower(item.applicationId);
        let gameFolder = applicationId ? titleFolders.get(applicationId) : undefined;
        if (!gameFolder) {
            gameFolder = await resolveAlbumGameFolder(root, item.appName);
            if (applicationId) titleFolders.set(applicationId, gameFolder);
        }

        const destination = path.join(root, gameFolder, filename);
        await fs.mkdir(path.dirname(destination), {recursive: true});

        await options.onDownload?.(item, destination);
        const body = await downloadMedia(item, options.signal);
        // Older names lack an identity. Verify their bytes instead of treating
        // every capture from the same second as the same file.
        let legacyMatch = false;
        for (const candidate of existing.legacyFiles.get(lower(prefix + '.' + extension)) ?? []) {
            options.signal?.throwIfAborted();
            const stat = await fs.stat(candidate).catch(() => null);
            if (stat?.size !== body.length) continue;
            const previous = await fs.readFile(candidate).catch(() => null);
            if (previous?.equals(body)) { legacyMatch = true; break; }
        }
        if (legacyMatch) {
            existing.filenamesAndPrefixes.add(lower(filename));
            continue;
        }
        await writeMediaAtomically(destination, body, options.signal);
        await preserveCaptureTimestamp(destination, timestamp);

        existing.filenamesAndPrefixes.add(lower(filename));
        existing.filenamesAndPrefixes.add(lower(prefix));
        downloaded++;
    }

    return {
        totalFound: media.length,
        newDownloads: downloaded,
    };
}

export async function fetchLatestCapture(
    nso: CoralApiInterface,
    options: LatestCaptureOptions,
) {
    options.signal?.throwIfAborted();

    const {media} = await nso.getMedia();
    if (!media.length) throw new Error('No captures are currently available from Nintendo');

    const latest = media.reduce((left, right) =>
        mediaTimestamp(right) > mediaTimestamp(left) ? right : left);

    validateMediaItemForDownload(latest);

    const isVideo = latest.type === MediaType.VIDEO;
    const directory = options.destinationDirectory ?? options.cacheDirectory;
    if (!directory) throw new Error('Latest capture destination directory is required');

    await fs.mkdir(directory, {recursive: true});
    const destination = path.join(directory, options.destinationDirectory ?
        mediaFilename(latest) : (isVideo ? 'video.mp4' : 'image.jpg'));

    // User-facing downloads use the same stable capture name as a full sync.
    // Existing files are left intact, matching nxapi's other dump commands.
    if (options.destinationDirectory && await pathExists(destination)) return destination;

    await options.onDownloadStarted?.(isVideo ? 'video' : 'image');

    const body = await downloadMedia(latest, options.signal);
    await writeMediaAtomically(destination, body, options.signal);

    await preserveCaptureTimestamp(destination, mediaTimestamp(latest));
    return destination;
}
