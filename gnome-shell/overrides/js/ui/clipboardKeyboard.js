/**
 * Virtual keyboard for clipboard paste simulation.
 * Detects terminal context to use the correct paste shortcut.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from './main.js';

export class ClipboardKeyboard {
    #device;
    #contentPurpose;

    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this.#device = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);

        Main.inputMethod.connectObject('notify::content-purpose', method => {
            this.#contentPurpose = method.content_purpose;
        }, this);
    }

    destroy() {
        Main.inputMethod.disconnectObject(this);
        // Release any modifier keys that may still be pressed
        // to prevent them from getting stuck in the compositor.
        if (this.#device) {
            try {
                const time = GLib.get_monotonic_time();
                for (const key of [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_Insert, Clutter.KEY_v])
                    this.#device.notify_keyval(time, key, Clutter.KeyState.RELEASED);
            } catch (_e) { /* best-effort */ }
            this.#device.run_dispose();
        }
        this.#device = null;
    }

    get purpose() {
        return this.#contentPurpose;
    }

    press(key) {
        if (!this.#device) return;
        const time = Clutter.get_current_event_time();
        const timeUs = time > 0 ? time * 1000 : GLib.get_monotonic_time();
        this.#device.notify_keyval(timeUs, key, Clutter.KeyState.PRESSED);
    }

    release(key) {
        if (!this.#device) return;
        const time = Clutter.get_current_event_time();
        const timeUs = time > 0 ? time * 1000 : GLib.get_monotonic_time();
        this.#device.notify_keyval(timeUs, key, Clutter.KeyState.RELEASED);
    }
}
