import * as os from 'node:os';
import * as path from 'node:path';
import Table from '../../util/table.js';
import type { Arguments as ParentArguments } from './index.js';
import createDebug from '../../util/debug.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../../util/yargs.js';
import { initStorage } from '../../util/storage.js';
import { getToken, Login } from '../../common/auth/coral.js';
import { fetchLatestCapture, syncAlbum } from '../../common/album-sync.js';

const debug = createDebug('cli:nso:album');

export const command = 'album [action] [directory]';
export const desc = 'List or sync Nintendo Switch 2 album';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.positional('action', {
        describe: 'Album action to perform',
        choices: ['sync', 'latest'],
        type: 'string',
    }).positional('directory', {
        describe: 'Directory to write captures to',
        type: 'string',
    }).option('user', {
        describe: 'Nintendo Account ID',
        type: 'string',
    }).option('token', {
        describe: 'Nintendo Account session token',
        type: 'string',
    }).option('json', {
        describe: 'Output raw JSON',
        type: 'boolean',
    }).option('json-pretty-print', {
        describe: 'Output pretty-printed JSON',
        type: 'boolean',
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const storage = await initStorage(argv.dataPath);

    const usernsid = argv.user ?? await storage.getItem('SelectedUser');
    const token: string = argv.token ||
        await storage.getItem('NintendoAccountToken.' + usernsid);
    const { nso, data } = await getToken(storage, token, argv.zncProxyUrl);

    if (argv.action === 'sync') {
        const result = await syncAlbum(nso, {
            destination: argv.directory,
            onDownload: media => {
                console.warn('Downloading ' + media.appName + ' ' + media.type + ' captured ' +
                    new Date((media.capturedAt || media.uploadedAt) * 1000).toISOString());
            },
        });

        console.log('Found ' + result.totalFound + ' captures; downloaded ' +
            result.newDownloads + ' new ' + (result.newDownloads === 1 ? 'capture' : 'captures') + '.');
        return;
    }

    if (argv.action === 'latest') {
        const filename = await fetchLatestCapture(nso, {
            destinationDirectory: argv.directory ?? path.join(os.homedir(), 'Downloads'),
        });
        console.log(filename);
        return;
    }

    console.warn('Listing album items');

    const [media, [friends, chats, webservices, activeevent, announcements, current_user]] = await Promise.all([
        nso.getMedia(),

        data[Login] || true ? Promise.all([
            nso.getFriendList(),
            nso.getChats(),
            nso.getWebServices(),
            nso.getActiveEvent(),
            nso.getAnnouncements(),
            nso.getCurrentUser(),
        ]) : [],
    ]);

    if (argv.jsonPrettyPrint) {
        console.log(JSON.stringify(media, null, 4));
        return;
    }

    if (argv.json) {
        console.log(JSON.stringify(media));
        return;
    }

    const table = new Table({
        head: [
            'ID',
            'Type',
            'Title ID',
            'Title',
            'Captured at',
            'Uploaded at',
        ],
    });

    for (const item of media.media) {
        table.push([
            item.id,
            item.type,
            item.applicationId,
            item.appName,
            new Date(item.capturedAt * 1000).toISOString(),
            new Date(item.uploadedAt * 1000).toISOString(),
        ]);
    }

    console.log(table.toString());
}
