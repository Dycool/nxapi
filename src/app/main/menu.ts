import { app, Menu, Tray, nativeImage, MenuItem, BrowserWindow, KeyboardEvent } from 'electron';
import path from 'node:path';
import { askAddNsoAccount, askAddPctlAccount } from './na-auth.js';
import { App } from './index.js';
import openWebService, { handleOpenWebServiceError, WebServiceValidationError } from './webservices.js';
import { EmbeddedPresenceMonitor, EmbeddedProxyPresenceMonitor } from './monitor.js';
import { createModalWindow } from './windows.js';
import { WindowType } from '../common/types.js';
import { CoralApiInterface } from '../../api/coral.js';
import { WebService } from '../../api/coral-types.js';
import { SavedToken } from '../../common/auth/coral.js';
import { SavedMoonToken } from '../../common/auth/moon.js';
import { CachedWebServicesList } from '../../common/users.js';
import createDebug from '../../util/debug.js';
import { dev, dir, git } from '../../util/product.js';
import { MembershipRequiredError } from '../../common/auth/util.js';
import { languages } from '../i18n/index.js';

const debug = createDebug('app:main:menu');

const show_force_language_menu = dev || git?.branch?.match(/^(i18n$|trans-)/);

export default class MenuApp {
    tray: Tray;

    constructor(readonly app: App) {
        const icon = nativeImage
            .createFromPath(path.join(dir, 'resources', 'app', 'menu-icon.png'))
            .resize({height: 16});

        icon.setTemplateImage(true);

        this.tray = new Tray(icon);
        this.tray.setToolTip('nxapi');

        app.store.on('update-nintendo-accounts', () => this.updateMenu());
        app.store.on('update-album-sync', () => this.updateMenu());
        app.store.on('update-cached-web-services', (language: string, cache: CachedWebServicesList) => {
            this.webservices.set(language, cache.webservices);
            this.updateMenu();
        });
        this.updateMenu();

        app.i18n.on('languageChanged', language => this.updateMenu());
    }

    async updateMenu() {
        await this.app.i18n.loadNamespaces('menu_app');
        const t = this.app.i18n.getFixedT(null, 'menu_app');

        const menu = new Menu();

        const ids = await this.app.store.storage.getItem('NintendoAccountIds') as string[] | undefined;
        const album_settings = await this.app.albumSync.getSettings();
        const album_status = this.app.albumSync.status;
        const album_account_signed_in = !!album_settings.user_id &&
            !!ids?.includes(album_settings.user_id) &&
            !!await this.app.store.storage.getItem('NintendoAccountToken.' + album_settings.user_id);
        menu.append(new MenuItem({label: t('coral_heading')!, enabled: false}));

        const discord_presence_monitor = this.getActiveDiscordPresenceMonitor();

        for (const id of ids ?? []) {
            const token = await this.app.store.storage.getItem('NintendoAccountToken.' + id) as string | undefined;
            if (!token) continue;
            const data = await this.app.store.storage.getItem('NsoToken.' + token) as SavedToken | undefined;
            if (!data) continue;

            const monitor = this.app.monitors.monitors.find(m => m instanceof EmbeddedPresenceMonitor &&
                m.user.data.user.id === data.user.id);
            const discord_presence_active = discord_presence_monitor &&
                discord_presence_monitor instanceof EmbeddedPresenceMonitor &&
                discord_presence_monitor.user.data.user.id === data.user.id;

            const webservices = await this.getWebServiceItems(data.user.language, token);

            const item = new MenuItem({
                label: data.nsoAccount.user.name,
                submenu: [
                    {label: t('na_id', {id: data.user.id})!, enabled: false},
                    {label: t('coral_id', {id: data.nsoAccount.user.id})!, enabled: false},
                    {label: t('nsa_id', {id: data.nsoAccount.user.nsaId})!, enabled: false},
                    {type: 'separator'},
                    {label: t('discord_presence_enable')!, type: 'checkbox', checked: discord_presence_active,
                        enabled: discord_presence_active,
                        click: () => this.setActiveDiscordPresenceUser(discord_presence_active ? null : data.user.id)},
                    {label: t('user_notifications_enable')!, type: 'checkbox',
                        checked: monitor?.user_notifications,
                        enabled: !!monitor?.user_notifications,
                        click: () => this.setUserNotificationsActive(data.user.id, !monitor?.user_notifications)},
                    {label: t('friend_notifications_enable')!, type: 'checkbox',
                        checked: monitor?.friend_notifications,
                        click: () => this.setFriendNotificationsActive(data.user.id, !monitor?.friend_notifications)},
                    {label: t('refresh')!, enabled: !!monitor, click: () => monitor?.skipIntervalInCurrentLoop(true)},
                    {type: 'separator'},
                    {label: t('add_friend')!, click: () => this.showAddFriendWindow(data.user.id)},
                    ...(webservices.length ? [
                        {type: 'separator'},
                        {label: t('web_services')!, enabled: false},
                        ...webservices as any,
                    ] : []),
                ],
            });

            menu.append(item);
        }

        menu.append(new MenuItem({label: t('add_account')!, click: this.addNsoAccount}));
        menu.append(new MenuItem({type: 'separator'}));
        menu.append(new MenuItem({label: t('moon_heading')!, enabled: false}));

        for (const id of ids ?? []) {
            const token = await this.app.store.storage.getItem('NintendoAccountToken-pctl.' + id) as string | undefined;
            if (!token) continue;
            const data = await this.app.store.storage.getItem('MoonToken.' + token) as SavedMoonToken | undefined;
            if (!data) continue;

            const item = new MenuItem({
                label: data.user.nickname,
                submenu: [
                    {label: t('na_id', {id: data.user.id})!, enabled: false},
                ],
            });

            menu.append(item);
        }

        menu.append(new MenuItem({label: t('add_account')!, click: this.addPctlAccount}));

        if (album_settings.feature_enabled) {
            menu.append(new MenuItem({type: 'separator'}));
            menu.append(new MenuItem({
                label: t('album_sync.heading')!,
                submenu: [
                    ...(album_status.status && album_status.status !== 'Ready' ? [
                        {label: album_status.status, enabled: false},
                    ] : []),
                    {label: t('album_sync.last_sync', {last_sync: album_status.last_sync})!, enabled: false},
                    {type: 'separator'},
                    {
                        label: t('album_sync.sync_now')!,
                        enabled: album_account_signed_in && !album_status.busy,
                        click: () => void this.app.albumSync.syncNow(false)
                            .catch(err => debug('Album sync failed', err)),
                    },
                    {
                        label: album_settings.interval_minutes === 60 ?
                            t('album_sync.auto_sync_hourly')! :
                            t('album_sync.auto_sync_minutes', {count: album_settings.interval_minutes})!,
                        type: 'checkbox',
                        checked: album_settings.enabled,
                        enabled: album_account_signed_in,
                        click: () => void this.app.albumSync.toggleEnabled()
                            .catch(err => debug('Updating album sync failed', err)),
                    },
                    {
                        label: t('album_sync.copy_last_capture')!,
                        enabled: album_account_signed_in && !album_status.copying,
                        click: () => void this.app.albumSync.copyLatestCapture()
                            .catch(err => debug('Copy latest capture failed', err)),
                    },
                    {
                        label: t('album_sync.notifications')!,
                        type: 'checkbox',
                        checked: album_settings.notifications,
                        click: () => void this.app.albumSync.toggleNotifications()
                            .catch(err => debug('Updating album notifications failed', err)),
                    },
                    {type: 'separator'},
                    {
                        label: t('album_sync.choose_folder')!,
                        click: () => void this.app.albumSync.chooseDestination()
                            .catch(err => debug('Choosing album folder failed', err)),
                    },
                    {
                        label: t('album_sync.open_folder')!,
                        click: () => void this.app.albumSync.openDestination()
                            .catch(err => debug('Opening album folder failed', err)),
                    },
                ],
            }));


        }

        menu.append(new MenuItem({type: 'separator'}));
        menu.append(new MenuItem({label: t('show_main_window')!, click: () => this.app.showMainWindow()}));
        menu.append(new MenuItem({label: t('preferences')!, click: () => this.app.showPreferencesWindow()}));
        if (show_force_language_menu) menu.append(new MenuItem({label: 'Language', submenu: Menu.buildFromTemplate([
            ...this.app.i18n.options.supportedLngs || ['cimode'],
        ].map(l => new MenuItem({
            label: languages[l as keyof typeof languages]?.name ?? l,
            type: 'checkbox',
            checked: (this.app.i18n.resolvedLanguage ?? this.app.i18n.language).toLowerCase() === l.toLowerCase(),
            click: () => this.app.i18n.changeLanguage(l),
        })))}));
        if (dev) menu.append(new MenuItem({label: 'Dump notifications state', click: () => {
            debug('Accounts', this.app.monitors.notifications.accounts);
            debug('Friends', this.app.monitors.notifications.onlinefriends);
        }}));
        menu.append(new MenuItem({label: t('quit')!, click: () => app.quit()}));

        this.tray.setContextMenu(menu);
    }

    addNsoAccount = (item: MenuItem, window: BrowserWindow | undefined, event: KeyboardEvent) =>
        askAddNsoAccount(this.app, !event.shiftKey);
    addPctlAccount = (item: MenuItem, window: BrowserWindow | undefined, event: KeyboardEvent) =>
        askAddPctlAccount(this.app, !event.shiftKey);

    protected webservices = new Map</** language */ string, WebService[]>();

    async getWebServices(language: string) {
        const cache = this.webservices.get(language);
        if (cache) return cache;

        const webservices: CachedWebServicesList | undefined =
            await this.app.store.storage.getItem('CachedWebServicesList.' + language);

        if (webservices) this.webservices.set(language, webservices.webservices);
        return webservices?.webservices ?? [];
    }

    async getWebServiceItems(language: string, token: string) {
        const webservices = await this.getWebServices(language);
        const items = [];

        for (const webservice of webservices) {
            items.push(new MenuItem({
                label: webservice.name,
                click: async () => {
                    try {
                        const {nso, data} = await this.app.store.users.get(token);

                        await this.openWebService(token, nso, data, webservice);
                    } catch (err) {
                        handleOpenWebServiceError(err, webservice);
                    }
                },
            }));
        }

        return items;
    }

    async openWebService(token: string, coral: CoralApiInterface, data: SavedToken, webservice: WebService) {
        try {
            await openWebService(this.app.store, token, coral, data, webservice);
        } catch (err) {
            if (!(err instanceof WebServiceValidationError) && !(err instanceof MembershipRequiredError)) return;

            handleOpenWebServiceError(err, webservice, undefined, data);
        }
    }

    getActiveDiscordPresenceMonitor() {
        for (const monitor of this.app.monitors.monitors) {
            if (!monitor.presence_enabled) continue;

            return monitor;
        }

        return null;
    }

    async setActiveDiscordPresenceUser(id: string | null) {
        const monitor = this.getActiveDiscordPresenceMonitor();

        if (monitor) {
            if (monitor instanceof EmbeddedPresenceMonitor && monitor.user.data.user.id === id) return;

            monitor.discord.updatePresenceForDiscord(null);

            if (monitor instanceof EmbeddedPresenceMonitor) {
                monitor.presence_user = null;

                if (!monitor.user_notifications && !monitor.friend_notifications) {
                    this.app.monitors.stop(monitor.user.data.user.id);
                }
            }

            if (monitor instanceof EmbeddedProxyPresenceMonitor) {
                this.app.monitors.stop(monitor.presence_url);
            }
        }

        if (id) await this.app.monitors.start(id, monitor => {
            monitor.presence_user = monitor.user.data.nsoAccount.user.nsaId;
            monitor.skipIntervalInCurrentLoop();
        });

        if (monitor || id) this.saveMonitorStateAndUpdateMenu();
    }

    async setUserNotificationsActive(id: string, active: boolean) {
        const monitor = this.app.monitors.monitors.find(m => m instanceof EmbeddedPresenceMonitor &&
            m.user.data.user.id === id);

        if (monitor?.user_notifications && !active) {
            monitor.user_notifications = false;

            if (!monitor.presence_user && !monitor.friend_notifications) {
                this.app.monitors.stop(monitor.user.data.user.id);
            }

            monitor.skipIntervalInCurrentLoop();
            this.saveMonitorStateAndUpdateMenu();
        }

        if (!monitor?.user_notifications && active) await this.app.monitors.start(id, monitor => {
            monitor.user_notifications = true;
            monitor.skipIntervalInCurrentLoop();
            this.saveMonitorStateAndUpdateMenu();
        });
    }

    async setFriendNotificationsActive(id: string, active: boolean) {
        const monitor = this.app.monitors.monitors.find(m => m instanceof EmbeddedPresenceMonitor &&
            m.user.data.user.id === id);

        if (monitor?.friend_notifications && !active) {
            monitor.friend_notifications = false;

            if (!monitor.presence_user && !monitor.user_notifications) {
                this.app.monitors.stop(monitor.user.data.user.id);
            }

            monitor.skipIntervalInCurrentLoop();
            this.saveMonitorStateAndUpdateMenu();
        }

        if (!monitor?.friend_notifications && active) await this.app.monitors.start(id, monitor => {
            monitor.friend_notifications = true;
            monitor.skipIntervalInCurrentLoop();
            this.saveMonitorStateAndUpdateMenu();
        });
    }

    async saveMonitorState() {
        try {
            await this.app.store.saveMonitorState(this.app.monitors);
        } catch (err) {
            debug('Error saving monitor state', err);
        }
    }

    saveMonitorStateAndUpdateMenu() {
        this.saveMonitorState();
        this.updateMenu();
    }

    showAddFriendWindow(user: string) {
        createModalWindow(WindowType.ADD_FRIEND, {
            user,
        });
    }
}
