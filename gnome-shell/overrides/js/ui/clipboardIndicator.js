/**
 * Clipboard Indicator — built into GNOME Shell panel.
 *
 * Lightweight clipboard manager with MountLink cross-device sync.
 * Stripped from gnome-shell-extension-clipboard-indicator: no Extension
 * API, no GSettings, no prefs UI, no locale system, no file logger.
 * All configuration is hardcoded for maximum efficiency.
 *
 * NOTE: UI strings are hardcoded in Chinese for this custom build.
 * For multi-language support, replace string literals with
 * imports.gettext.gettext() calls from GNOME Shell's gettext domain.
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
const MAX_CACHE_SIZE_MB   = 20;
const MAX_ENTRY_SIZE      = 5 * 1024 * 1024; // 5 MB per entry (runtime guard)
const SYNC_ENABLED        = true;

export const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator',
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #selfTriggered = false;
    #pasteInProgress = false;
    #lastReceivedHash = null;
    #pendingRemoteClipboard = null;
    #pendingLocalRefresh = false;

    destroy() {
        this._disconnectSelectionListener();
        this._flushCache();
        this._destroyed = true;
        this.#clearTimeouts();
        this.keyboard?.destroy();
        this.sync?.destroy();
        // Destroy orphaned emptyStateSection if it was removed from the
        // Clutter tree (when clipboard has history items).  Without this
        // the St.BoxLayout and its children leak until GC.
        if (this.emptyStateSection) {
            this.emptyStateSection.destroy();
            this.emptyStateSection = null;
        }
        super.destroy();
    }

    _init() {
        super._init(0.0, 'ClipboardIndicator');
        this._clipboard = St.Clipboard.get_default();
        this.registry = new ClipboardRegistry();
        try {
            this.keyboard = new ClipboardKeyboard();
        } catch (e) {
            console.error('ClipboardIndicator: keyboard init failed', e);
            this.keyboard = null;
        }
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
            MAX_REGISTRY_LENGTH, MAX_CACHE_SIZE_MB);
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
            style: 'max-height: 350px; max-width: 300px;',
            overlay_scrollbars: true,
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
        // Larger click target & bottom margin prevent Wayland popup
        // edge-clipping misses on fractional-scaled displays (150%).
        this.clearMenuItem.style = 'min-height: 36px; margin-bottom: 6px;';
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
        if (this.#refreshInProgress || this.#pasteInProgress) {
            // Defer until current refresh/paste completes to avoid
            // overwriting clipboard content that is about to be pasted.
            this.#pendingRemoteClipboard = {mimetype, bytes};
            return;
        }
        this.#applyRemoteClipboard(mimetype, bytes);
    }

    #applyRemoteClipboard(mimetype, bytes) {
        if (bytes.length > MAX_ENTRY_SIZE)
            return;  // Reject oversized remote entries
        const entry = new ClipboardEntry(mimetype, bytes);
        this.#lastReceivedHash = entry.getStringValue();

        this.#setClipboardContent(mimetype, entry.asBytes());

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
            if (menuItem.currentlySelected) {
                // Already selected → paste
                this.#pasteSelectedItem();
            } else {
                // Not selected → switch only (no paste)
                this._selectMenuItem(menuItem);
            }
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
                if (menuItem.currentlySelected) {
                    this.#pasteSelectedItem();
                } else {
                    this._selectMenuItem(menuItem);
                    this.menu.close();
                }
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
                if (!menuItem.get_parent()) {
                    img.destroy();
                    return;
                }
                img.style =
                    'border: solid 1px white; overflow: hidden; ' +
                    'width: 1.5em; height: 1.5em; margin: 0; padding: 0;';
                if (menuItem.previewImage) {
                    menuItem.remove_child(menuItem.previewImage);
                    menuItem.previewImage.destroy();
                }
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
                if (autoSet)
                    this.#setClipboardContent(item.entry.mimetype(), item.entry.asBytes());
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
            this.#clearClipboardText();

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
                this.#clearClipboardText();
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
                this.#clearClipboardText();
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
                if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                    return;
                // Skip self-triggered changes: set_content() synchronously
                // emits owner-changed.  Re-reading the clipboard we just
                // wrote is wasteful and can race with menu-close / focus
                // changes on Wayland, producing empty reads.
                if (this.#selfTriggered)
                    return;
                if (this.#pasteInProgress)
                    return;
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
                    // autoSet=false: do NOT take clipboard ownership here.
                    // The original app still owns the clipboard with its
                    // full set of mimetypes (e.g. x-special/gnome-copied-files
                    // for file copy, text/uri-list, etc.).  Calling
                    // set_content() here would replace the rich content with
                    // just our single stored mimetype, breaking file paste
                    // and other multi-format clipboard operations.
                    // Ownership is taken later in #pasteSelectedItem() right
                    // before simulating Ctrl+V.
                    this._selectMenuItem(item, false);
                    if (!isFromRemote)
                        this.sync?.send(entry.mimetype(), entry.rawBytes());
                    return;
                }
            }

            // New local clipboard entry
            // autoSetClip=false: same reason — preserve the original app's
            // clipboard ownership so all mimetypes remain available for
            // direct Ctrl+V paste.  Our indicator only records the entry.
            this._addEntry(entry, true, false);
            this._removeOldestEntries();
            this._updateCache();

            if (!isFromRemote)
                this.sync?.send(entry.mimetype(), entry.rawBytes());
        } catch (e) {
            console.error('ClipboardIndicator: refresh error', e);
        } finally {
            this.#refreshInProgress = false;
            if (this.#pendingRemoteClipboard && !this._destroyed) {
                const {mimetype, bytes} = this.#pendingRemoteClipboard;
                this.#pendingRemoteClipboard = null;
                // Re-set refreshInProgress BEFORE applying remote clipboard,
                // because set_content() synchronously triggers owner-changed →
                // _refreshIndicator(), which must see the guard as active.
                this.#refreshInProgress = true;
                try {
                    this.#applyRemoteClipboard(mimetype, bytes);
                } catch (e) {
                    console.error('ClipboardIndicator: pending remote:', e);
                } finally {
                    this.#refreshInProgress = false;
                }
            }
            if (this.#pendingLocalRefresh && !this._destroyed) {
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
        let timeoutCount = 0;
        let currentTimeoutId = 0;
        for (let type of mimetypes) {
            if (aborted || this._destroyed)
                break;
            let result = await Promise.race([
                new Promise(resolve => {
                    this._clipboard.get_content(
                        CLIPBOARD_TYPE, type, (cb, bytes) => {
                            clearTimeout(currentTimeoutId);
                            try {
                                if (!bytes || bytes.get_size() === 0) {
                                    resolve(null);
                                    return;
                                }
                                if (bytes.get_size() > MAX_ENTRY_SIZE) {
                                    resolve(null);  // Skip oversized entries
                                    return;
                                }
                                // Workaround: GNOME mangles mimetype on 2nd+ copy
                                if (type === 'UTF8_STRING')
                                    type = 'text/plain;charset=utf-8';
                                resolve(new ClipboardEntry(type, bytes.get_data()));
                            } catch (e) {
                                console.error(`ClipboardIndicator: clipboard read (${type}):`, e);
                                resolve(null);
                            }
                        });
                }),
                // Safety timeout: prevents #refreshInProgress stuck forever
                new Promise(resolve => {
                    currentTimeoutId = setTimeout(() => {
                        aborted = true;
                        timeoutCount++;
                        resolve(null);
                    }, 2000);
                }),
            ]);
            if (result)
                return result;
        }
        // 汇总超时日志：一次性报告，避免逐 mimetype 刷屏
        if (timeoutCount > 0)
            log(`ClipboardIndicator: clipboard read timed out (${timeoutCount} mimetype(s), owner likely exited)`);
        return null;
    }

    // ──────────────────────── Paste ────────────────────────

    #setClipboardContent(mimetype, bytes) {
        this.#selfTriggered = true;
        try {
            this._clipboard.set_content(CLIPBOARD_TYPE, mimetype, bytes);
        } finally {
            this.#selfTriggered = false;
        }
    }

    #clearClipboardText() {
        this.#selfTriggered = true;
        try {
            this._clipboard.set_text(CLIPBOARD_TYPE, '');
        } finally {
            this.#selfTriggered = false;
        }
    }

    #simulatePaste() {
        if (!this.keyboard) return;
        if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
            this.keyboard.press(Clutter.KEY_Control_L);
            this.keyboard.press(Clutter.KEY_Shift_L);
            this.keyboard.press(Clutter.KEY_v);
            this.keyboard.release(Clutter.KEY_v);
            this.keyboard.release(Clutter.KEY_Shift_L);
            this.keyboard.release(Clutter.KEY_Control_L);
        } else {
            this.keyboard.press(Clutter.KEY_Control_L);
            this.keyboard.press(Clutter.KEY_v);
            this.keyboard.release(Clutter.KEY_v);
            this.keyboard.release(Clutter.KEY_Control_L);
        }
    }

    /**
     * Paste the currently-selected clipboard item.
     * Called when user clicks/taps an already-selected entry.
     * Explicitly close the menu FIRST to release the Wayland grab
     * so the compositor restores focus to the previous window
     * before we send the virtual key press.
     */
    #pasteSelectedItem() {
        const selected = this.clipItemsRadioGroup.find(
            i => i.currentlySelected);
        if (!selected) return;

        this.menu.close();
        this.#pasteInProgress = true;

        // Re-set clipboard content to guarantee it matches the selected
        // entry — another app may have taken ownership between selection
        // and this paste click.
        this.#setClipboardContent(
            selected.entry.mimetype(), selected.entry.asBytes());

        if (this._pasteResetTimeout)
            clearTimeout(this._pasteResetTimeout);
        if (this._pasteKeypressTimeout)
            clearTimeout(this._pasteKeypressTimeout);
        // Wayland grab is released synchronously on menu.close();
        // 100 ms (~6 frames @ 60 Hz) is enough for the compositor
        // to transfer focus back to the previous window.
        this._pasteKeypressTimeout = setTimeout(() => {
            this.#pasteInProgress = false;
            if (this._destroyed) return;
            this.#simulatePaste();
        }, 100);
    }

    /** Quick-paste via 'v' key without changing selection. */
    #pasteItem(menuItem) {
        this.menu.close();
        const selected = this.clipItemsRadioGroup.find(
            i => i.currentlySelected);

        this.#pasteInProgress = true;
        this.#setClipboardContent(
            menuItem.entry.mimetype(),
            menuItem.entry.asBytes());

        if (this._pasteResetTimeout)
            clearTimeout(this._pasteResetTimeout);
        if (this._pasteKeypressTimeout)
            clearTimeout(this._pasteKeypressTimeout);
        // 100 ms for focus transfer, 200 ms for app to process Ctrl+V
        this._pasteKeypressTimeout = setTimeout(() => {
            if (this._destroyed) return;
            this.#simulatePaste();
            // Restore previous clipboard selection
            this._pasteResetTimeout = setTimeout(() => {
                this.#pasteInProgress = false;
                if (this._destroyed) return;
                if (selected?.entry &&
                    this.clipItemsRadioGroup.includes(selected)) {
                    this.#setClipboardContent(
                        selected.entry.mimetype(),
                        selected.entry.asBytes());
                }
            }, 200);
        }, 100);
    }

    // ──────────────────────── Cleanup ────────────────────────

    _disconnectSelectionListener() {
        if (this._selectionOwnerChangedId && this.selection) {
            this.selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }
    }

    #clearTimeouts() {
        this.#pasteInProgress = false;
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
