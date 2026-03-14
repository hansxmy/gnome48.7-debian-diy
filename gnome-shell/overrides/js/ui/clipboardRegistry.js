/**
 * Clipboard history persistence — read/write entries to a JSON cache file.
 * Uses the same cache directory as the original clipboard-indicator extension
 * so existing history is preserved after fusion.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

// Reuse extension's cache directory for seamless migration
const CACHE_DIR_NAME = 'clipboard-indicator@tudmotu.com';

export class ClipboardRegistry {
    constructor() {
        this.REGISTRY_DIR = GLib.build_filenamev([
            GLib.get_user_cache_dir(), CACHE_DIR_NAME]);
        this.REGISTRY_PATH = GLib.build_filenamev([
            this.REGISTRY_DIR, 'registry.txt']);
    }

    write(entries) {
        const data = entries.map(entry => {
            const item = {mimetype: entry.mimetype()};
            if (entry.isText()) {
                item.contents = entry.getStringValue();
            } else if (entry.isImage()) {
                item.contents = this.getEntryFilename(entry);
                this.writeEntryFile(entry).catch(e =>
                    console.error('ClipboardRegistry: write entry file:', e));
            }
            return item;
        });

        GLib.mkdir_with_parents(this.REGISTRY_DIR, 0o700);
        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const bytes = new GLib.Bytes(
            new TextEncoder().encode(JSON.stringify(data)));

        file.replace_async(null, false, Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                try {
                    let stream = obj.replace_finish(res);
                    stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT,
                        null, (w, r) => {
                            try { w.write_bytes_finish(r); }
                            catch (e) { console.error(e); }
                            finally { try { stream.close(null); } catch (_) {} }
                        });
                } catch (e) { console.error(e); }
            });
    }

    async read(maxSize, maxCacheMB = 5) {
        if (!GLib.file_test(this.REGISTRY_PATH, GLib.FileTest.EXISTS))
            return [];

        try {
            const file = Gio.file_new_for_path(this.REGISTRY_PATH);
            const info = file.query_info(
                'standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() > maxCacheMB * 1024 * 1024) {
                console.warn('ClipboardRegistry: cache too large, resetting');
                this.clearCacheFolder();
                return [];
            }
        } catch (_e) { /* proceed anyway */ }

        return new Promise(resolve => {
            const file = Gio.file_new_for_path(this.REGISTRY_PATH);

            file.load_contents_async(null, (obj, res) => {
                try {
                    let [success, contents] = obj.load_contents_finish(res);
                    if (!success) {
                        resolve([]);
                        return;
                    }

                    const registry = JSON.parse(
                        new TextDecoder().decode(contents));
                    const promises = registry.map(
                        json => ClipboardEntry.fromJSON(json, this.REGISTRY_DIR));

                    Promise.all(promises).then(entries => {
                        entries = entries.filter(e => e !== null);
                        while (maxSize && entries.length > maxSize)
                            entries.shift();
                        resolve(entries);
                    }).catch(e => {
                        console.error('ClipboardRegistry: read error', e);
                        resolve([]);
                    });
                } catch (e) {
                    console.error('ClipboardRegistry: parse error', e);
                    resolve([]);
                }
            });
        });
    }

    getEntryFilename(entry) {
        return GLib.build_filenamev(
            [this.REGISTRY_DIR, `${entry.getHash()}`]);
    }

    async getEntryAsImage(entry) {
        if (!entry.isImage())
            return null;
        const filename = this.getEntryFilename(entry);

        if (!GLib.file_test(filename, GLib.FileTest.EXISTS))
            await this.writeEntryFile(entry);

        return new St.Icon({gicon: Gio.icon_new_for_string(filename)});
    }

    async writeEntryFile(entry) {
        const filename = this.getEntryFilename(entry);
        if (GLib.file_test(filename, GLib.FileTest.EXISTS))
            return;

        const file = Gio.file_new_for_path(filename);
        return new Promise((resolve, reject) => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                    try {
                        let stream = obj.replace_finish(res);
                        stream.write_bytes_async(entry.asBytes(),
                            GLib.PRIORITY_DEFAULT, null, (w, r) => {
                                try { w.write_bytes_finish(r); resolve(); }
                                catch (e) { reject(e); }
                                finally { try { stream.close(null); } catch (_) {} }
                            });
                    } catch (e) { reject(e); }
                });
        });
    }

    deleteEntryFile(entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try { obj.delete_finish(res); } catch (_e) { /* may not exist */ }
        });
    }

    clearCacheFolder() {
        try {
            const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
            folder.enumerate_children_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_LOW, null, (obj, res) => {
                    try {
                        const enumerator = obj.enumerate_children_finish(res);
                        // Use async enumeration to avoid blocking eMMC reads
                        // on the main thread (Surface GO1).
                        this._deleteNextBatch(folder, enumerator);
                    } catch (e) {
                        console.error('ClipboardRegistry: clear cache error', e);
                    }
                });
        } catch (e) {
            console.error('ClipboardRegistry: clear cache error', e);
        }
    }

    _deleteNextBatch(folder, enumerator) {
        enumerator.next_files_async(10, GLib.PRIORITY_LOW, null,
            (_enum, res) => {
                try {
                    const infos = _enum.next_files_finish(res);
                    if (!infos || infos.length === 0)
                        return;
                    for (const info of infos) {
                        const child = folder.get_child(info.get_name());
                        child.delete_async(
                            GLib.PRIORITY_LOW, null, (f, r) => {
                                try { f.delete_finish(r); } catch (_e) { /* best-effort */ }
                            });
                    }
                    // Continue with next batch
                    this._deleteNextBatch(folder, enumerator);
                } catch (e) {
                    console.error('ClipboardRegistry: clear cache batch error', e);
                }
            });
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #glibBytes = null;
    #cachedString = null;
    #cachedHash = null;

    static __isText(mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON(json, registryDir = null) {
        if (!json.contents)
            return null;
        const mimetype = json.mimetype || 'text/plain;charset=utf-8';
        let bytes;

        if (ClipboardEntry.__isText(mimetype)) {
            bytes = new TextEncoder().encode(json.contents);
        } else {
            const filename = json.contents;
            // Validate that cached image path is within the expected
            // cache directory to prevent loading arbitrary files from
            // a tampered registry.
            if (registryDir) {
                if (!filename.startsWith('/'))
                    return null;
                const resolved = GLib.canonicalize_filename(filename, null);
                const resolvedDir = GLib.canonicalize_filename(registryDir, null);
                if (!resolved.startsWith(resolvedDir + '/'))
                    return null;
            }
            if (!GLib.file_test(filename, GLib.FileTest.EXISTS))
                return null;

            const file = Gio.file_new_for_path(filename);
            bytes = await new Promise((resolve, reject) => {
                file.load_contents_async(null, (obj, res) => {
                    try {
                        let [success, data] = obj.load_contents_finish(res);
                        success
                            ? resolve(data)
                            : reject(new Error('Failed to read cached image'));
                    } catch (e) { reject(e); }
                });
            });
        }

        return new ClipboardEntry(mimetype, bytes);
    }

    constructor(mimetype, bytes) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
    }

    getStringValue() {
        if (this.#cachedString !== null)
            return this.#cachedString;
        this.#cachedString = this.isImage()
            ? `[Image ${this.getHash()}]`
            : new TextDecoder().decode(this.#bytes);
        return this.#cachedString;
    }

    mimetype()  { return this.#mimetype; }
    isText()    { return ClipboardEntry.__isText(this.#mimetype); }
    isImage()   { return this.#mimetype.startsWith('image/'); }
    asBytes()   { return this.#glibBytes ??= new GLib.Bytes(this.#bytes); }
    rawBytes()  { return this.#bytes; }

    /** Cached hash — avoids re-computing O(n) hash on every equals() call. */
    getHash()   { return this.#cachedHash ??= this.asBytes().hash(); }

    equals(other) {
        if (this.isImage() !== other.isImage())
            return false;
        if (this.isImage() && other.isImage()) {
            return this.getHash() === other.getHash() &&
                   this.asBytes().get_size() === other.asBytes().get_size();
        }
        return this.getStringValue() === other.getStringValue();
    }
}
