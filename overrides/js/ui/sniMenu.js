/**
 * DBusMenu client — fetches and renders com.canonical.dbusmenu
 * menu trees into GNOME Shell PopupMenu items.
 *
 * Protocol: GetLayout returns a recursive (ia{sv}av) tree.
 * Updates arrive via LayoutUpdated / ItemsPropertiesUpdated signals.
 * Clicks are sent back via Event(id, 'clicked', ...).
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as PopupMenu from './popupMenu.js';

const MENU_IFACE = 'com.canonical.dbusmenu';

const MENU_XML = `
<node>
  <interface name="${MENU_IFACE}">
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
    <signal name="ItemsPropertiesUpdated">
      <arg type="a(ia{sv})" name="updatedProps"/>
      <arg type="a(ias)" name="removedProps"/>
    </signal>
  </interface>
</node>`;

let _menuIfaceInfo;
try {
    _menuIfaceInfo = Gio.DBusNodeInfo.new_for_xml(MENU_XML)
        .lookup_interface(MENU_IFACE);
} catch (e) {
    console.error('SniMenu: introspect XML parse failed', e);
}

export class SniMenuClient {
    #proxy = null;
    #menu;
    #busName;
    #menuPath;
    #destroyed = false;
    #signalId = 0;
    #openStateId = 0;
    #layoutFetched = false;

    /**
     * @param {string} busName
     * @param {string} menuPath — object path for com.canonical.dbusmenu
     * @param {PopupMenu.PopupMenu} popupMenu — target menu to populate
     */
    constructor(busName, menuPath, popupMenu) {
        this.#busName = busName;
        this.#menuPath = menuPath;
        this.#menu = popupMenu;

        this.#openStateId = this.#menu.connect('open-state-changed',
            (_, open) => { if (open) this.#onMenuOpen(); });

        this.#createProxy();
    }

    /** Re-create for a new menu path (handles NewMenu signal). */
    updatePath(newPath) {
        if (newPath === this.#menuPath) return;
        this.#menuPath = newPath;
        this.#disconnect();
        this.#layoutFetched = false;
        this.#createProxy();
    }

    destroy() {
        this.#destroyed = true;
        this.#disconnect();
        if (this.#openStateId && this.#menu) {
            try { this.#menu.disconnect(this.#openStateId); }
            catch (_e) { /* menu may already be destroyed */ }
            this.#openStateId = 0;
        }
    }

    #disconnect() {
        if (this.#signalId && this.#proxy) {
            this.#proxy.disconnect(this.#signalId);
            this.#signalId = 0;
        }
        this.#proxy = null;
    }

    // ── Proxy ──

    #createProxy() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            _menuIfaceInfo,
            this.#busName, this.#menuPath, MENU_IFACE,
            null,
            (_o, res) => {
                if (this.#destroyed) return;
                try {
                    this.#proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    console.error('SniMenu: proxy creation failed', e);
                    return;
                }
                if (this.#destroyed) { this.#proxy = null; return; }

                this.#signalId = this.#proxy.connect('g-signal',
                    (_p, _s, signal) => {
                        if (signal === 'LayoutUpdated' ||
                            signal === 'ItemsPropertiesUpdated')
                            this.#fetchLayout();
                    });

                this.#fetchLayout();
            }
        );
    }

    // ── Menu open ──

    #onMenuOpen() {
        if (!this.#proxy) return;

        if (!this.#layoutFetched) {
            this.#fetchLayout();
            return;
        }

        this.#proxy.call('AboutToShow',
            new GLib.Variant('(i)', [0]),
            Gio.DBusCallFlags.NONE, 1000, null,
            (_p, res) => {
                try {
                    const result = _p.call_finish(res);
                    const [needUpdate] = result.deep_unpack();
                    if (needUpdate)
                        this.#fetchLayout();
                } catch (_e) { /* AboutToShow not supported — ok */ }
            }
        );
    }

    // ── Layout fetch & parse ──

    #fetchLayout() {
        if (!this.#proxy || this.#destroyed) return;

        this.#proxy.call('GetLayout',
            new GLib.Variant('(iias)', [0, -1, []]),
            Gio.DBusCallFlags.NONE, 5000, null,
            (_p, res) => {
                if (this.#destroyed) return;
                try {
                    const result = _p.call_finish(res);
                    // Return type: (u(ia{sv}av))
                    const rootNode = result.get_child_value(1);
                    const layout = this.#parseNode(rootNode);
                    this.#buildMenu(layout);
                    this.#layoutFetched = true;
                } catch (e) {
                    console.error('SniMenu: GetLayout failed', e);
                }
            }
        );
    }

    /**
     * Recursively parse (ia{sv}av) node into {id, props, children}.
     */
    #parseNode(node) {
        const id = node.get_child_value(0).get_int32();
        const propsDict = node.get_child_value(1); // a{sv}
        const childrenArr = node.get_child_value(2); // av

        const props = {};
        const nProps = propsDict.n_children();
        for (let i = 0; i < nProps; i++) {
            const entry = propsDict.get_child_value(i);
            const key = entry.get_child_value(0).get_string()[0];
            const val = entry.get_child_value(1).get_variant();
            const t = val.get_type_string();
            if (t === 's')
                props[key] = val.get_string()[0];
            else if (t === 'i')
                props[key] = val.get_int32();
            else if (t === 'b')
                props[key] = val.get_boolean();
            // Other types (ay icon-data, etc.) kept as variant
            else
                props[key] = val;
        }

        const children = [];
        const nChildren = childrenArr.n_children();
        for (let i = 0; i < nChildren; i++) {
            const cv = childrenArr.get_child_value(i).get_variant();
            children.push(this.#parseNode(cv));
        }

        return {id, props, children};
    }

    // ── Menu building ──

    #buildMenu(rootNode) {
        this.#menu.removeAll();
        this.#addChildren(rootNode.children, this.#menu);
    }

    #addChildren(children, parentMenu) {
        for (const node of children) {
            const p = node.props;

            // Skip invisible items
            if (p.visible === false)
                continue;

            // Separator
            if (p.type === 'separator') {
                parentMenu.addMenuItem(
                    new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }

            // Submenu
            if (p['children-display'] === 'submenu') {
                const sub = new PopupMenu.PopupSubMenuMenuItem(
                    this.#cleanLabel(p.label));
                if (p.enabled === false)
                    sub.setSensitive(false);
                parentMenu.addMenuItem(sub);
                this.#addChildren(node.children, sub.menu);
                continue;
            }

            // Normal item
            const item = new PopupMenu.PopupMenuItem(
                this.#cleanLabel(p.label));
            if (p.enabled === false)
                item.setSensitive(false);

            // Toggle ornament
            if (p['toggle-type'] === 'checkmark') {
                item.setOrnament(p['toggle-state'] === 1
                    ? PopupMenu.Ornament.CHECK
                    : PopupMenu.Ornament.NONE);
            } else if (p['toggle-type'] === 'radio') {
                item.setOrnament(p['toggle-state'] === 1
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE);
            }

            // Optional icon
            if (typeof p['icon-name'] === 'string' && p['icon-name']) {
                item.insert_child_at_index(new St.Icon({
                    icon_name: p['icon-name'],
                    style_class: 'popup-menu-icon',
                    style: 'icon-size: 1em; margin-right: 0.5em;',
                }), 0);
            }

            item.connect('activate', () => this.#sendEvent(node.id));
            parentMenu.addMenuItem(item);
        }
    }

    /** Remove GTK accelerator underscores: _Open → Open, F__oo → F_oo */
    #cleanLabel(label) {
        if (!label) return '';
        return label.replace(/_([^_])/g, '$1').replace(/__/g, '_');
    }

    #sendEvent(id, event = 'clicked') {
        this.#proxy?.call('Event',
            new GLib.Variant('(isvu)', [
                id, event, new GLib.Variant('i', 0), 0,
            ]),
            Gio.DBusCallFlags.NONE, 1000, null,
            (_p, res) => {
                try { _p.call_finish(res); }
                catch (_e) { /* non-fatal */ }
            }
        );
    }
}
