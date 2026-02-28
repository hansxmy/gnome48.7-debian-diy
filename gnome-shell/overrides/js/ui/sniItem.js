/**
 * StatusNotifierItem proxy — connects to a single SNI client,
 * manages properties and icon resolution.
 *
 * Icon priority: IconName (themed/path) > IconPixmap (ARGB pixel data).
 * Pixmap data is converted ARGB→RGBA→PNG→Gio.BytesIcon for St.Icon.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const SNI_IFACE = 'org.kde.StatusNotifierItem';
const ICON_SIZE = 16;

const SNI_XML = `
<node>
  <interface name="${SNI_IFACE}">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewIconThemePath">
      <arg type="s" name="icon_theme_path"/>
    </signal>
    <signal name="NewStatus">
      <arg type="s" name="status"/>
    </signal>
    <signal name="NewTitle"/>
    <signal name="NewMenu"/>
  </interface>
</node>`;

let _sniIfaceInfo;
try {
    _sniIfaceInfo = Gio.DBusNodeInfo.new_for_xml(SNI_XML)
        .lookup_interface(SNI_IFACE);
} catch (e) {
    console.error('SniItem: SNI XML parse failed', e);
}

export class SniItem {
    #proxy = null;
    #busName;
    #objPath;
    #destroyed = false;
    #signalId = 0;
    #propSignalId = 0;
    #refreshTimeout = null;

    #pendingTriggers = null;
    #onReady;
    #onIconChanged;
    #onStatusChanged;
    #onMenuChanged;

    constructor(busName, objPath, {onReady, onIconChanged, onStatusChanged, onMenuChanged}) {
        this.#busName = busName;
        this.#objPath = objPath;
        this.#onReady = onReady;
        this.#onIconChanged = onIconChanged;
        this.#onStatusChanged = onStatusChanged;
        this.#onMenuChanged = onMenuChanged;

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            _sniIfaceInfo,
            busName, objPath, SNI_IFACE,
            null,
            (_o, res) => this.#onProxyReady(res)
        );
    }

    get busName() { return this.#busName; }

    get id() { return this.#getString('Id'); }
    get title() { return this.#getString('Title') || this.id; }
    get status() { return this.#getString('Status') || 'Active'; }
    get menuPath() { return this.#getString('Menu') || '/MenuBar'; }

    /** True when the item ONLY has a menu (click → menu). False means it
     *  has a primary action (left-click → Activate, right-click → menu). */
    get itemIsMenu() {
        const v = this.#proxy?.get_cached_property('ItemIsMenu');
        if (!v) return false;
        try { return v.get_boolean(); }
        catch { return false; }
    }

    activate(x = 0, y = 0) {
        this.#proxy?.call('Activate',
            new GLib.Variant('(ii)', [x, y]),
            Gio.DBusCallFlags.NONE, 1000, null, null);
    }

    destroy() {
        this.#destroyed = true;
        if (this.#refreshTimeout) {
            clearTimeout(this.#refreshTimeout);
            this.#refreshTimeout = null;
        }
        if (this.#signalId && this.#proxy)
            this.#proxy.disconnect(this.#signalId);
        if (this.#propSignalId && this.#proxy)
            this.#proxy.disconnect(this.#propSignalId);
        this.#proxy = null;
    }

    // ── Icon Resolution ──

    /** @returns {Gio.Icon|null} */
    getIcon() {
        if (!this.#proxy) return null;

        const attention = this.status === 'NeedsAttention';
        const nameProp = attention ? 'AttentionIconName' : 'IconName';
        const pixProp = attention ? 'AttentionIconPixmap' : 'IconPixmap';

        // 1. Themed or path icon name
        let iconName = this.#getString(nameProp);
        if (!iconName && attention)
            iconName = this.#getString('IconName');

        if (iconName) {
            if (iconName.startsWith('/'))
                return Gio.FileIcon.new(Gio.file_new_for_path(iconName));

            const cleaned = iconName.replace(/\.(svg|png|xpm)$/i, '');
            const themePath = this.#getString('IconThemePath');
            if (themePath) {
                const found = this.#findInThemePath(cleaned, themePath);
                if (found) return found;
            }
            return Gio.ThemedIcon.new(cleaned);
        }

        // 2. Pixmap data (ARGB → PNG → BytesIcon)
        let pixVar = this.#proxy.get_cached_property(pixProp);
        if (!pixVar && attention)
            pixVar = this.#proxy.get_cached_property('IconPixmap');
        if (pixVar)
            return this.#pixmapToIcon(pixVar);

        return null;
    }

    // ── Private ──

    #onProxyReady(res) {
        if (this.#destroyed) return;
        try {
            this.#proxy = Gio.DBusProxy.new_for_bus_finish(res);
        } catch (e) {
            console.error('SniItem: proxy creation failed', e);
            return;
        }
        if (this.#destroyed) { this.#proxy = null; return; }

        this.#pendingTriggers = new Set();
        this.#signalId = this.#proxy.connect('g-signal',
            (_p, _s, signal) => this.#scheduleRefresh(signal));
        this.#propSignalId = this.#proxy.connect('g-properties-changed',
            () => this.#scheduleRefresh('properties'));

        this.#onReady?.();
    }

    #scheduleRefresh(trigger) {
        if (this.#destroyed) return;
        this.#pendingTriggers.add(trigger);
        if (this.#refreshTimeout)
            clearTimeout(this.#refreshTimeout);
        this.#refreshTimeout = setTimeout(() => {
            this.#refreshTimeout = null;
            const triggers = this.#pendingTriggers;
            this.#pendingTriggers = new Set();
            this.#doRefresh(triggers);
        }, 50);
    }

    #doRefresh(triggers) {
        this.#proxy?.call(
            'org.freedesktop.DBus.Properties.GetAll',
            new GLib.Variant('(s)', [SNI_IFACE]),
            Gio.DBusCallFlags.NONE, 5000, null,
            (_p, res) => {
                if (this.#destroyed) return;
                try {
                    const [props] = _p.call_finish(res).deep_unpack();
                    for (const [key, value] of Object.entries(props))
                        this.#proxy.set_cached_property(key, value);
                } catch (_e) { /* GetAll may partially fail — use stale cache */ }

                const iconSigs = ['NewIcon', 'NewAttentionIcon',
                    'NewOverlayIcon', 'NewIconThemePath', 'properties'];
                if (iconSigs.some(s => triggers.has(s)))
                    this.#onIconChanged?.();
                if (triggers.has('NewStatus') || triggers.has('properties'))
                    this.#onStatusChanged?.();
                if (triggers.has('NewMenu'))
                    this.#onMenuChanged?.();
            }
        );
    }

    #getString(prop) {
        const v = this.#proxy?.get_cached_property(prop);
        if (!v) return '';
        try { return v.get_string()[0]; }
        catch { return ''; }
    }

    #findInThemePath(iconName, basePath) {
        const exts = ['svg', 'png'];
        // Direct file in base path
        for (const ext of exts) {
            const p = GLib.build_filenamev([basePath, `${iconName}.${ext}`]);
            if (GLib.file_test(p, GLib.FileTest.EXISTS))
                return Gio.FileIcon.new(Gio.file_new_for_path(p));
        }
        // hicolor directory structure
        for (const size of ['scalable', '48x48', '32x32', '22x22', '16x16']) {
            for (const ext of exts) {
                for (const cat of ['apps', 'status']) {
                    const p = GLib.build_filenamev([
                        basePath, 'hicolor', size, cat,
                        `${iconName}.${ext}`,
                    ]);
                    if (GLib.file_test(p, GLib.FileTest.EXISTS))
                        return Gio.FileIcon.new(Gio.file_new_for_path(p));
                }
            }
        }
        return null;
    }

    #pixmapToIcon(variant) {
        try {
            const n = variant.n_children();
            if (n === 0) return null;

            // Select pixmap closest to ICON_SIZE
            let best = variant.get_child_value(0);
            let bestW = best.get_child_value(0).get_int32();
            for (let i = 1; i < n; i++) {
                const p = variant.get_child_value(i);
                const w = p.get_child_value(0).get_int32();
                if (Math.abs(w - ICON_SIZE) < Math.abs(bestW - ICON_SIZE)) {
                    best = p;
                    bestW = w;
                }
            }

            const w = best.get_child_value(0).get_int32();
            const h = best.get_child_value(1).get_int32();
            if (w <= 0 || h <= 0) return null;

            const raw = best.get_child_value(2).deep_unpack(); // Uint8Array
            if (!raw || raw.length < w * h * 4) return null;

            // ARGB (network byte order) → RGBA
            const rgba = new Uint8Array(raw.length);
            for (let j = 0; j < raw.length; j += 4) {
                rgba[j]     = raw[j + 1]; // R
                rgba[j + 1] = raw[j + 2]; // G
                rgba[j + 2] = raw[j + 3]; // B
                rgba[j + 3] = raw[j];     // A
            }

            const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                new GLib.Bytes(rgba),
                GdkPixbuf.Colorspace.RGB, true, 8, w, h, w * 4);

            const result = pixbuf.save_to_bufferv('png', [], []);
            const pngData = result.find(v => v instanceof Uint8Array);
            if (!pngData) return null;

            return Gio.BytesIcon.new(new GLib.Bytes(pngData));
        } catch (_e) {
            return null; // Pixmap rendering non-critical
        }
    }
}
