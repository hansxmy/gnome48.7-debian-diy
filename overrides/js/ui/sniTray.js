/**
 * SNI Tray — manages StatusNotifierItem tray icons in the panel.
 *
 * Creates a StatusNotifierWatcher D-Bus service and spawns a
 * PanelMenu.Button for each registered tray application.
 * Icons are placed right-aligned in the panel.
 */
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from './main.js';
import * as PanelMenu from './panelMenu.js';

import {StatusNotifierWatcher} from './sniWatcher.js';
import {SniItem} from './sniItem.js';
import {SniMenuClient} from './sniMenu.js';

const SniTrayIcon = GObject.registerClass({
    GTypeName: 'SniTrayIcon',
}, class SniTrayIcon extends PanelMenu.Button {
    _init(busName, objPath) {
        super._init(0.0, 'SniTrayIcon');
        this._destroyed = false;
        this._menuClient = null;

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'application-x-executable-symbolic',
        });
        this.add_child(this._icon);

        this._item = new SniItem(busName, objPath, {
            onReady: () => this._onItemReady(),
            onIconChanged: () => this._updateIcon(),
            onStatusChanged: () => this._updateVisibility(),
            onMenuChanged: () => this._onMenuChanged(),
        });
    }

    destroy() {
        this._destroyed = true;
        this._item?.destroy();
        this._menuClient?.destroy();
        super.destroy();
    }

    _onItemReady() {
        if (this._destroyed) return;
        this._updateIcon();
        this._updateVisibility();

        this._menuClient = new SniMenuClient(
            this._item.busName,
            this._item.menuPath,
            this.menu
        );
    }

    _updateIcon() {
        if (this._destroyed || !this._item) return;
        const gicon = this._item.getIcon();
        if (gicon) {
            this._icon.gicon = gicon;
            this._icon.icon_name = null;
        } else {
            this._icon.gicon = null;
            this._icon.icon_name = 'application-x-executable-symbolic';
        }
    }

    _updateVisibility() {
        if (this._destroyed || !this._item) return;
        this.visible = this._item.status !== 'Passive';
    }

    _onMenuChanged() {
        if (this._destroyed || !this._item) return;
        if (this._menuClient)
            this._menuClient.updatePath(this._item.menuPath);
        else
            this._menuClient = new SniMenuClient(
                this._item.busName, this._item.menuPath, this.menu);
    }
});

export class SniTray {
    #watcher = null;
    #icons = new Map();   // serviceId → SniTrayIcon
    #nextId = 1;

    constructor() {
        this.#watcher = new StatusNotifierWatcher({
            onRegistered: (id, bus, path) => this.#addIcon(id, bus, path),
            onUnregistered: id => this.#removeIcon(id),
        });
    }

    destroy() {
        this.#watcher?.destroy();
        for (const icon of this.#icons.values())
            icon.destroy();
        this.#icons.clear();
    }

    #addIcon(serviceId, busName, objPath) {
        if (this.#icons.has(serviceId))
            return;

        const icon = new SniTrayIcon(busName, objPath);
        this.#icons.set(serviceId, icon);

        const role = `sni-${this.#nextId++}`;
        try {
            Main.panel.addToStatusArea(role, icon, 0, 'right');
        } catch (e) {
            console.error('SniTray: failed to add icon to panel', e);
            icon.destroy();
            this.#icons.delete(serviceId);
        }
    }

    #removeIcon(serviceId) {
        const icon = this.#icons.get(serviceId);
        if (!icon)
            return;
        icon.destroy();
        this.#icons.delete(serviceId);
    }
}
