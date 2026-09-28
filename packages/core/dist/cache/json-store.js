import fs from 'node:fs';
import path from 'node:path';
export class JsonStore {
    filePath;
    data;
    constructor(filePath) {
        this.filePath = filePath;
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.data = { meta: {}, events: [] };
        this.load();
    }
    load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    this.data = {
                        meta: parsed.meta || {},
                        events: Array.isArray(parsed.events) ? parsed.events : []
                    };
                }
            }
            catch {
                this.data = { meta: {}, events: [] };
            }
        }
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }
    getMeta(key) {
        return this.data.meta[key] !== undefined ? this.data.meta[key] : null;
    }
    setMeta(key, value) {
        this.data.meta[key] = String(value);
        this.save();
    }
    insertEvents(events) {
        if (!events || events.length === 0) {
            return;
        }
        this.data.events.push(...events);
        this.save();
    }
    queryEvents(filter = {}) {
        let list = this.data.events;
        if (filter.package) {
            list = list.filter((e) => e.package === filter.package);
        }
        if (filter.type) {
            list = list.filter((e) => e.type === filter.type);
        }
        if (filter.since) {
            list = list.filter((e) => e.date >= filter.since);
        }
        if (filter.manifest) {
            list = list.filter((e) => e.manifest === filter.manifest);
        }
        if (filter.workspace) {
            list = list.filter((e) => e.manifest.includes(filter.workspace));
        }
        if (filter.directOnly) {
            list = list.filter((e) => e.isDirect !== false);
        }
        return list;
    }
    clear() {
        this.data = { meta: {}, events: [] };
        this.save();
    }
    close() {
        // No-op for JSON store
    }
}
//# sourceMappingURL=json-store.js.map