/**
 * SNI Tray — manages StatusNotifierItem tray icons in the panel.
 *
 * Creates a StatusNotifierWatcher D-Bus service and spawns a
 * PanelMenu.Button for each registered tray application.
 * Icons are placed right-aligned in the panel.
 */
import Clutter from 'gi://Clutter';
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

    /**
     * Override PanelMenu.Button's default click handler.
     *
     * Always toggle the dbusmenu on any click (left, right, middle) and
     * touch events.  On touchscreen-only devices like Surface GO1, touch
     * maps to left click — the previous logic that called Activate() on
     * left click made it impossible for touch users to reach the menu.
     * Unifying all input to menu-toggle gives a consistent experience.
     */
    vfunc_event(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        if (this.menu)
            this.menu.toggle();
        return Clutter.EVENT_STOP;
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
    #destroyed = false;

    constructor() {
        try {
            this.#watcher = new StatusNotifierWatcher({
                onRegistered: (id, bus, path) => this.#addIcon(id, bus, path),
                onUnregistered: id => this.#removeIcon(id),
            });
        } catch (e) {
            console.error('SniTray: watcher initialization failed', e);
            this.#watcher = null;
        }
    }

    destroy() {
        this.#destroyed = true;
        this.#watcher?.destroy();
        for (const icon of this.#icons.values())
            icon.destroy();
        this.#icons.clear();
    }

    #addIcon(serviceId, busName, objPath) {
        if (this.#destroyed || this.#icons.has(serviceId))
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
