/**
 * Clipboard Indicator — built into GNOME Shell panel.
 *
 * Lightweight clipboard manager with MountLink cross-device sync.
 * Stripped from gnome-shell-extension-clipboard-indicator: no Extension
 * API, no GSettings, no prefs UI, no locale system, no file logger.
 * All configuration is hardcoded for maximum efficiency.
 */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as AnimationUtils from '../misc/animationUtils.js';
import * as Main from './main.js';
import * as PanelMenu from './panelMenu.js';
import * as PopupMenu from './popupMenu.js';

import {ClipboardRegistry, ClipboardEntry} from './clipboardRegistry.js';
import {ClipboardSync} from './clipboardSync.js';
import {ClipboardKeyboard} from './clipboardKeyboard.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
const INDICATOR_ICON = 'edit-paste-symbolic';

// ── Hardcoded settings (no GSettings needed) ──
const MAX_REGISTRY_LENGTH = 20;
const MAX_ENTRY_LENGTH    = 50;
const MAX_CACHE_SIZE      = 20;  // MB
const SYNC_ENABLED        = true;

export const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator',
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #lastReceivedHash = null;
    #pendingRemoteClipboard = null;
    #pendingLocalRefresh = false;

    destroy() {
        this._flushCache();
        this._destroyed = true;
        this.#clearTimeouts();
        this.keyboard?.destroy();
        this.sync?.destroy();
        this._disconnectSelectionListener();
        super.destroy();
    }

    _init() {
        super._init(0.0, 'ClipboardIndicator');
        this._clipboard = St.Clipboard.get_default();
        this.registry = new ClipboardRegistry();
        this.keyboard = new ClipboardKeyboard();
        this.clipItemsRadioGroup = [];
        this._menuReady = false;
        this._destroyed = false;

        // Panel icon
        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        hbox.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon',
        }));
        this.add_child(hbox);

        // Build menu async, then set up listeners and sync.
        this._buildMenu().then(() => {
            if (this._destroyed)
                return;
            this._setupListener();
            this._initSync();
        }).catch(e => {
            console.error('ClipboardIndicator: menu build failed', e);
        });
    }

    // ──────────────────────── Menu Construction ────────────────────────

    async _buildMenu() {
        const clipHistory = await this.registry.read(
            MAX_REGISTRY_LENGTH, MAX_CACHE_SIZE);
        if (this._destroyed)
            return;

        // ── Status bar (MountLink connection) ──
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._statusIcon = new St.Icon({
            icon_name: 'network-offline-symbolic',
            style_class: 'system-status-icon',
            style: 'icon-size: 14px;',
        });
        this._statusLabel = new St.Label({
            text: 'MountLink: 未连接',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.85em;',
        });
        let statusBox = new St.BoxLayout({style: 'spacing: 6px; padding: 2px 0;'});
        statusBox.add_child(this._statusIcon);
        statusBox.add_child(this._statusLabel);
        this._statusItem.add_child(statusBox);
        this.menu.addMenuItem(this._statusItem);

        // ── Separator ──
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── History section (scrollable) ──
        this.historySection = new PopupMenu.PopupMenuSection();
        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            overlay_scrollbars: true,
            style: 'max-height: 350px; max-width: 300px;',
        });
        this.historyScrollView.add_child(this.historySection.actor);
        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);
        this.menu.addMenuItem(this.scrollViewMenuSection);

        // ── Empty state ──
        this.emptyStateSection = new St.BoxLayout({
            vertical: true,
            style: 'width: 350px; color: #aaa;',
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'icon-size: 5em; margin-top: 3em;',
        }));
        this._emptyLabel = new St.Label({
            text: '剪贴板为空',
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 1em 0 3em 0;',
        });
        this.emptyStateSection.add_child(this._emptyLabel);

        // ── Bottom separator ──
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Clear history button ──
        this.clearMenuItem = new PopupMenu.PopupMenuItem('清空历史');
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'width: 1em; height: 1em; margin-right: 0.5em;',
            }), 0
        );
        this.clearMenuItem.connect('activate', () => this._clearHistory());
        this.menu.addMenuItem(this.clearMenuItem);

        // ── Populate cached entries ──
        clipHistory.forEach(entry => this._addEntry(entry));
        if (clipHistory.length > 0)
            this._selectMenuItem(
                this.clipItemsRadioGroup[clipHistory.length - 1]);

        this._updateEmptyState();
        this._menuReady = true;
    }

    _updateEmptyState() {
        const hasItems = this.clipItemsRadioGroup.length > 0;

        if (hasItems) {
            if (this.menu.box.contains(this.emptyStateSection))
                this.menu.box.remove_child(this.emptyStateSection);
            this.historyScrollView.visible = true;
            this.clearMenuItem.visible = true;
        } else {
            this.historyScrollView.visible = false;
            this.clearMenuItem.visible = false;
            if (!this.menu.box.contains(this.emptyStateSection))
                this.menu.box.insert_child_above(
                    this.emptyStateSection,
                    this.scrollViewMenuSection.actor);
        }
    }

    // ──────────────────────── Sync ────────────────────────

    _initSync() {
        this.sync = new ClipboardSync({
            enabled: SYNC_ENABLED,
            onClipboardReceived: (mimetype, bytes) =>
                this._onRemoteClipboard(mimetype, bytes),
            onStateChanged: state => this._updateSyncUI(state),
        });
    }

    _updateSyncUI(state) {
        if (!this._statusLabel || this._destroyed)
            return;

        const map = {
            'connected':    {text: 'MountLink: 已连接',    icon: 'network-transmit-receive-symbolic', color: '#66bb6a'},
            'listening':    {text: 'MountLink: 监听中',     icon: 'network-receive-symbolic',          color: '#ffa726'},
            'connecting':   {text: 'MountLink: 连接中...',  icon: 'network-idle-symbolic',             color: '#ffa726'},
            'disconnected': {text: 'MountLink: 未连接',     icon: 'network-offline-symbolic',          color: '#9e9e9e'},
            'disabled':     {text: 'MountLink: 已禁用',     icon: 'network-offline-symbolic',          color: '#616161'},
            'error':        {text: 'MountLink: 错误',       icon: 'network-error-symbolic',            color: '#9e9e9e'},
            'stopped':      {text: 'MountLink: 已停止',     icon: 'network-offline-symbolic',          color: '#9e9e9e'},
        };

        const s = map[state] || map['disconnected'];
        this._statusLabel.set_text(s.text);
        this._statusLabel.style = `font-size: 0.85em; color: ${s.color};`;
        this._statusIcon.icon_name = s.icon;
    }

    _onRemoteClipboard(mimetype, bytes) {
        if (!this._menuReady || this._destroyed)
            return;
        if (this.#refreshInProgress) {
            // Defer until current refresh completes to avoid race with local read
            this.#pendingRemoteClipboard = {mimetype, bytes};
            return;
        }
        this.#applyRemoteClipboard(mimetype, bytes);
    }

    #applyRemoteClipboard(mimetype, bytes) {
        const entry = new ClipboardEntry(mimetype, bytes);
        this.#lastReceivedHash = entry.getStringValue();

        this._clipboard.set_content(CLIPBOARD_TYPE, mimetype, entry.asBytes());

        // Deduplicate
        for (let item of this.clipItemsRadioGroup) {
            if (item.entry.equals(entry)) {
                this._selectMenuItem(item, false);
                this._clearRemoteHash();
                return;
            }
        }

        this._addEntry(entry, true, false);
        this._removeOldestEntries();
        this._updateCache();
        this._clearRemoteHash();
    }

    _clearRemoteHash() {
        if (this._remoteHashTimeout)
            clearTimeout(this._remoteHashTimeout);
        this._remoteHashTimeout = setTimeout(() => {
            this.#lastReceivedHash = null;
        }, 3000);
    }

    // ──────────────────────── Entry Management ────────────────────────

    _addEntry(entry, autoSelect = false, autoSetClip = false) {
        let menuItem = new PopupMenu.PopupMenuItem('');
        menuItem.entry = entry;

        menuItem.connect('activate', () => {
            this._selectMenuItem(menuItem);
        });

        menuItem.connect('key-focus-in', () => {
            AnimationUtils.ensureActorVisibleInScrollView(
                this.historyScrollView, menuItem);
        });

        menuItem.connect('key-press-event', (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Delete) {
                this.#focusNeighbor(menuItem);
                this._removeEntry(menuItem);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_v) {
                this.#pasteItem(menuItem);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_KP_Enter ||
                sym === Clutter.KEY_Return) {
                this._selectMenuItem(menuItem);
                this.menu.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._setEntryLabel(menuItem);

        // Delete button
        let deleteBtn = new St.Button({
            can_focus: true,
            child: new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'system-status-icon',
                style: 'icon-size: 1.2em; margin-left: 0.25em;',
            }),
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        deleteBtn.connect('clicked', () => this._removeEntry(menuItem));
        menuItem.add_child(deleteBtn);

        this.clipItemsRadioGroup.push(menuItem);
        this.historySection.addMenuItem(menuItem, 0);

        if (autoSelect)
            this._selectMenuItem(menuItem, autoSetClip);
        else
            menuItem.setOrnament(PopupMenu.Ornament.NONE);

        this._updateEmptyState();
    }

    _setEntryLabel(menuItem) {
        const {entry} = menuItem;

        if (entry.isText()) {
            let text = entry.getStringValue().replace(/\s+/g, ' ');
            const chars = [...text];
            if (chars.length > MAX_ENTRY_LENGTH)
                text = chars.slice(0, MAX_ENTRY_LENGTH - 1).join('') + '...';
            menuItem.label.set_text(text);
        } else if (entry.isImage()) {
            menuItem.label.set_text('[图片]');
            this.registry.getEntryAsImage(entry).then(img => {
                if (!img || this._destroyed)
                    return;
                if (!menuItem.get_parent())
                    return;
                img.style =
                    'border: solid 1px white; overflow: hidden; ' +
                    'width: 1.5em; height: 1.5em; margin: 0; padding: 0;';
                if (menuItem.previewImage)
                    menuItem.remove_child(menuItem.previewImage);
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            }).catch(_e => { /* image preview non-critical */ });
        }
    }

    _selectMenuItem(menuItem, autoSet = true) {
        for (let item of this.clipItemsRadioGroup) {
            if (item === menuItem) {
                item.setOrnament(PopupMenu.Ornament.DOT);
                item.currentlySelected = true;
                if (autoSet) {
                    this._clipboard.set_content(
                        CLIPBOARD_TYPE,
                        item.entry.mimetype(),
                        item.entry.asBytes());
                }
            } else {
                item.setOrnament(PopupMenu.Ornament.NONE);
                item.currentlySelected = false;
            }
        }
    }

    _removeEntry(menuItem) {
        let idx = this.clipItemsRadioGroup.indexOf(menuItem);
        if (idx < 0)
            return;

        if (menuItem.currentlySelected)
            this._clipboard.set_text(CLIPBOARD_TYPE, '');

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(idx, 1);

        if (menuItem.entry.isImage())
            this.registry.deleteEntryFile(menuItem.entry);

        this._updateCache();
        this._updateEmptyState();
    }

    _removeOldestEntries() {
        let removed = false;
        while (this.clipItemsRadioGroup.length > MAX_REGISTRY_LENGTH) {
            const item = this.clipItemsRadioGroup[0];
            if (item.currentlySelected)
                this._clipboard.set_text(CLIPBOARD_TYPE, '');
            item.destroy();
            this.clipItemsRadioGroup.splice(0, 1);
            if (item.entry.isImage())
                this.registry.deleteEntryFile(item.entry);
            removed = true;
        }
        if (removed)
            this._updateEmptyState();
    }

    _clearHistory() {
        for (const item of this.clipItemsRadioGroup) {
            if (item.currentlySelected)
                this._clipboard.set_text(CLIPBOARD_TYPE, '');
            if (item.entry.isImage())
                this.registry.deleteEntryFile(item.entry);
            item.destroy();
        }
        this.clipItemsRadioGroup.length = 0;
        this._updateCache();
        this._updateEmptyState();
    }

    _updateCache() {
        if (this._cacheWriteTimeout)
            clearTimeout(this._cacheWriteTimeout);
        this._cacheWriteTimeout = setTimeout(() => this._flushCache(), 300);
    }

    _flushCache() {
        if (this._cacheWriteTimeout) {
            clearTimeout(this._cacheWriteTimeout);
            this._cacheWriteTimeout = null;
        }
        if (!this._menuReady || this._destroyed)
            return;
        const entries = this.clipItemsRadioGroup.map(item => item.entry);
        this.registry.write(entries);
    }

    #focusNeighbor(menuItem) {
        let idx = this.clipItemsRadioGroup.indexOf(menuItem);
        let next = this.clipItemsRadioGroup[idx - 1] ||
                   this.clipItemsRadioGroup[idx + 1];
        if (next)
            next.grab_key_focus();
    }

    // ──────────────────────── Clipboard Listener ────────────────────────

    _setupListener() {
        this.selection = global.display.get_selection();
        this._selectionOwnerChangedId = this.selection.connect(
            'owner-changed',
            (sel, type, _source) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._refreshIndicator().catch(
                        e => console.error('ClipboardIndicator: refresh:', e));
            }
        );
    }

    async _refreshIndicator() {
        if (!this._menuReady || this._destroyed)
            return;
        if (this.#refreshInProgress) {
            // 标记待处理，避免刷新期间丢失本地剪贴板变更
            this.#pendingLocalRefresh = true;
            return;
        }
        this.#refreshInProgress = true;

        try {
            const entry = await this.#getClipboardContent();
            if (!entry || this._destroyed)
                return;

            const isFromRemote = this.#lastReceivedHash !== null &&
                entry.getStringValue() === this.#lastReceivedHash;

            // Deduplicate
            for (let item of this.clipItemsRadioGroup) {
                if (item.entry.equals(entry)) {
                    this._selectMenuItem(item, false);
                    if (!isFromRemote)
                        this.sync?.send(entry.mimetype(), entry.rawBytes());
                    return;
                }
            }

            // New local clipboard entry
            this._addEntry(entry, true, false);
            this._removeOldestEntries();
            this._updateCache();

            if (!isFromRemote)
                this.sync?.send(entry.mimetype(), entry.rawBytes());
        } catch (e) {
            console.error('ClipboardIndicator: refresh error', e);
        } finally {
            this.#refreshInProgress = false;
            if (this.#pendingRemoteClipboard) {
                const {mimetype, bytes} = this.#pendingRemoteClipboard;
                this.#pendingRemoteClipboard = null;
                try {
                    this._onRemoteClipboard(mimetype, bytes);
                } catch (e) {
                    console.error('ClipboardIndicator: pending remote:', e);
                }
            }
            if (this.#pendingLocalRefresh) {
                this.#pendingLocalRefresh = false;
                this._refreshIndicator().catch(
                    e => console.error('ClipboardIndicator: pending local:', e));
            }
        }
    }

    async #getClipboardContent() {
        const mimetypes = [
            'text/plain;charset=utf-8',
            'UTF8_STRING',
            'text/plain',
            'STRING',
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
        ];

        let aborted = false;
        for (let type of mimetypes) {
            if (aborted || this._destroyed)
                break;
            let result = await Promise.race([
                new Promise(resolve => {
                    this._clipboard.get_content(
                        CLIPBOARD_TYPE, type, (cb, bytes) => {
                            if (!bytes || bytes.get_size() === 0) {
                                resolve(null);
                                return;
                            }
                            // Workaround: GNOME mangles mimetype on 2nd+ copy
                            if (type === 'UTF8_STRING')
                                type = 'text/plain;charset=utf-8';
                            resolve(new ClipboardEntry(type, bytes.get_data()));
                        });
                }),
                // Safety timeout: prevents #refreshInProgress stuck forever
                new Promise(resolve => setTimeout(() => {
                    console.warn('ClipboardIndicator: clipboard read timed out for', type);
                    aborted = true;
                    resolve(null);
                }, 2000)),
            ]);
            if (result)
                return result;
        }
        return null;
    }

    // ──────────────────────── Paste ────────────────────────

    #pasteItem(menuItem) {
        this.menu.close();
        const selected = this.clipItemsRadioGroup.find(
            i => i.currentlySelected);

        this._clipboard.set_content(
            CLIPBOARD_TYPE,
            menuItem.entry.mimetype(),
            menuItem.entry.asBytes());

        this._pasteKeypressTimeout = setTimeout(() => {
            if (this._destroyed)
                return;
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            } else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pasteResetTimeout = setTimeout(() => {
                if (this._destroyed)
                    return;
                if (selected?.entry) {
                    this._clipboard.set_content(
                        CLIPBOARD_TYPE,
                        selected.entry.mimetype(),
                        selected.entry.asBytes());
                }
            }, 50);
        }, 50);
    }

    // ──────────────────────── Cleanup ────────────────────────

    _disconnectSelectionListener() {
        if (this._selectionOwnerChangedId && this.selection) {
            this.selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }
    }

    #clearTimeouts() {
        if (this._cacheWriteTimeout) {
            clearTimeout(this._cacheWriteTimeout);
            this._cacheWriteTimeout = null;
        }
        if (this._pasteKeypressTimeout) {
            clearTimeout(this._pasteKeypressTimeout);
            this._pasteKeypressTimeout = null;
        }
        if (this._pasteResetTimeout) {
            clearTimeout(this._pasteResetTimeout);
            this._pasteResetTimeout = null;
        }
        if (this._remoteHashTimeout) {
            clearTimeout(this._remoteHashTimeout);
            this._remoteHashTimeout = null;
        }
    }
});
