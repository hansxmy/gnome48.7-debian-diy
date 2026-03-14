/**
 * StatusNotifierWatcher — D-Bus service accepting SNI tray registrations.
 * Implements org.kde.StatusNotifierWatcher on the session bus.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.kde.StatusNotifierWatcher';
const OBJ_PATH = '/StatusNotifierWatcher';

const IFACE_XML = `
<node>
  <interface name="${BUS_NAME}">
    <method name="RegisterStatusNotifierItem">
      <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg name="service" type="s" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg type="s"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>`;

let _ifaceInfo;
try {
    _ifaceInfo = Gio.DBusNodeInfo.new_for_xml(IFACE_XML)
        .lookup_interface(BUS_NAME);
} catch (e) {
    console.error('SniWatcher: introspect XML parse failed', e);
}

export class StatusNotifierWatcher {
    #items = new Map();   // serviceId → {busName, objPath, watchId}
    #dbusId = 0;
    #ownerId = 0;
    #conn = null;
    #destroyed = false;
    #onRegistered;
    #onUnregistered;

    /** Maximum number of SNI items to prevent memory exhaustion from rogue clients. */
    static MAX_ITEMS = 64;

    /**
     * @param {object} callbacks
     * @param {Function} callbacks.onRegistered  — (serviceId, busName, objPath)
     * @param {Function} callbacks.onUnregistered — (serviceId)
     */
    constructor({onRegistered, onUnregistered}) {
        this.#onRegistered = onRegistered;
        this.#onUnregistered = onUnregistered;

        this.#ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            conn => this.#onBusAcquired(conn),
            () => {
                // Notify SNI clients that a host is available
                this.#conn?.emit_signal(null, OBJ_PATH, BUS_NAME,
                    'StatusNotifierHostRegistered', null);
            },
            () => console.error('SniWatcher: cannot own', BUS_NAME)
        );
    }

    destroy() {
        this.#destroyed = true;
        for (const [, info] of this.#items)
            Gio.bus_unwatch_name(info.watchId);
        this.#items.clear();

        if (this.#dbusId && this.#conn) {
            this.#conn.unregister_object(this.#dbusId);
            this.#dbusId = 0;
        }
        if (this.#ownerId) {
            Gio.bus_unown_name(this.#ownerId);
            this.#ownerId = 0;
        }
    }

    // ── D-Bus handlers ──

    #onBusAcquired(conn) {
        this.#conn = conn;
        if (!_ifaceInfo) {
            console.error('SniWatcher: cannot register — introspect info unavailable');
            return;
        }
        this.#dbusId = conn.register_object(
            OBJ_PATH, _ifaceInfo,
            (_c, _s, _p, _i, method, params, invocation) =>
                this.#handleMethod(method, params, invocation),
            (_c, _s, _p, _i, prop) => this.#handleGetProp(prop),
            null
        );
    }

    #handleMethod(method, params, invocation) {
        if (this.#destroyed) {
            invocation.return_dbus_error(
                'org.freedesktop.DBus.Error.Failed', 'Watcher destroyed');
            return;
        }
        if (method === 'RegisterStatusNotifierItem') {
            const sender = invocation.get_sender();
            const [service] = params.deep_unpack();
            this.#register(service, sender);
            invocation.return_value(null);
            return;
        }
        if (method === 'RegisterStatusNotifierHost') {
            invocation.return_value(null);
            return;
        }
        invocation.return_dbus_error(
            'org.freedesktop.DBus.Error.UnknownMethod',
            `Unknown method: ${method}`);
    }

    #handleGetProp(prop) {
        if (prop === 'RegisteredStatusNotifierItems')
            return new GLib.Variant('as', [...this.#items.keys()]);
        if (prop === 'IsStatusNotifierHostRegistered')
            return new GLib.Variant('b', true);
        if (prop === 'ProtocolVersion')
            return new GLib.Variant('i', 0);
        return null;
    }

    // ── Registration ──

    #register(service, sender) {
        let busName, objPath;
        if (service.startsWith('/')) {
            busName = sender;
            objPath = service;
        } else {
            busName = service;
            objPath = '/StatusNotifierItem';
        }

        // Validate D-Bus name format to avoid GLib critical warnings
        // from bus_watch_name and proxy creation with garbage input.
        if (!busName || !/^:[A-Za-z0-9_.]+$|^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(busName))
            return;

        const id = `${busName}${objPath}`;
        if (this.#items.has(id))
            return;

        // Safety: prevent memory exhaustion from misbehaving SNI clients
        if (this.#items.size >= StatusNotifierWatcher.MAX_ITEMS) {
            console.warn(`SniWatcher: ignoring registration — max ${StatusNotifierWatcher.MAX_ITEMS} items reached`);
            return;
        }

        const watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, busName,
            Gio.BusNameWatcherFlags.NONE,
            null,
            () => this.#onVanished(id)
        );

        this.#items.set(id, {busName, objPath, watchId});

        this.#conn?.emit_signal(null, OBJ_PATH, BUS_NAME,
            'StatusNotifierItemRegistered',
            new GLib.Variant('(s)', [id]));

        this.#onRegistered?.(id, busName, objPath);
    }

    #onVanished(id) {
        if (this.#destroyed || !this.#items.has(id))
            return;

        const info = this.#items.get(id);
        Gio.bus_unwatch_name(info.watchId);
        this.#items.delete(id);

        this.#conn?.emit_signal(null, OBJ_PATH, BUS_NAME,
            'StatusNotifierItemUnregistered',
            new GLib.Variant('(s)', [id]));

        this.#onUnregistered?.(id);
    }
}
