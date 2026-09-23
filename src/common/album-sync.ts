import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { request, type Dispatcher } from 'undici';
import type { CoralApiInterface } from '../api/coral.js';
import type { Media } from '../api/coral-types.js';
import { GAME_ALIAS_GROUPS } from './album-sync-aliases.js';

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
    cacheDirectory: string;
    signal?: AbortSignal;
    onDownloadStarted?: (type: 'image' | 'video') => void | Promise<void>;
}

interface ExistingAlbumIndex {
    filenamesAndPrefixes: Set<string>;
    folderByTimestampPrefix: Map<string, string>;
}

function lower(value: string) {
    return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function trimAsciiWhitespace(value: string) {
    return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
}

function throwIfCancelled(signal?: AbortSignal) {
    if (!signal?.aborted) return;

    if (signal.reason instanceof Error) throw signal.reason;
    throw new Error('Sync cancelled');
}

function isUnicodeDashOrHyphen(codePoint: number) {
    return codePoint === 0x2010 ||
        codePoint === 0x2011 ||
        codePoint === 0x2012 ||
        codePoint === 0x2013 ||
        codePoint === 0x2014 ||
        codePoint === 0x2015 ||
        codePoint === 0x2212 ||
        codePoint === 0xfe58 ||
        codePoint === 0xfe63 ||
        codePoint === 0xff0d;
}

const LATIN_FOLD = new Map<number, string>([
    ...[0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5,
        0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5].map(cp => [cp, 'a'] as const),
    [0x00c7, 'c'] as const, [0x00e7, 'c'] as const,
    ...[0x00c8, 0x00c9, 0x00ca, 0x00cb,
        0x00e8, 0x00e9, 0x00ea, 0x00eb].map(cp => [cp, 'e'] as const),
    ...[0x00cc, 0x00cd, 0x00ce, 0x00cf,
        0x00ec, 0x00ed, 0x00ee, 0x00ef].map(cp => [cp, 'i'] as const),
    [0x00d1, 'n'] as const, [0x00f1, 'n'] as const,
    ...[0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d8,
        0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f8].map(cp => [cp, 'o'] as const),
    ...[0x00d9, 0x00da, 0x00db, 0x00dc,
        0x00f9, 0x00fa, 0x00fb, 0x00fc].map(cp => [cp, 'u'] as const),
    ...[0x00dd, 0x0178, 0x00fd, 0x00ff].map(cp => [cp, 'y'] as const),
]);

export function normalizeAlbumTitleV1(value: string) {
    let normalized = '';

    for (const character of value) {
        const codePoint = character.codePointAt(0)!;

        if (codePoint >= 0x0300 && codePoint <= 0x036f) continue;

        if (codePoint < 0x80) {
            if ((codePoint >= 0x30 && codePoint <= 0x39) ||
                (codePoint >= 0x41 && codePoint <= 0x5a) ||
                (codePoint >= 0x61 && codePoint <= 0x7a)) {
                normalized += character.toLowerCase();
            }
            continue;
        }

        const folded = LATIN_FOLD.get(codePoint);
        normalized += folded ?? character;
    }

    return normalized;
}

export function sanitizeAlbumFolderV1(value: string) {
    if (!trimAsciiWhitespace(value)) return 'Other';

    let clean = '';

    for (const character of value) {
        const codePoint = character.codePointAt(0)!;

        if (codePoint < 0x20) continue;

        if (isUnicodeDashOrHyphen(codePoint)) {
            clean += '-';
            continue;
        }

        if (character === '<' || character === '>' || character === ':' ||
            character === '"' || character === '/' || character === '\\' ||
            character === '|' || character === '?' || character === '*' ||
            codePoint === 0xff1c || codePoint === 0xff1e || codePoint === 0xff1a ||
            codePoint === 0xff02 || codePoint === 0xff0f || codePoint === 0xff3c ||
            codePoint === 0xff5c || codePoint === 0xff1f || codePoint === 0xff0a) {
            continue;
        }

        clean += character;
    }

    let result = '';
    let lastWasSpace = false;
    for (const character of clean) {
        if (character === ' ') {
            if (!lastWasSpace && result) {
                result += ' ';
                lastWasSpace = true;
            }
        } else {
            result += character;
            lastWasSpace = false;
        }
    }

    while (result.endsWith(' ') || result.endsWith('.')) {
        result = result.slice(0, -1);
    }

    result = trimAsciiWhitespace(result);
    return result || 'Other';
}

// Keep legacy API compatibility local to Album Sync rather than changing Coral.
export function normalizeAlbumMedia(media: unknown): Media[] {
    if (!Array.isArray(media)) return [];
    return media.map(item => ({
        ...item,
        applicationId: typeof item.titleId === 'string' ? item.titleId :
            typeof item.applicationId === 'string' ? item.applicationId : '',
        appName: typeof item.appName === 'string' ? item.appName : 'Nintendo Switch',
        type: typeof item.type === 'string' ? item.type : 'image',
        capturedAt: Number.isInteger(item.capturedAt) ? item.capturedAt : 0,
        uploadedAt: Number.isInteger(item.uploadedAt) ? item.uploadedAt : 0,
        contentUri: typeof item.contentUri === 'string' ? item.contentUri : '',
        contentLength: Number.isInteger(item.contentLength) ? item.contentLength : 0,
    }));
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

function prefixFromExistingFilename(filename: string) {
    let prefix = path.parse(filename).name;
    if (prefix.length > 2 && prefix.endsWith('_c')) {
        prefix = prefix.slice(0, -2);
    } else if (prefix.length > 3 && prefix.endsWith('-00')) {
        prefix = prefix.slice(0, -3);
    }
    return prefix;
}

async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
    throwIfCancelled(signal);

    let directory;
    try {
        directory = await fs.opendir(root);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return;
        throw err;
    }

    for await (const entry of directory) {
        throwIfCancelled(signal);
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
        index.filenamesAndPrefixes.add(basenameLower);
        index.filenamesAndPrefixes.add(lower(prefix));

        if (!index.folderByTimestampPrefix.has(lower(prefix))) {
            index.folderByTimestampPrefix.set(lower(prefix), path.basename(path.dirname(filename)));
        }
    }

    return index;
}

function learnTitleFolders(media: readonly Media[], existing: ExistingAlbumIndex) {
    const folders = new Map<string, string>();

    for (const item of media) {
        if (!item.applicationId) continue;

        const prefix = captureTimestampPrefix(mediaTimestamp(item));
        const existingFolder = existing.folderByTimestampPrefix.get(lower(prefix));
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
    if (!trimAsciiWhitespace(appName) || !(await pathExists(albumDirectory))) return defaultClean;

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
        let synonyms: readonly string[] = [appName];

        for (const group of GAME_ALIAS_GROUPS) {
            if (group.some(alias => normalizeAlbumTitleV1(alias) === normalizedAppName)) {
                synonyms = group;
                break;
            }
        }

        for (const synonym of synonyms) {
            const cleanSynonym = sanitizeAlbumFolderV1(synonym);
            const normalizedSynonym = normalizeAlbumTitleV1(synonym);

            const exact = directories.find(directory => lower(directory.original) === lower(cleanSynonym));
            if (exact) return exact.original;

            const normalized = directories.find(directory => directory.normalized === normalizedSynonym);
            if (normalized) return normalized.original;
        }

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

    if (item.contentLength <= 0 || item.contentLength > MAX_MEDIA_DOWNLOAD_BYTES) {
        throw new Error('Nintendo media download size is missing or exceeds the 256 MiB safety limit');
    }
}

async function requestMedia(item: Media, signal?: AbortSignal): Promise<Dispatcher.ResponseData> {
    validateMediaItemForDownload(item);

    let currentUrl = item.contentUri;

    for (let redirects = 0; redirects <= 5; redirects++) {
        throwIfCancelled(signal);

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

        const body = Buffer.from(await response.body.arrayBuffer());
        throwIfCancelled(signal);

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
        throwIfCancelled(signal);
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
    throwIfCancelled(options.signal);

    const response = await nso.getMedia();
    const media = normalizeAlbumMedia(response.media);
    throwIfCancelled(options.signal);

    const root = options.destination ?? await defaultAlbumFolder(options.locations);
    await fs.mkdir(root, {recursive: true});

    const existing = await indexExistingAlbum(root, options.signal);
    const titleFolders = learnTitleFolders(media, existing);

    let downloaded = 0;

    for (const item of media) {
        throwIfCancelled(options.signal);

        const timestamp = mediaTimestamp(item);
        const prefix = captureTimestampPrefix(timestamp);
        const extension = lower(item.type) === 'video' ? 'mp4' : 'jpg';
        const filename = prefix + '_c.' + extension;

        if (existing.filenamesAndPrefixes.has(lower(filename)) ||
            existing.filenamesAndPrefixes.has(lower(prefix))) {
            continue;
        }

        validateMediaItemForDownload(item);

        const knownFolder = titleFolders.get(lower(item.applicationId));
        const gameFolder = knownFolder ??
            await resolveAlbumGameFolder(root, item.appName);

        const destination = path.join(root, gameFolder, filename);
        await fs.mkdir(path.dirname(destination), {recursive: true});

        await options.onDownload?.(item, destination);
        const body = await downloadMedia(item, options.signal);
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
    throwIfCancelled(options.signal);

    const response = await nso.getMedia();
    const media = normalizeAlbumMedia(response.media);
    if (!media.length) throw new Error('No captures are currently available from Nintendo');

    const latest = media.reduce((left, right) =>
        mediaTimestamp(right) > mediaTimestamp(left) ? right : left);

    validateMediaItemForDownload(latest);

    const isVideo = lower(latest.type) === 'video';
    await options.onDownloadStarted?.(isVideo ? 'video' : 'image');

    const extension = isVideo ? 'mp4' : 'jpg';
    await fs.mkdir(options.cacheDirectory, {recursive: true});

    const destination = path.join(options.cacheDirectory, (isVideo ? 'video.' : 'image.') + extension);
    const temporary = destination + '.part';
    const body = await downloadMedia(latest, options.signal);

    await fs.rm(temporary, {force: true});
    try {
        await fs.writeFile(temporary, body);
        await fs.rm(destination, {force: true});
        await fs.rename(temporary, destination);
    } catch (err) {
        await fs.rm(temporary, {force: true}).catch(() => {});
        throw err;
    }

    await preserveCaptureTimestamp(destination, mediaTimestamp(latest));
    return destination;
}
