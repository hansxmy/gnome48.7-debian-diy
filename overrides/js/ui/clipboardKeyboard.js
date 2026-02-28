/**
 * Virtual keyboard for clipboard paste simulation.
 * Detects terminal context to use the correct paste shortcut.
 */
import Clutter from 'gi://Clutter';

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
        this.#device.run_dispose();
    }

    get purpose() {
        return this.#contentPurpose;
    }

    press(key) {
        this.#device.notify_keyval(
            Clutter.get_current_event_time() * 1000,
            key, Clutter.KeyState.PRESSED);
    }

    release(key) {
        this.#device.notify_keyval(
            Clutter.get_current_event_time() * 1000,
            key, Clutter.KeyState.RELEASED);
    }
}
